// Configured-project catalog client: transport errors vs. valid (possibly
// empty) catalogs, the bounded headless fallback, and the option projections
// consumed by the picker/CLI.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	fetchProjectCatalog,
	loadProjectCatalog,
	ProjectCatalogError,
	projectCanonicalRoots,
	projectIdentForPath,
	projectOptions,
	spawnBoundedCatalog,
	syncCatalogWatchers,
} from "../src/workflow/project-catalog.ts";

const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
});

function serve(json: unknown, status = 200) {
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(JSON.stringify(json), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

const catalog = {
	revision: "rev-1",
	projects: [
		{
			ident: "checkout-app",
			displayName: "Checkout App",
			kind: "app" as const,
			canonicalRoot: "/repos/checkout-app",
			activeCheckout: "/repos/checkout-app.feature",
			available: true,
			availability: "available" as const,
			capabilities: { openspec: true },
		},
		{
			ident: "uncloned-lib",
			displayName: "Uncloned Lib",
			kind: "library" as const,
			activeCheckout: "/managed/uncloned-lib",
			available: false,
			availability: "missing" as const,
			detail: "checkout is not cloned",
			capabilities: { openspec: false },
		},
	],
};

test("fetchProjectCatalog returns the canonical catalog", async () => {
	const baseUrl = serve(catalog);
	expect(await fetchProjectCatalog({ baseUrl })).toEqual(catalog);
});

test("empty catalog is a valid state, not a failure", async () => {
	const baseUrl = serve({ revision: "empty", projects: [] });
	const result = await fetchProjectCatalog({ baseUrl });
	expect(result.projects).toEqual([]);
	expect(result.revision).toBe("empty");
});

test("transport failure is a retryable catalog error", async () => {
	let error: unknown;
	try {
		await fetchProjectCatalog({ baseUrl: "http://127.0.0.1:1" });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ProjectCatalogError);
	expect((error as ProjectCatalogError).retryable).toBe(true);
});

test("rejected configuration is not retryable", async () => {
	const baseUrl = serve({ message: "duplicate configured project ident" }, 409);
	let error: unknown;
	try {
		await fetchProjectCatalog({ baseUrl });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ProjectCatalogError);
	expect((error as ProjectCatalogError).retryable).toBe(false);
	expect((error as ProjectCatalogError).status).toBe(409);
});

/** Isolated environment roots so the bounded invocation reads an empty
 * configuration instead of the developer's own. */
function isolateEnvironment(): () => void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-bounded-"));
	const home = process.env.DEVENV_HOME;
	const configDir = process.env.DEVENV_CONFIG_DIR;
	fs.mkdirSync(path.join(dir, "home"), { recursive: true });
	fs.mkdirSync(path.join(dir, "config"), { recursive: true });
	process.env.DEVENV_HOME = path.join(dir, "home");
	process.env.DEVENV_CONFIG_DIR = path.join(dir, "config");
	return () => {
		if (home === undefined) delete process.env.DEVENV_HOME;
		else process.env.DEVENV_HOME = home;
		if (configDir === undefined) delete process.env.DEVENV_CONFIG_DIR;
		else process.env.DEVENV_CONFIG_DIR = configDir;
		fs.rmSync(dir, { recursive: true, force: true });
	};
}

test("headless load falls back to a bounded read-only catalog invocation", async () => {
	const restore = isolateEnvironment();
	try {
		// No server answers on this port, so the read runs the bounded
		// `__catalog` invocation of this same executable: the canonical
		// projection over an empty configuration, not a rescan.
		const result = await loadProjectCatalog({ baseUrl: "http://127.0.0.1:1" });
		expect(result.projects).toEqual([]);
		expect(result.revision).toMatch(/^[0-9a-f]{16}$/);
	} finally {
		restore();
	}
}, 30_000);

test("a failing bounded invocation is not retryable, a timeout is", async () => {
	let failure: unknown;
	try {
		await spawnBoundedCatalog({ command: ["/bin/sh", "-c", "exit 3"] }, 5000);
	} catch (caught) {
		failure = caught;
	}
	expect(failure).toBeInstanceOf(ProjectCatalogError);
	expect((failure as ProjectCatalogError).retryable).toBe(false);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-timeout-"));
	const script = path.join(dir, "slow-catalog.sh");
	fs.writeFileSync(script, "#!/bin/sh\nsleep 5\n");
	fs.chmodSync(script, 0o755);
	let timeout: unknown;
	try {
		await spawnBoundedCatalog({ command: [script] }, 200);
	} catch (caught) {
		timeout = caught;
	}
	expect(timeout).toBeInstanceOf(ProjectCatalogError);
	// A bounded invocation that ran out of time may succeed on a retry; one that
	// failed on its own must not be retried into a loop.
	expect((timeout as ProjectCatalogError).retryable).toBe(true);
}, 30_000);

test("loadProjectCatalog uses a reachable server without spawning the fallback", async () => {
	const restore = isolateEnvironment();
	try {
		const baseUrl = serve(catalog);
		const result = await loadProjectCatalog({ baseUrl });
		// The running server's catalog wins: the local (empty) configuration is
		// never projected, which is what the bounded fallback would have returned.
		expect(result).toEqual(catalog);
	} finally {
		restore();
	}
}, 30_000);

test("loadProjectCatalog surfaces a non-retryable configuration error without spawning", async () => {
	const baseUrl = serve({ message: "duplicate configured project ident" }, 409);

	let error: unknown;
	try {
		await loadProjectCatalog({ baseUrl });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ProjectCatalogError);
	// A rejected configuration is a configuration error, not a transport failure
	// that a bounded invocation could answer differently.
	expect((error as ProjectCatalogError).retryable).toBe(false);
});

test("project options preserve legacy keys and expose availability", () => {
	const options = projectOptions(catalog as never);
	expect(options[0]).toMatchObject({
		name: "Checkout App",
		path: "/repos/checkout-app.feature",
		openspec: true,
		ident: "checkout-app",
		available: true,
	});
	expect(options[1]).toMatchObject({
		path: "/managed/uncloned-lib",
		available: false,
		availability: "missing",
	});

	expect(projectCanonicalRoots(catalog as never)).toEqual([
		"/repos/checkout-app",
	]);
});
test("cross-link resolves a stable ident without retargeting checkouts", () => {
	expect(projectIdentForPath(catalog as never, "/repos/checkout-app")).toBe(
		"checkout-app",
	);
	expect(
		projectIdentForPath(catalog as never, "/repos/checkout-app.feature"),
	).toBe("checkout-app");
	expect(projectIdentForPath(catalog as never, "/elsewhere")).toBeUndefined();
});

test("catalog watcher diff stops removed roots and keeps unchanged ones", () => {
	const watched = new Map<string, () => void>();
	const started: string[] = [];
	const stopped: string[] = [];
	const watch = (root: string) => {
		started.push(root);
		return () => stopped.push(root);
	};

	syncCatalogWatchers(watched, ["a", "b"], watch);
	syncCatalogWatchers(watched, ["b", "c"], watch);

	expect(started).toEqual(["a", "b", "c"]);
	expect(stopped).toEqual(["a"]);
	expect([...watched.keys()].sort()).toEqual(["b", "c"]);

	for (const stop of watched.values()) stop();
});

test("a read during owned-backend startup waits for readiness instead of spawning", async () => {
	const restore = isolateEnvironment();
	// A server that is not ready yet, then answers: this is the window between
	// the shell's first paint and its backend becoming ready.
	let calls = 0;
	const baseUrl = "http://127.0.0.1:4988";
	const server = Bun.serve({
		port: 4988,
		fetch: () => {
			calls += 1;
			if (calls < 3) return new Response("starting", { status: 503 });
			return new Response(JSON.stringify(catalog), {
				headers: { "content-type": "application/json" },
			});
		},
	});
	process.env.AGENTIC_DEVENV_STARTING = "1";
	try {
		const result = await loadProjectCatalog({ baseUrl });
		// The owned server's answer wins; the local (empty) configuration that a
		// bounded fallback would have projected is never used.
		expect(result).toEqual(catalog);
	} finally {
		delete process.env.AGENTIC_DEVENV_STARTING;
		server.stop(true);
		restore();
	}
}, 30_000);

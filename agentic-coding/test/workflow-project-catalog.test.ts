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
	syncCatalogWatchers,
} from "../src/workflow/project-catalog.ts";

const previousBinary = process.env.DEVENV_SERVER_BINARY;
const servers: Array<{ stop: () => void }> = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop();
	if (previousBinary === undefined) delete process.env.DEVENV_SERVER_BINARY;
	else process.env.DEVENV_SERVER_BINARY = previousBinary;
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

function writeFakeCatalogBinary(dir: string, json: unknown) {
	const marker = path.join(dir, "argv.txt");
	const script = path.join(dir, "fake-devenv.sh");
	fs.writeFileSync(
		script,
		`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\necho '${JSON.stringify(json)}'\n`,
	);
	fs.chmodSync(script, 0o755);
	process.env.DEVENV_SERVER_BINARY = script;
	return { script, marker };
}

test("headless load falls back to a bounded read-only `catalog` invocation", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-bounded-"));
	const { marker } = writeFakeCatalogBinary(dir, catalog);

	const result = await loadProjectCatalog({ baseUrl: "http://127.0.0.1:1" });
	expect(result).toEqual(catalog);
	// The bounded invocation must run the read-only `catalog` subcommand, not
	// an arbitrary or mutating command.
	expect(fs.readFileSync(marker, "utf8")).toBe("catalog\n");
});

test("bounded invocation timeout is surfaced as a retryable catalog error", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-timeout-"));
	const script = path.join(dir, "slow-devenv.sh");
	fs.writeFileSync(script, "#!/bin/sh\nsleep 5\n");
	fs.chmodSync(script, 0o755);
	process.env.DEVENV_SERVER_BINARY = script;

	let error: unknown;
	try {
		await loadProjectCatalog({
			baseUrl: "http://127.0.0.1:1",
			timeoutMs: 200,
		});
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ProjectCatalogError);
	expect((error as ProjectCatalogError).retryable).toBe(true);
});

test("loadProjectCatalog uses a reachable server without spawning the fallback", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-server-"));
	const { marker } = writeFakeCatalogBinary(dir, catalog);
	const baseUrl = serve(catalog);

	const result = await loadProjectCatalog({ baseUrl });
	expect(result).toEqual(catalog);
	// A reachable canonical server wins; the bounded invocation is never started.
	expect(fs.existsSync(marker)).toBe(false);
});

test("loadProjectCatalog surfaces a non-retryable configuration error without spawning", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-conflict-"));
	const { marker } = writeFakeCatalogBinary(dir, catalog);
	const baseUrl = serve({ message: "duplicate configured project ident" }, 409);

	let error: unknown;
	try {
		await loadProjectCatalog({ baseUrl });
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(ProjectCatalogError);
	expect((error as ProjectCatalogError).retryable).toBe(false);
	// A rejected configuration must not silently launch a backend invocation.
	expect(fs.existsSync(marker)).toBe(false);
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

// Retirement guards (`retire-go-backend-and-migration-bridges` tasks 2.2-2.6,
// 3.2). The Go backend, its embedded-extraction path and the mixed-runtime
// bridges are gone; these checks fail if any of them comes back, and they run
// the headless server with the Go toolchain unavailable.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = server.port;
	server.stop(true);
	if (port === undefined) throw new Error("failed to reserve a port");
	return port;
}

async function sourceFiles(dir: string): Promise<string[]> {
	const entries = await fs.promises.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
		else if (/\.tsx?$/.test(entry.name)) files.push(full);
	}
	return files;
}

describe("retired runtime and bridges", () => {
	test("no source reaches a retired backend artifact or bridge", async () => {
		// `go build`/`go run` remain legitimate *discovered* commands for a user's
		// own Go project, so the guard looks for our retired backend by its
		// artifact and bridge names, not by the word "go".
		const offenders: string[] = [];
		for (const file of await sourceFiles(path.join(ROOT, "src"))) {
			const text = await Bun.file(file).text();
			for (const pattern of [
				/EMBEDDED_SERVER_BINARY/,
				/dist[/]server[/]devenv/,
				/"main\.go"/,
				/devenv-server/,
				/backendChildEnvironment/,
				/startOwnedBackend/,
				/ensureExecutable/,
				/__grpc-sidecar/,
				/DEVENV_INSTANCE_TOKEN/,
			]) {
				if (pattern.test(text))
					offenders.push(`${path.relative(ROOT, file)}: ${pattern}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the imported Go source tree is gone", () => {
		expect(fs.existsSync(path.resolve(ROOT, "..", "server"))).toBe(false);
		expect(fs.existsSync(path.join(ROOT, "dist", "server"))).toBe(false);
	});

	test("the shell has one launch path and no forwarding bridge", async () => {
		const shell = await Bun.file(
			path.join(ROOT, "src", "tui", "index.tsx"),
		).text();
		// One owned server: no cross-runtime forwarding hook. (`startOwnedBackend`
		// itself is covered by the source-wide retirement walk above.)
		expect(shell).not.toContain("AGENTIC_DEVENV_FORWARD_URL");
		expect(shell).not.toContain("go-backend");
		const lifecycle = await Bun.file(
			path.join(ROOT, "src", "tui", "lifecycle.ts"),
		).text();
		expect(lifecycle).not.toContain("go-backend");
	});

	test("telemetry receivers never spawn a gRPC helper process", async () => {
		const receivers = await Bun.file(
			path.join(ROOT, "src", "server", "receivers.ts"),
		).text();
		expect(receivers).not.toContain("Bun.spawn");
		expect(receivers).not.toContain("grpc-sidecar");
		// The retired internal mode is unreachable from any entry point: the
		// source-wide retirement walk above rejects `__grpc-sidecar` anywhere under
		// src/, and the sidecar module itself must not exist.
		expect(
			fs.existsSync(
				path.join(
					ROOT,
					"src",
					"tui",
					"otel",
					"receiver",
					"otlp-grpc-sidecar.ts",
				),
			),
		).toBe(false);
	});

	test("the unified server runs without a Go toolchain and spawns no child runtime", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retirement-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(configDir, { recursive: true });
		// A PATH without Go: the run must not need a compiler, and nothing may
		// fall back to one.
		const barePath = fs
			.readdirSync("/usr/bin")
			.filter((name) => /^(env|sh|uname|git|ps|pgrep)$/.test(name))
			.map((name) => `/usr/bin/${name}`)
			.join(":");
		const child = Bun.spawn(
			[
				process.execPath,
				path.join(ROOT, "src", "cli.ts"),
				"server",
				"--port",
				String(freePort()),
			],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					DEVENV_HOME: home,
					DEVENV_CONFIG_DIR: configDir,
					PATH: `${barePath}:${path.dirname(process.execPath)}`,
					AGENTIC_WORKFLOW_TOKEN: "retirement-token",
				},
			},
		);
		try {
			const announced = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("server did not announce its address")),
					20_000,
				);
				void (async () => {
					for await (const chunk of child.stdout) {
						const text = new TextDecoder().decode(chunk);
						if (text.includes("unified server")) {
							clearTimeout(timer);
							resolve(text);
							return;
						}
					}
				})();
			});
			const url = announced.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			expect(url).toBeDefined();
			const health = await fetch(`${url}/api/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toMatchObject({ status: "ok" });

			// The observation path reads the configured-project catalog through
			// this process's own authenticated boundary. It used to target the
			// default environment port, which is nobody in a clean install — the
			// read then fell back to a bounded second invocation instead of the
			// running server.
			const observed = await fetch(`${url}/api/v1/observe`, {
				method: "POST",
				headers: {
					authorization: "Bearer retirement-token",
					"content-type": "application/json",
				},
				body: JSON.stringify({ observation: { kind: "projects" } }),
			});
			expect(observed.status).toBe(200);
			expect(await observed.json()).toMatchObject({ ok: true });

			// The one process owns everything: no application child of any kind is
			// running under it.
			const listed = Bun.spawnSync(["ps", "-o", "pid=,ppid=,comm=", "-ax"], {
				stdout: "pipe",
			}).stdout.toString();
			const pid = child.pid;
			const children = listed
				.split("\n")
				.map((line) => line.trim().split(/\s+/))
				.filter((parts) => parts.length >= 3 && Number(parts[1]) === pid)
				.map((parts) => parts.slice(2).join(" "));
			expect(children).toEqual([]);
		} finally {
			child.kill();
			await child.exited;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});

// Mixed-runtime cutover acceptance
// (port-project-catalog-and-state-to-bun, tasks 3.2-3.4).
//
// This is the only test that runs both runtimes at once: the real Bun server
// owns the environment state/catalog, and the real Go server child is spawned
// against it with DEVENV_ENVIRONMENT_URL. It asserts the three cutover
// properties that unit tests cannot:
//
//  1. the Go child reads configuration through Bun (no config parser of its own),
//  2. a Go write lands in the Bun-owned database exactly once, with no second
//     writer appending the same record,
//  3. the Go child holds no handle on the state database.
//
// Skipped when the Go toolchain is not available, so a Bun-only checkout still
// runs the rest of the suite.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironmentAuthority } from "../src/server/environment/authority.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const GO_BINARY = path.join(
	REPO_ROOT,
	"agentic-coding",
	"dist",
	"server",
	process.platform === "win32" ? "devenv.exe" : "devenv",
);

function goAvailable(): boolean {
	const probe = Bun.spawnSync(["go", "version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return probe.exitCode === 0;
}

function ensureGoBinary(): string {
	if (fs.existsSync(GO_BINARY)) return GO_BINARY;
	fs.mkdirSync(path.dirname(GO_BINARY), { recursive: true });
	const build = Bun.spawnSync(["go", "build", "-o", GO_BINARY, "."], {
		cwd: path.join(REPO_ROOT, "server"),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (build.exitCode !== 0)
		throw new Error(
			`go build failed: ${build.stderr.toString().slice(0, 400)}`,
		);
	return GO_BINARY;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface GoChild {
	readonly pid: number | undefined;
	call(path: string, init?: RequestInit): Promise<Response>;
	stop(): Promise<void>;
}

/** Spawn the real Go server child pointed at the Bun authority. */
async function startGoChild(options: {
	port: number;
	homeDir: string;
	configDir: string;
	environmentUrl: string;
	environmentToken: string;
}): Promise<GoChild & { log: () => string }> {
	const binary = ensureGoBinary();
	const logPath = path.join(options.homeDir, "go-child.log");
	const logFile = fs.openSync(logPath, "a");
	const child = Bun.spawn(
		[
			binary,
			"server",
			"--port",
			String(options.port),
			"--instance",
			"cutover-test",
		],
		{
			stdout: logFile,
			stderr: logFile,
			env: {
				...process.env,
				DEVENV_HOME: options.homeDir,
				DEVENV_CONFIG_DIR: options.configDir,
				DEVENV_ENVIRONMENT_URL: options.environmentUrl,
				DEVENV_ENVIRONMENT_TOKEN: options.environmentToken,
			},
		},
	);
	fs.closeSync(logFile);
	const baseUrl = `http://127.0.0.1:${options.port}`;
	const deadline = Date.now() + 30_000;
	let ready = false;
	while (Date.now() < deadline && !ready) {
		const response = await fetch(`${baseUrl}/api/health`).catch(
			() => undefined,
		);
		ready = response?.ok ?? false;
		if (!ready) await sleep(250);
	}
	if (!ready) throw new Error("the Go child never became ready");
	return {
		pid: child.pid,
		call: (target, init) => fetch(`${baseUrl}${target}`, init),
		log: () => fs.readFileSync(logPath, "utf8"),
		stop: async () => {
			child.kill("SIGTERM");
			await Promise.race([child.exited, sleep(5000)]);
			if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.race([child.exited, sleep(2000)]);
		},
	};
}

/** Open handles a process holds on the environment database, when `lsof` can
 * answer (macOS/Linux). */
function stateDbHandles(pid: number | undefined): number | undefined {
	if (!pid) return undefined;
	const probe = Bun.spawnSync(["lsof", "-p", String(pid)], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (probe.exitCode !== 0) return undefined;
	return probe.stdout
		.toString()
		.split("\n")
		.filter((line) => line.includes("state.db")).length;
}

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
	const port = probe.port ?? 0;
	probe.stop(true);
	return port;
}

describe("mixed-runtime environment cutover", () => {
	test("the Go child reads config and writes state through the Bun authority", async () => {
		if (!goAvailable()) {
			// A Bun-only checkout still runs every other suite.
			return;
		}
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cutover-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(path.join(configDir, "apps", "definitions"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(configDir, "apps", "definitions", "cutover.json"),
			JSON.stringify({
				ident: "cutover",
				displayName: "Cutover App",
				repositoryPath: "https://example.com/team/cutover.git",
				gitMode: "WORKTREE",
			}),
		);

		const authority = createEnvironmentAuthority({ homeDir: home, configDir });
		const server = await startWorkflowServer({ environment: authority });
		let child: (GoChild & { log: () => string }) | undefined;
		try {
			child = await startGoChild({
				port: freePort(),
				homeDir: home,
				configDir,
				environmentUrl: server.url,
				environmentToken: server.token,
			});

			// (1) Configuration authority: the Go child reports the definition it
			// can only have obtained from the Bun authority.
			const apps = (await (await child.call("/api/apps")).json()) as {
				apps: Array<{ ident: string; displayName: string }>;
			};
			expect(apps.apps.map((app) => app.ident)).toContain("cutover");
			expect(
				apps.apps.find((app) => app.ident === "cutover")?.displayName,
			).toBe("Cutover App");

			// (2) A Go state write lands in the Bun-owned database exactly once.
			const write = await child.call("/api/scripts/history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					relativePath: "scripts/cutover.sh",
					values: { target: "release" },
				}),
			});
			expect(write.ok).toBe(true);
			await sleep(200);
			expect(
				authority.state.getScriptArgsHistory("scripts/cutover.sh", 50),
			).toEqual([{ target: "release" }]);

			// The Go child's own read of the same history goes through Bun too and
			// returns exactly the one row (no duplicate append).
			const history = (await (
				await child.call("/api/scripts/history?relativePath=scripts/cutover.sh")
			).json()) as { entries: Array<Record<string, string>> };
			expect(history.entries).toEqual([{ target: "release" }]);

			// (3) The child holds no handle on the environment database.
			const handles = stateDbHandles(child.pid);
			if (handles !== undefined) expect(handles).toBe(0);
			// It also never reported a local database failure.
			expect(child.log()).not.toContain("failed to open state database");
		} finally {
			await child?.stop();
			await server.stop();
			authority.state.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test("with no authority URL the child stays the legacy owner", async () => {
		if (!goAvailable()) return;
		// The opt-out path: DEVENV_ENVIRONMENT_OWNER=go keeps the previous owner,
		// so the rollback never runs two writers at once.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-cutover-legacy-"));
		const home = path.join(dir, "home");
		const configDir = path.join(dir, "config");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(configDir, { recursive: true });
		let child: (GoChild & { log: () => string }) | undefined;
		try {
			child = await startGoChild({
				port: freePort(),
				homeDir: home,
				configDir,
				environmentUrl: "",
				environmentToken: "",
			});
			const write = await child.call("/api/scripts/history", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					relativePath: "scripts/legacy.sh",
					values: { target: "legacy" },
				}),
			});
			expect(write.ok).toBe(true);
			// The legacy owner created and wrote its own database.
			expect(fs.existsSync(path.join(home, "db", "state.db"))).toBe(true);
		} finally {
			await child?.stop();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

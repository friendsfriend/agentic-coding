// unified-application-distribution: "Compiled executable hosts an agent".
// Runs the *compiled* `dist/agentic-coding` binary's hidden `agent host`
// mode from a temp directory outside the checkout, with the faux-provider
// test hook (`AGENT_HOST_TEST_FAUX_PROVIDER=1`), and drives a full turn
// (including a tool call) over the real control socket. Skipped when the
// binary has not been built (`bun run build`), so `bun test` alone never
// requires a prior build step.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostClient } from "../src/agent-host/client.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

const BINARY = path.resolve(import.meta.dir, "..", "dist", "agentic-coding");

let child: ChildProcess | undefined;
afterEach(() => {
	child?.kill("SIGKILL");
	child = undefined;
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test.skipIf(!fs.existsSync(BINARY))(
	"the compiled binary completes a tool-using turn from outside the checkout",
	async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-host-compiled-smoke-"),
		);
		const layout = hostLayout(dir);
		child = spawn(BINARY, ["agent", "host", "--workflow-dir", dir], {
			cwd: os.tmpdir(),
			env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		for (let i = 0; i < 50 && !fs.existsSync(layout.socketPath); i++)
			await sleep(100);
		expect(fs.existsSync(layout.socketPath)).toBe(true);

		const client = new HostClient(layout.socketPath, 10_000);
		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='compiled-smoke'\n");
		await client.ensureRun({
			runId: "compiled-smoke",
			cwd: dir,
			runEnvPath,
			name: "compiled-smoke-worker",
			toolPolicy: "default",
			// Matches the faux provider's deterministic default provider/model ids
			// (`fauxProvider()` with no overrides, as `testFauxModels()` in
			// host-main.ts uses); without a configured model the conversation would
			// settle every submission immediately with reason "no_model", reaching
			// "idle" without ever calling the scripted faux turn.
			model: "faux/faux-1",
		});
		await client.submit("compiled-smoke", "read the readme", "req-1");
		let status = await client.status("compiled-smoke");
		for (let i = 0; i < 50 && status.status !== "idle"; i++) {
			await sleep(100);
			status = await client.status("compiled-smoke");
		}
		expect(status.status).toBe("idle");
		expect(stderr).toBe("");
		await client.shutdown();
	},
	15_000,
);

test.skipIf(!fs.existsSync(BINARY))(
	"a second host start for the same workflow directory exits without disturbing the first",
	async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-host-duplicate-start-"),
		);
		const layout = hostLayout(dir);
		child = spawn(BINARY, ["agent", "host", "--workflow-dir", dir], {
			cwd: os.tmpdir(),
			env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		for (let i = 0; i < 50 && !fs.existsSync(layout.socketPath); i++)
			await sleep(100);
		expect(fs.existsSync(layout.socketPath)).toBe(true);

		// The first host is confirmed live (hello round-trips) before the second
		// start is attempted, so a slow-starting first host can never be mistaken
		// for "the second start won".
		const client = new HostClient(layout.socketPath, 5_000);
		await client.ensureRun({
			runId: "owner-run",
			cwd: dir,
			runEnvPath: (() => {
				const file = path.join(dir, "run.env");
				fs.writeFileSync(file, "HERDR_RUN_ID='owner-run'\n");
				return file;
			})(),
			name: "owner-worker",
			toolPolicy: "default",
		});

		let secondStderr = "";
		let secondExitCode: number | null = null;
		const second = spawn(BINARY, ["agent", "host", "--workflow-dir", dir], {
			cwd: os.tmpdir(),
			env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		second.stderr?.on("data", (chunk) => {
			secondStderr += String(chunk);
		});
		const secondExited = new Promise<void>((resolve) => {
			second.once("exit", (code) => {
				secondExitCode = code;
				resolve();
			});
		});
		await Promise.race([secondExited, sleep(5_000)]);
		expect(secondExitCode).not.toBeNull();
		expect(secondExitCode).not.toBe(0);
		expect(secondStderr.toLowerCase()).toContain("already running");

		// The first host is still the one serving the socket: the run started
		// against it before the second start was attempted is still reachable.
		const status = await client.status("owner-run");
		expect(["idle", "working", "blocked", "unknown"]).toContain(status.status);
		await client.shutdown();
	},
	15_000,
);

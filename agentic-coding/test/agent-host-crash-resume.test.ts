// durable-agent-host: "Crash resume" (3.7's hardest named scenario). Two
// real compiled-binary host processes over the same `--workflow-dir` (SQLite
// storage persists across processes, unlike `MemoryStorage`): the first is
// killed with SIGKILL while a non-replayable `bash` tool call is still
// running, and the second is started over the same storage. The concrete,
// verifiable claim this pins: the tool's side effect happens at most once —
// resuming does not re-run it a second time — and the run still reaches a
// terminal status rather than hanging forever.
import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostClient } from "../src/agent-host/client.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

const BINARY = path.resolve(import.meta.dir, "..", "dist", "agentic-coding");

let children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children) child.kill("SIGKILL");
	children = [];
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnHost(
	dir: string,
	extraEnv: Record<string, string> = {},
): ChildProcess {
	const child = spawn(BINARY, ["agent", "host", "--workflow-dir", dir], {
		cwd: os.tmpdir(),
		env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1", ...extraEnv },
		stdio: ["ignore", "ignore", "ignore"],
	});
	children.push(child);
	return child;
}

test.skipIf(!fs.existsSync(BINARY))(
	"a non-replayable tool call survives a killed host without running twice",
	async () => {
		const dir = fs.mkdtempSync(
			path.join(os.tmpdir(), "agent-host-crash-resume-"),
		);
		const layout = hostLayout(dir);
		const marker = path.join(dir, "ran.marker");
		const toolCall = JSON.stringify({
			name: "bash",
			args: { command: `sleep 2 && echo ran >> ${marker}` },
		});

		const first = spawnHost(dir, { AGENT_HOST_TEST_FAUX_TOOL: toolCall });
		for (let i = 0; i < 50 && !fs.existsSync(layout.socketPath); i++)
			await sleep(100);
		expect(fs.existsSync(layout.socketPath)).toBe(true);

		const runEnvPath = path.join(dir, "run.env");
		fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='crash-resume'\n");
		const client = new HostClient(layout.socketPath, 10_000);
		await client.ensureRun({
			runId: "crash-resume",
			cwd: dir,
			runEnvPath,
			name: "crash-resume-worker",
			toolPolicy: "default",
			model: "faux/faux-1",
		});
		await client.submit("crash-resume", "run the slow command", "req-1");

		// Give the tool task time to commit its intent and actually start the
		// sleep (well before its 2s completion), then kill the host abruptly —
		// not `stopRun`/`shutdown`, which abort cleanly and are not the crash
		// this scenario is about.
		await sleep(500);
		first.kill("SIGKILL");
		await sleep(200);
		fs.rmSync(layout.socketPath, { force: true });

		spawnHost(dir, { AGENT_HOST_TEST_FAUX_TOOL: toolCall });
		for (let i = 0; i < 50 && !fs.existsSync(layout.socketPath); i++)
			await sleep(100);
		expect(fs.existsSync(layout.socketPath)).toBe(true);
		const secondClient = new HostClient(layout.socketPath, 10_000);
		// The resumed run is reachable by the same run id over the new host
		// without a second `ensureRun` (the conversation already exists in
		// storage); `ensureRun` is still safe to call again (same conversation,
		// not a new one) and is how the real engine adapter would reconnect.
		await secondClient.ensureRun({
			runId: "crash-resume",
			cwd: dir,
			runEnvPath,
			name: "crash-resume-worker",
			toolPolicy: "default",
			model: "faux/faux-1",
		});
		let status = await secondClient.status("crash-resume");
		for (let i = 0; i < 100 && status.status !== "idle"; i++) {
			await sleep(100);
			status = await secondClient.status("crash-resume");
		}
		expect(status.status).toBe("idle");

		// The concrete, verifiable claim: the tool's side effect happened at
		// most once. A second full execution (full sleep + append) would show up
		// as a second marker line; it must not.
		await sleep(2_200);
		const markerLines = fs.existsSync(marker)
			? fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean)
			: [];
		expect(markerLines.length).toBeLessThanOrEqual(1);
		await secondClient.shutdown();
	},
	30_000,
);

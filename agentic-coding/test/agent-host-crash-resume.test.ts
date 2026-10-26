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
import {
	hostRetryCapabilityForLaunch,
	registerHostRetryTarget,
	releaseHostRetryCapability,
	unregisterHostRetryTarget,
} from "../src/agent-host/retry-authority.ts";
import { createServerApp } from "../src/server/app.ts";
import { createInstanceAuthority } from "../src/server/auth.ts";
import { BackendClient } from "../src/server/client.ts";
import { CredentialRegistry } from "../src/server/credentials.ts";
import { EventBroker } from "../src/server/events.ts";

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
	recoveryCapability?: string,
): ChildProcess {
	const args = ["agent", "host", "--workflow-dir", dir];
	const stdio: Array<"ignore" | "pipe"> = ["ignore", "ignore", "ignore"];
	if (recoveryCapability) {
		args.push("--retry-capability-fd", "3");
		stdio.push("pipe");
	}
	const child = spawn(BINARY, args, {
		cwd: os.tmpdir(),
		env: { ...process.env, AGENT_HOST_TEST_FAUX_PROVIDER: "1", ...extraEnv },
		stdio,
	});
	const capabilityPipe = child.stdio[3];
	if (recoveryCapability && capabilityPipe && "end" in capabilityPipe) {
		capabilityPipe.on("error", () => {});
		capabilityPipe.end(recoveryCapability);
	}
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

test("native restart_limit parks a task after repeated real host crashes and remains visible after reopen", async () => {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-native-restart-limit-")),
	);
	const dir = path.join(root, "workflow");
	for (const name of ["home", "config", "pi", "wiki"])
		fs.mkdirSync(path.join(root, name), { recursive: true });
	fs.mkdirSync(dir, { recursive: true });
	const layout = hostLayout(dir);
	const runEnvPath = path.join(dir, "run.env");
	fs.writeFileSync(runEnvPath, "HERDR_RUN_ID='native-restart-limit'\n");
	const crashPath = path.join(dir, "native-crashes.log");
	const childScriptPath = path.resolve(
		import.meta.dir,
		"agent-host-native-restart-child.mjs",
	);
	const isolatedEnv = {
		...process.env,
		HOME: path.join(root, "home"),
		AGENTIC_CODING_CONFIG_DIR: path.join(root, "config"),
		PI_CODING_AGENT_DIR: path.join(root, "pi"),
		HERDR_WIKI_DIR: path.join(root, "wiki"),
		AGENT_HOST_TEST_WORKFLOW_DIR: dir,
		AGENT_HOST_TEST_CRASH_PATH: crashPath,
		AGENT_HOST_TEST_CRASH_ON_MODEL: "1",
	};
	const startCrashHost = (
		overrides: Record<string, string> = {},
		recoveryCapability?: string,
	): ChildProcess => {
		const args = [childScriptPath];
		const stdio: Array<"ignore" | "pipe"> = ["ignore", "ignore", "ignore"];
		if (recoveryCapability) {
			args.push("--retry-capability-fd", "3");
			stdio.push("pipe");
		}
		const child = spawn(process.execPath, args, {
			cwd: path.resolve(import.meta.dir, ".."),
			env: { ...isolatedEnv, ...overrides },
			stdio,
		});
		const capabilityPipe = child.stdio[3];
		if (recoveryCapability && capabilityPipe && "end" in capabilityPipe) {
			capabilityPipe.on("error", () => {});
			capabilityPipe.end(recoveryCapability);
		}
		children.push(child);
		return child;
	};
	const childExited = (child: ChildProcess) =>
		child.exitCode !== null || child.signalCode !== null;
	const waitForExit = async (
		child: ChildProcess,
		timeoutMs: number,
	): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (!childExited(child) && Date.now() < deadline) await sleep(25);
		return childExited(child);
	};
	const waitForSocketOrExit = async (
		child: ChildProcess,
	): Promise<"socket" | "exit"> => {
		const deadline = Date.now() + 10_000;
		while (!childExited(child) && Date.now() < deadline) {
			if (fs.existsSync(layout.socketPath)) return "socket";
			await sleep(25);
		}
		if (childExited(child)) return "exit";
		throw new Error("native crash-loop host did not open its socket");
	};
	let parkedStatus: Awaited<ReturnType<HostClient["status"]>> | undefined;
	let parkedChild: ChildProcess | undefined;
	for (let generation = 0; generation <= 5; generation++) {
		const child = startCrashHost();
		const ready = await waitForSocketOrExit(child);
		if (ready === "socket") {
			if (!(await waitForExit(child, 2_000))) {
				const client = new HostClient(layout.socketPath, 10_000);
				parkedStatus = await client.status("native-restart-limit");
				parkedChild = child;
				break;
			}
		}
		expect(child.signalCode).toBe("SIGKILL");
		fs.rmSync(layout.socketPath, { force: true });
	}
	expect(parkedChild).toBeDefined();
	expect(parkedStatus).toMatchObject({
		runtimeFailure: {
			kind: "task_parked",
			domain: "task",
			reason: "restart_limit",
		},
	});
	expect(parkedStatus?.runtimeFailure?.taskId).toMatch(/^\d+$/);
	expect(parkedStatus?.status).not.toBe("blocked");

	const recoveryPath = path.join(dir, "native-recovery");
	const inspectRequestPath = path.join(dir, "inspect-task.request");
	const inspectResponsePath = path.join(dir, "inspect-task.response");
	for (const previousHost of children) {
		if (childExited(previousHost)) continue;
		previousHost.kill("SIGKILL");
		await waitForExit(previousHost, 2_000);
	}
	fs.rmSync(layout.socketPath, { force: true });
	const recoveryCapability = hostRetryCapabilityForLaunch(layout.socketPath);
	const recoveryHost = startCrashHost(
		{
			AGENT_HOST_TEST_CRASH_ON_MODEL: "0",
			AGENT_HOST_TEST_RECOVERY_PATH: recoveryPath,
			AGENT_HOST_TEST_INSPECT_REQUEST_PATH: inspectRequestPath,
			AGENT_HOST_TEST_INSPECT_RESPONSE_PATH: inspectResponsePath,
		},
		recoveryCapability,
	);
	expect(await waitForSocketOrExit(recoveryHost)).toBe("socket");
	const recoveryClient = new HostClient(layout.socketPath, 10_000);
	const recoveryRun = await recoveryClient.ensureRun({
		runId: "native-restart-limit",
		cwd: dir,
		runEnvPath,
		name: "native-restart-limit",
		toolPolicy: "default",
		model: "faux/faux-1",
	});
	const taskId = parkedStatus?.runtimeFailure?.taskId;
	const generation = parkedStatus?.runtimeFailure?.generation;
	if (!taskId || generation === undefined)
		throw new Error("native parked task has no current recovery identity");
	fs.writeFileSync(inspectRequestPath, taskId);
	for (
		let attempt = 0;
		attempt < 100 && !fs.existsSync(inspectResponsePath);
		attempt++
	)
		await sleep(10);
	if (!fs.existsSync(inspectResponsePath))
		throw new Error("native task inspection did not complete before retry");
	const parkedTaskState = JSON.parse(
		fs.readFileSync(inspectResponsePath, "utf8"),
	) as {
		taskId: string;
		status: string;
		restarts: number | null;
		abortRequested: boolean | null;
		reason: string;
		outcome: string;
	};
	expect(parkedTaskState).toMatchObject({
		taskId,
		status: "pending",
		reason: "",
		outcome: "",
	});
	expect(parkedTaskState.restarts).toBeGreaterThanOrEqual(5);
	expect(parkedTaskState.abortRequested).toBe(false);
	fs.rmSync(inspectResponsePath, { force: true });
	// The operator route, mediator and pinned TLS connection reach the actual
	// DurableHost and Harness.retryTask; no retry operation is mocked here.
	const lease = registerHostRetryTarget(
		"native-restart-limit",
		recoveryRun.conversationId,
		layout.socketPath,
	);
	expect(lease).toBeString();
	const authority = createInstanceAuthority();
	const app = createServerApp({
		authority,
		events: new EventBroker(authority.instance),
		credentials: new CredentialRegistry(),
	});
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => app.fetch(request),
	});
	try {
		const operator = new BackendClient({
			baseUrl: server.url.toString(),
			token: authority.token,
			ownerId: "recovery-test-operator",
		});
		const retry = {
			runId: "native-restart-limit",
			conversationId: recoveryRun.conversationId,
			taskId,
			generation,
		};
		expect(await operator.retryAgentTask(retry)).toMatchObject({
			status: "retried",
			reason:
				"external effects may repeat; exactly-once execution is not guaranteed",
		});
		expect(await operator.retryAgentTask(retry)).not.toMatchObject({
			status: "retried",
		});
	} finally {
		unregisterHostRetryTarget(
			"native-restart-limit",
			recoveryRun.conversationId,
			lease,
		);
		releaseHostRetryCapability(layout.socketPath, recoveryCapability);
		await server.stop(true);
	}

	let recoveredStatus: Awaited<ReturnType<HostClient["status"]>> | undefined;
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			recoveredStatus = await recoveryClient.status("native-restart-limit");
		} catch {
			// The reopened host may still be finishing its startup.
		}
		if (
			recoveredStatus?.status === "idle" &&
			!recoveredStatus.runtimeFailure &&
			fs.existsSync(recoveryPath)
		)
			break;
		await sleep(25);
	}
	expect(recoveredStatus?.status).toBe("idle");
	expect(recoveredStatus?.runtimeFailure).toBeUndefined();
	expect(fs.readFileSync(recoveryPath, "utf8")).toContain("resumed");
	fs.writeFileSync(inspectRequestPath, taskId);
	for (
		let attempt = 0;
		attempt < 100 && !fs.existsSync(inspectResponsePath);
		attempt++
	)
		await sleep(10);
	if (!fs.existsSync(inspectResponsePath))
		throw new Error("native task inspection did not complete");
	const inspectedTask = JSON.parse(
		fs.readFileSync(inspectResponsePath, "utf8"),
	) as { taskId: string; status: string; reason: string; outcome: string };
	expect(inspectedTask).toMatchObject({
		taskId,
		status: "terminal",
		reason: "",
		outcome: "completed",
	});
	expect(
		fs.readFileSync(crashPath, "utf8").trim().split("\n").filter(Boolean),
	).toHaveLength(5);
	if (parkedChild) {
		const client = new HostClient(layout.socketPath, 10_000);
		await client.shutdown();
	}
}, 30_000);

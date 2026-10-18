// Fail fast on a run whose tool surface is dead (efficiency backlog item 3):
// the counter's rule and thresholds, the one tool-host re-probe, the `blocked`
// handoff it produces, and the bounded secret-free text of both.
//
// The host half runs the real durable wiring (`DurableHost` + an in-memory
// storage + a scripted faux model provider), with the `agentic-coding` CLI
// replaced by a shim so nothing here ever reaches a real workflow store, and
// with the tool-host re-probe injected so no test probes the developer's own
// configuration (a run without `AGENTIC_ENV_URL` has no host to re-probe).
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
	FAIL_FAST_CONSECUTIVE_FAILURES,
	FAIL_FAST_ERROR_LINE_LIMIT,
	FAIL_FAST_EXEMPT_ROLES,
	FAIL_FAST_MESSAGE_LIMIT,
	FAIL_FAST_TURNS_WITHOUT_SUCCESS,
	failFastEligibleRole,
	failFastHandoffMessage,
	type ToolOutcomeInput,
	ToolSurfaceMonitor,
	toolSurfaceMonitorFor,
} from "../src/agent-host/fail-fast.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

function failure(
	tool: string,
	kind: ToolOutcomeInput["kind"],
	turn?: number,
): ToolOutcomeInput {
	return {
		tool,
		ok: false,
		...(kind ? { kind } : {}),
		...(turn !== undefined ? { turn } : {}),
	};
}

describe("ToolSurfaceMonitor", () => {
	test(`${FAIL_FAST_CONSECUTIVE_FAILURES} host errors with zero successes probe, then block`, () => {
		const monitor = new ToolSurfaceMonitor();
		for (let index = 1; index < FAIL_FAST_CONSECUTIVE_FAILURES; index++)
			expect(monitor.observe(failure("bash", "host-error"))).toBeUndefined();
		const probe = monitor.observe(failure("bash", "host-error"));
		expect(probe?.action).toBe("probe");
		expect(probe?.facts.tool).toBe("bash");
		expect(probe?.facts.failureKinds).toEqual(["host-error"]);
		expect(probe?.facts.consecutiveFailures).toBe(
			FAIL_FAST_CONSECUTIVE_FAILURES,
		);
		expect(probe?.facts.successes).toBe(0);
		// The one retry was the extra turn: the next failing call ends the run.
		const blocked = monitor.observe(failure("bash", "host-error"));
		expect(blocked?.action).toBe("blocked");
		if (blocked?.action !== "blocked") throw new Error("expected a block");
		expect(blocked.message).toContain("tool surface dead");
		expect(blocked.message).toContain("bash");
		expect(blocked.message).toContain("host-error");
		expect(blocked.message).toContain(
			`${FAIL_FAST_CONSECUTIVE_FAILURES + 1} consecutive failed`,
		);
		// A blocked monitor never decides again.
		expect(monitor.observe(failure("bash", "host-error"))).toBeUndefined();
	});

	test("failures that are ordinary exploration never trip the rule", () => {
		const monitor = new ToolSurfaceMonitor();
		for (let index = 0; index < FAIL_FAST_TURNS_WITHOUT_SUCCESS * 2; index++) {
			expect(
				monitor.observe(failure("read", "not-found", index)),
			).toBeUndefined();
			expect(
				monitor.observe(failure("edit", "no-match", index)),
			).toBeUndefined();
		}
	});

	test("a successful call disables the rule for the rest of the run", () => {
		const monitor = new ToolSurfaceMonitor();
		for (let index = 0; index < 4; index++)
			monitor.observe(failure("bash", "host-error"));
		expect(monitor.observe({ tool: "read", ok: true })).toBeUndefined();
		// Twelve more broken-surface failures do not trip: the surface worked once.
		for (let index = 0; index < 12; index++)
			expect(monitor.observe(failure("bash", "host-error"))).toBeUndefined();
	});

	test("one tool and no success after the turn ceiling trips the rule", () => {
		const monitor = new ToolSurfaceMonitor();
		let decision: ReturnType<ToolSurfaceMonitor["observe"]>;
		for (let turn = 0; turn < FAIL_FAST_TURNS_WITHOUT_SUCCESS; turn++)
			decision = monitor.observe(failure("read", "not-found", turn));
		expect(decision?.action).toBe("probe");
		expect(decision?.facts.turns).toBe(FAIL_FAST_TURNS_WITHOUT_SUCCESS);
	});

	test("two tools without a success do not trip the turn rule", () => {
		const monitor = new ToolSurfaceMonitor();
		let decision: ReturnType<ToolSurfaceMonitor["observe"]>;
		for (let turn = 0; turn < FAIL_FAST_TURNS_WITHOUT_SUCCESS * 2; turn++)
			decision = monitor.observe(
				failure(turn % 2 === 0 ? "read" : "grep", "not-found", turn),
			);
		expect(decision).toBeUndefined();
	});

	test("the handoff message is bounded and secret-free", () => {
		const message = failFastHandoffMessage({
			tool: "bash",
			failureKinds: ["other"],
			consecutiveFailures: 9,
			successes: 0,
			turns: 7,
			lastError: `curl -H "Authorization: Bearer sk-${"x".repeat(24)}" https://example.com/${"y".repeat(400)}`,
		});
		expect(message.length).toBeLessThanOrEqual(FAIL_FAST_MESSAGE_LIMIT);
		expect(message).not.toContain("sk-");
		expect(message).not.toContain("Bearer");
		expect(message).toContain("tool surface dead");
		expect(message).toContain("last error");
	});

	test("a role whose first failures are expected evidence is left alone", () => {
		for (const role of FAIL_FAST_EXEMPT_ROLES)
			expect(failFastEligibleRole(role)).toBe(false);
		expect(failFastEligibleRole("worker")).toBe(true);
		expect(failFastEligibleRole(undefined)).toBe(false);
		for (const role of FAIL_FAST_EXEMPT_ROLES)
			expect(
				toolSurfaceMonitorFor({ HERDR_RUN_ID: "run-1", HERDR_ROLE: role }),
			).toBeUndefined();
		// The orchestrator conversation carries no run id at all.
		expect(toolSurfaceMonitorFor({ HERDR_ROLE: "worker" })).toBeUndefined();
		expect(
			toolSurfaceMonitorFor({ HERDR_RUN_ID: "run-1", HERDR_ROLE: "worker" }),
		).toBeDefined();
	});

	test("the recorded error line stays well inside the message bound", () => {
		expect(FAIL_FAST_ERROR_LINE_LIMIT).toBeLessThan(FAIL_FAST_MESSAGE_LIMIT);
	});
});

function tempWorkflowDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-fail-fast-"));
}

function writeRunEnv(dir: string, vars: Record<string, string>): string {
	const file = path.join(dir, "run.env");
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([key, value]) => `${key}='${value}'`)
			.join("\n"),
	);
	return file;
}

/** A shim `agentic-coding` on PATH: it logs every invocation, so the test reads
 * exactly which handoff the host recorded and nothing here can reach a real
 * workflow store. */
function installAgenticCodingShim(): { log: string; restore: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-coding-shim-"));
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(
		path.join(dir, "agentic-coding"),
		["#!/bin/sh", `printf '%s\\n' "$*" >> "${log}"`, "exit 0"].join("\n"),
		{ mode: 0o700 },
	);
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return {
		log,
		restore: () => {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		},
	};
}

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

function shimCalls(log: string): string {
	try {
		return fs.readFileSync(log, "utf8");
	} catch {
		return "";
	}
}

async function until(check: () => boolean, attempts = 250): Promise<boolean> {
	for (let index = 0; index < attempts; index++) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return check();
}

/** Every `run.fail-fast` envelope the run wrote to its telemetry path. */
function failFastEnvelopes(
	telemetryPath: string,
): Array<Record<string, unknown>> {
	return telemetryEnvelopes(telemetryPath).filter(
		(envelope) => envelope.event === "run.fail-fast",
	);
}

/** Every envelope the run wrote to its telemetry path, or none while it has not
 * written one yet. */
function telemetryEnvelopes(
	telemetryPath: string,
): Array<Record<string, unknown>> {
	try {
		return fs
			.readFileSync(telemetryPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** How many finished tool calls the run recorded. */
function toolCallCount(telemetryPath: string): number {
	return telemetryEnvelopes(telemetryPath).filter(
		(envelope) => envelope.event === "runtime.tool",
	).length;
}

/** One run of the real durable host, driven by a scripted faux provider, whose
 * every tool call fails the way the test asks. The run is left to settle (a
 * dead surface aborts its conversation) before the host is shut down. */
async function runFailingToolRun(options: {
	shimLog: string;
	tool: string;
	args: Record<string, string>;
	/** How many failing calls to script before the trailing text. */
	calls: number;
	role?: string;
}): Promise<{
	telemetryPath: string;
	calls: string;
	probes: Array<Readonly<Record<string, string>>>;
}> {
	const dir = tempWorkflowDir();
	const layout = hostLayout(dir);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const probes: Array<Readonly<Record<string, string>>> = [];
	const host = await DurableHost.open({
		layout,
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		// Injected so no test probes a real configuration.
		probeToolHost: async (env) => {
			probes.push(env);
			return true;
		},
	});
	const telemetryPath = path.join(dir, "telemetry.jsonl");
	const runEnvPath = writeRunEnv(dir, {
		HERDR_WORKFLOW_ID: "wf-fail-fast",
		HERDR_RUN_ID: "run-fail-fast",
		HERDR_STEP_ID: "core.implementation",
		HERDR_ROLE: options.role ?? "worker",
		HERDR_PROFILE: "durable-default",
		HERDR_RUN_TOKEN: "token",
		HERDR_TELEMETRY_PATH: telemetryPath,
	});
	await host.ensureRun({
		runId: "run-fail-fast",
		name: "worker-fail-fast",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		...Array.from({ length: options.calls }, () =>
			fauxAssistantMessage([fauxToolCall(options.tool, options.args)], {
				stopReason: "toolUse",
			}),
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await host.submit("run-fail-fast", "work", "req-fail-fast");
	// Wait until every scripted call has been recorded: a stop then arrives on the
	// same chain, and nothing here waits out a deadline it does not need.
	await until(() => toolCallCount(telemetryPath) >= options.calls);
	// A stop writes its `run.fail-fast` decision before its handoff, and the
	// handoff itself runs through the shim: wait for one, then for the other. A
	// run that was never stopped pays neither wait (the bounded first window is
	// what tells the two apart).
	const stopped = await until(
		() =>
			failFastEnvelopes(telemetryPath).some(
				(envelope) => envelope["herdr.fail_fast.decision"] === "blocked",
			),
		50,
	);
	if (stopped)
		await until(() => shimCalls(options.shimLog).includes("workflow handoff"));
	const calls = shimCalls(options.shimLog);
	await host.shutdown();
	return { telemetryPath, calls, probes };
}

describe("a run whose tool surface never works", () => {
	test("is stopped with a bounded, secret-free blocked handoff", async () => {
		const shim = installAgenticCodingShim();
		restore = shim.restore;
		const secret = "sk-live-abcdefghijklmnop";
		const run = await runFailingToolRun({
			shimLog: shim.log,
			tool: "bash",
			// A failing command whose output carries a secret-looking value: the
			// recorded line must be redacted before it can reach the handoff text.
			args: { command: `printf '${secret}\\n'; exit 1` },
			calls: FAIL_FAST_CONSECUTIVE_FAILURES + 1,
		});
		// The one re-probe happened exactly once, before the run was stopped.
		expect(run.probes.length).toBe(1);
		expect(run.calls).toContain("workflow handoff --outcome blocked");
		expect(run.calls).not.toContain("--aborted");
		expect(run.calls).toContain("tool surface dead");
		expect(run.calls).toContain("bash");
		expect(run.calls).toContain("failure kind(s): other");
		expect(run.calls).toContain("turns taken:");
		expect(run.calls).not.toContain(secret);

		const envelopes = failFastEnvelopes(run.telemetryPath);
		const probe = envelopes.find(
			(envelope) => envelope["herdr.fail_fast.decision"] === "probe",
		);
		expect(probe?.["pi.tool.name"]).toBe("bash");
		expect(probe?.["pi.tool.failure_kinds"]).toBe("other");
		expect(probe?.["pi.tool.consecutive_failures"]).toBe(
			FAIL_FAST_CONSECUTIVE_FAILURES,
		);
		expect(probe?.["pi.tool.successes"]).toBe(0);
		expect(probe?.probed).toBe(true);
		expect(probe?.runId).toBe("run-fail-fast");
		expect(probe?.role).toBe("worker");
		const blocked = envelopes.find(
			(envelope) => envelope["herdr.fail_fast.decision"] === "blocked",
		);
		expect(blocked?.["pi.tool.name"]).toBe("bash");
		expect(blocked?.["pi.tool.consecutive_failures"]).toBe(
			FAIL_FAST_CONSECUTIVE_FAILURES + 1,
		);
		expect(Number(blocked?.["pi.turn.count"])).toBeGreaterThan(0);
		// The envelopes carry no part of the tool result.
		expect(JSON.stringify(envelopes)).not.toContain(secret);
		expect(JSON.stringify(envelopes)).not.toContain("printf");
	});

	test("keeps running when the failures are ordinary exploration", async () => {
		const shim = installAgenticCodingShim();
		restore = shim.restore;
		const run = await runFailingToolRun({
			shimLog: shim.log,
			tool: "read",
			args: { path: "does-not-exist.txt" },
			calls: FAIL_FAST_CONSECUTIVE_FAILURES,
		});
		expect(run.probes.length).toBe(0);
		expect(run.calls).not.toContain("workflow handoff");
		expect(failFastEnvelopes(run.telemetryPath)).toEqual([]);
	});

	test("leaves an exempt role's failing first calls alone", async () => {
		const shim = installAgenticCodingShim();
		restore = shim.restore;
		const run = await runFailingToolRun({
			shimLog: shim.log,
			tool: "bash",
			args: { command: "exit 1" },
			calls: FAIL_FAST_CONSECUTIVE_FAILURES + 1,
			role: "debug",
		});
		expect(run.probes.length).toBe(0);
		expect(run.calls).not.toContain("workflow handoff");
		expect(failFastEnvelopes(run.telemetryPath)).toEqual([]);
	});
});

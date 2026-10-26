// Delegated debug requests (add-debug-subagent-requests): the store table and
// its status transitions, the request lifecycle through the engine (limits,
// recursion, the handoff guard on both caller lanes, cancel, repair), the
// durable run start (baseline + exactly one launch), the handoff lane that
// finishes the request, the delivery into a live caller conversation, and the
// read-only dashboard surface.
//
// The tests drive the real engine, the real effect runner and a stub adapter,
// the same way the debug family's own handoff test does; the one host boundary
// they exercise (the delivery's control socket) is a minimal fake server that
// records the frames it receives, so nothing here reaches the network or a real
// durable host.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
	decodeFrame,
	encodeFrame,
	type HostRequest,
} from "../src/agent-host/protocol.ts";
import {
	createDebugRequestExtension,
	debugRequestToolNames,
	withoutDebugRequestTools,
} from "../src/agent-host/tools.ts";
import type {
	EffectKind,
	ResolvedProfile,
	WorkflowRouting,
} from "../src/contracts/workflow.ts";
import { loadDebugRequests } from "../src/server/operations/observations.ts";
import { debugRequestReportLocalPath } from "../src/tui/dash/debug-requests-open.ts";
import {
	debugRequestDetailLines,
	debugRequestListWindow,
	debugRequestRowLabel,
	debugRequestsKeyAction,
	debugRequestWindow,
} from "../src/tui/dash/debug-requests-panel.ts";
import { dashboardDetailKeybindCatalog } from "../src/tui/dash/keybinds.ts";
import { DEBUG_REQUESTS_HELP } from "../src/tui/dash/ui/DebugRequestsModal.tsx";
import {
	REQUIRED_FLAGS,
	required,
	SUBCOMMANDS,
	validateArgs,
} from "../src/workflow/cli/schema.ts";
import { DEBUG_REPORT_HEADINGS } from "../src/workflow/definitions/contracts.ts";
import {
	definitionVersionForFamilyTraits,
	definitionVersionForManifestPolicy,
} from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import {
	assertDebugRequestTransition,
	debugRequestLimitRefusal,
	normalizeDebugApps,
	resolveDebugReportPath,
	stagedDebugReportPath,
	validateDebugRequestText,
} from "../src/workflow/runtime/debug-requests.ts";
import { debugRequestReportPathFor } from "../src/workflow/runtime/evidence-store.ts";
import { createDebugRequestRun } from "../src/workflow/runtime/kernel.ts";
import {
	initializeStore,
	openStore,
	STORE_SCHEMA_VERSION,
	tableExists,
} from "../src/workflow/runtime/store.ts";
import {
	researchWorkflowTarget,
	WorkflowEngine,
} from "../src/workflow/runtime.ts";
import type {
	WorktreeEnsureInput,
	WorktreePort,
} from "../src/worktree/port.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

const profile: ResolvedProfile = {
	name: "fake",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe", "shell", "edit"],
	digest: "fake",
};

const routing: WorkflowRouting = {
	defaultProfile: "fake",
	routes: [{ stepId: "core.implementation", role: "worker", profile }],
};

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined)
		throw new Error(`expected ${what} to exist`);
	return value;
}

/** A stub `agentic-coding` binary first on PATH, so a tool call is asserted by
 * the argv it spawns rather than by reaching the real CLI (the same shim the
 * dialogue-tool test uses). */
function installAgenticCodingShim(): { log: string; restore: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-request-shim-"));
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(
		path.join(dir, "agentic-coding"),
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> "${log}"`,
			`printf 'shim: %s\\n' "$*"`,
		].join("\n"),
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

/** The durable outbox rows of one store, read directly: the effect's idempotency
 * key is what makes a retried emission the same row, and the view does not carry
 * it. */
function outbox(root: string): Array<{
	kind: string;
	idempotency_key: string;
	status: string;
}> {
	const db = openStore(root);
	try {
		return db
			.query("SELECT kind,idempotency_key,status FROM workflow_outbox")
			.all() as Array<{
			kind: string;
			idempotency_key: string;
			status: string;
		}>;
	} finally {
		db.close();
	}
}

/** A worktree port that returns the repository itself as the workflow's
 * worktree, so a test workflow runs against a real checkout without creating a
 * second one outside its temp root — the same seam the debug family's handoff
 * test uses. */
function recordingPort(
	root: string,
	calls: WorktreeEnsureInput[],
): WorktreePort {
	return {
		list: () => Effect.succeed([]),
		find: () => Effect.succeed(undefined),
		ensure: (input) => {
			calls.push(input);
			return Effect.succeed({
				path: root,
				branch: "",
				isMain: false,
				detached: true,
				created: true,
			});
		},
		remove: () => Effect.void,
	};
}

/** A minimal durable host: it records every frame a client sends and answers a
 * `submit` with the submission id the real host would return. */
function fakeHost(socketPath: string, frames: HostRequest[]): net.Server {
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				const decoded = decodeFrame(line);
				if (!decoded.ok) continue;
				const request = decoded.value as HostRequest;
				frames.push(request);
				if (request.type === "submit")
					socket.write(
						encodeFrame({
							type: "submit",
							runId: request.runId,
							submissionId: `submission-${frames.length}`,
						} as never),
					);
			}
		});
	});
	server.listen(socketPath);
	return server;
}

/** A stub durable adapter: enough to let the launch and delivery handlers run
 * without a real host, recording what they were asked to do. Its handle points
 * at `socketPath`, so a test can put a fake host behind it. */
class StubAdapter {
	readonly id = "pi-durable" as const;
	readonly launched: string[] = [];
	readonly stopped: string[] = [];
	readonly prompts: string[] = [];
	constructor(private readonly socketPath = "/tmp/debug-request-host.sock") {}
	launch(ctx: {
		assignment: { runId: string };
		name: string;
		rendered: { prompt: string };
	}) {
		this.launched.push(ctx.assignment.runId);
		this.prompts.push(ctx.rendered.prompt);
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: this.socketPath,
			sessionId: ctx.assignment.runId,
			conversationId: "1",
		});
	}
	preflight() {}
	prompt() {
		return Effect.void;
	}
	observe() {
		return Effect.succeed({ status: "working" as const });
	}
	stop(handle: { sessionId?: string }) {
		this.stopped.push(handle.sessionId ?? "");
		return Effect.void;
	}
}

function runner(
	root: string,
	engine: WorkflowEngine,
	adapter: StubAdapter,
	claimKind?: EffectKind,
) {
	return new EffectRunner(
		root,
		engine,
		agentEffectHandlers(root, engine, {
			registry: registerBuiltins(),
			adapters: new Map([["pi-durable", adapter as never]]),
		}),
		claimKind ? { claimKind } : {},
	);
}

/** Start a solo workflow and return its single implementation run, whose role is
 * `worker` — the caller a debug request may be delegated from. */
async function startCaller(
	engine: WorkflowEngine,
	root: string,
	workflowId: string,
): Promise<{ runId: string; token: string }> {
	engine.start({
		repo: root,
		mode: "worktree",
		workflowId,
		definitionId: "solo",
		definitionVersion: definitionVersionForFamilyTraits(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: git(root, ["rev-parse", "HEAD"]),
			task: "make the failing check pass",
		},
		routing,
	});
	// The workflow's own workspace setup runs first (its worktree is the temp
	// repository through the recording port), then the family's per-step routing
	// step before its implementation step: answering the classification advances
	// to the agent step, where the caller run exists.
	await new EffectRunner(
		root,
		engine,
		agentEffectHandlers(root, engine, {
			registry: registerBuiltins(),
			adapters: new Map(),
			worktree: recordingPort(root, []),
		}),
		{ claimKind: "workspace.setup" },
	).drain(1);
	const classify = engine
		.claimEffects(root, 100)
		.find((effect) => effect.kind === "model.classify");
	if (classify)
		engine.dispatch(root, {
			type: "effect.result",
			effectId: classify.id,
			lease: requireDefined(classify.lease, "classify lease"),
			outcome: "complete",
			data: {
				integration: "routing",
				phase:
					(classify.payload as { phase?: string }).phase === "apply"
						? "apply"
						: "plan",
				answers: {},
			},
		});
	const view = engine.status(root, workflowId);
	expect(view.currentStep.id).toBe("core.implementation");
	const runId = requireDefined(view.runs[0]?.id, "caller run");
	const token = engine.issueRunCapability(root, runId);
	return { runId, token };
}

function reportMarkdown(): string {
	return DEBUG_REPORT_HEADINGS.map((heading) => `# ${heading}\n\ncontent`).join(
		"\n\n",
	);
}

function writeArtifact(outputPath: string, runId: string): void {
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(
		outputPath,
		JSON.stringify({
			runId,
			schemaId: "core.debug-report",
			schemaVersion: 1,
			payload: { report: reportMarkdown() },
		}),
	);
}

/** One delegated request whose lifecycle effect has run: the request is
 * `running`, its launch is enqueued, and the caller run is returned. */
async function startDelegatedRequest(
	engine: WorkflowEngine,
	root: string,
	workflowId: string,
	adapter: StubAdapter,
): Promise<{
	caller: { runId: string; token: string };
	requestId: string;
	debugRunId: string;
}> {
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
	});
	await runner(root, engine, adapter, "debug.request.run").drain(1);
	return { caller, requestId: created.request.id, debugRunId: created.runId };
}

/** Give one run the durable handle its own launch would have persisted, so a
 * test can put a fake host behind the delivery without driving the launch. */
function writeCallerHandle(
	root: string,
	runId: string,
	socketPath: string,
): void {
	const db = openStore(root);
	try {
		db.query("UPDATE workflow_runs SET handle_json=? WHERE id=?").run(
			JSON.stringify({
				runtime: "pi-durable",
				name: `caller-${runId.slice(0, 8)}`,
				hostSocket: socketPath,
				sessionId: runId,
				conversationId: "1",
			}),
			runId,
		);
	} finally {
		db.close();
	}
}

/** The delivery effect, claimed so its handler can be run (and re-run) directly. */
function claimDeliverEffect(engine: WorkflowEngine, root: string) {
	return requireDefined(
		engine
			.claimEffects(root, 100)
			.find((effect) => effect.kind === "debug.request.deliver"),
		"delivery effect",
	);
}

/** The delegated run's launch effect, claimed so its capability can be read. */
function claimDelegatedLaunch(
	engine: WorkflowEngine,
	root: string,
	debugRunId: string,
) {
	return requireDefined(
		engine
			.claimEffects(root, 100)
			.find(
				(effect) =>
					effect.kind === "agent.launch" &&
					(effect.payload as { runId?: string }).runId === debugRunId,
			),
		"delegated launch effect",
	);
}

test("the store carries the debug request table at the current schema version", () => {
	const root = createTempRepoFixture("debug-request-store-", {
		files: { "README.md": "test\n" },
	});
	initializeStore(root);
	const db = openStore(root);
	try {
		expect(tableExists(db, "debug_requests")).toBe(true);
		const version = db.query("PRAGMA user_version").get() as {
			user_version: number;
		};
		expect(version.user_version).toBe(STORE_SCHEMA_VERSION);
	} finally {
		db.close();
	}
});

test("status transitions, the open-request limits and the request text are guarded", () => {
	expect(() => assertDebugRequestTransition("queued", "running")).not.toThrow();
	expect(() => assertDebugRequestTransition("running", "done")).not.toThrow();
	expect(() =>
		assertDebugRequestTransition("running", "cancelled"),
	).not.toThrow();
	// A terminal status is final.
	expect(() => assertDebugRequestTransition("done", "running")).toThrow();
	expect(() => assertDebugRequestTransition("cancelled", "running")).toThrow();
	expect(() => assertDebugRequestTransition("failed", "queued")).toThrow();

	expect(
		debugRequestLimitRefusal({ goal: "  ", openForRun: 0, openForWorkflow: 0 }),
	).toContain("goal");
	expect(
		debugRequestLimitRefusal({
			goal: "probe",
			openForRun: 1,
			openForWorkflow: 1,
		}),
	).toContain("already has an open debug request");
	expect(
		debugRequestLimitRefusal({
			goal: "probe",
			openForRun: 0,
			openForWorkflow: 2,
		}),
	).toContain("per workflow");
	expect(
		debugRequestLimitRefusal({
			goal: "probe",
			openForRun: 0,
			openForWorkflow: 1,
		}),
	).toBeUndefined();

	// The request text and the app idents are bounded before anything is stored.
	expect(
		validateDebugRequestText({ goal: "probe", context: "why" }),
	).toBeUndefined();
	expect(validateDebugRequestText({ goal: "  " })).toContain("goal");
	expect(validateDebugRequestText({ goal: "x".repeat(4097) })).toContain(
		"4096",
	);
	expect(
		validateDebugRequestText({ goal: "probe", context: "x".repeat(16_385) }),
	).toContain("16384");
	expect(normalizeDebugApps([" app ", "app", "api"])).toEqual(["app", "api"]);
	expect(() => normalizeDebugApps(["bad name"])).toThrow(/plain configured/);
	expect(() => normalizeDebugApps(["x".repeat(129)])).toThrow(/too long/);
	expect(() =>
		normalizeDebugApps(Array.from({ length: 9 }, (_, i) => `app-${i}`)),
	).toThrow(/at most 8/);
});

test("a request starts a side run beside the caller's step and is limited", async () => {
	const root = createTempRepoFixture("debug-request-lifecycle-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-lifecycle";
	const engine = new WorkflowEngine(registerBuiltins());
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
		context: "the check fails on an empty input",
		apps: ["app"],
	});
	expect(created.request.status).toBe("queued");
	expect(created.request.apps).toEqual(["app"]);
	// The side run is a real run row under the debug role and step...
	const debugRun = engine.getRun(root, created.runId);
	expect(debugRun.stepId).toBe("debug.investigate");
	expect(debugRun.role).toBe("debug");
	expect(debugRun.workflowId).toBe(workflowId);
	// ...and it is deliberately not part of the caller's step machinery, so the
	// workflow's current step and active runs are untouched.
	const snapshot = engine.getSnapshot(root, workflowId);
	expect(snapshot.currentStep).toBe("core.implementation");
	expect(snapshot.step.activeRunIds).toEqual([caller.runId]);
	// The lifecycle effect is durable and step-independent.
	expect(
		outbox(root).filter((effect) => effect.kind === "debug.request.run").length,
	).toBe(1);
	// One open request per caller run.
	expect(() =>
		engine.requestDebugRun(root, {
			workflowId,
			callerRunId: caller.runId,
			callerRole: "worker",
			goal: "another probe",
		}),
	).toThrow(/already has an open debug request/);
	// The caller's role is authenticated: another role cannot spend this run's
	// capability.
	expect(() =>
		engine.requestDebugRun(root, {
			workflowId,
			callerRunId: caller.runId,
			callerRole: "verifier",
			goal: "another probe",
		}),
	).toThrow(/role mismatch/);
	// The handoff guard refuses the caller while its request is open, naming it.
	expect(() =>
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: caller.runId,
			generation: 1,
			token: caller.token,
			outcome: "blocked",
			message: "giving up",
		}),
	).toThrow(new RegExp(`open debug request\\(s\\): ${created.request.id}`));
	engine.cancelDebugRequest(root, created.request.id);
	// Cancelling again is idempotent, and the caller can hand off once no request
	// is open any more.
	expect(engine.cancelDebugRequest(root, created.request.id).status).toBe(
		"cancelled",
	);
	expect(engine.getRun(root, created.runId).status).toBe("expired");
	expect(() =>
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: caller.runId,
			generation: 1,
			token: caller.token,
			outcome: "blocked",
			message: "giving up",
		}),
	).not.toThrow(/open debug request/);
});

test("only the requesting run may cancel its request", async () => {
	const root = createTempRepoFixture("debug-request-cancel-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-cancel";
	const engine = new WorkflowEngine(registerBuiltins());
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
	});
	// A run that is not the request's caller (the delegated debug run itself, or
	// any sibling) cannot cancel it, and the row stays open.
	expect(() =>
		engine.cancelDebugRequest(root, created.request.id, created.runId),
	).toThrow(/belongs to another run/);
	expect(engine.debugRequest(root, created.request.id)?.status).toBe("queued");
	expect(
		engine.cancelDebugRequest(root, created.request.id, caller.runId).status,
	).toBe("cancelled");
});

test("cancelling a finished request answers its status instead of failing", async () => {
	const root = createTempRepoFixture("debug-request-cancel-terminal-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-cancel-terminal";
	const engine = new WorkflowEngine(registerBuiltins());
	const adapter = new StubAdapter();
	const { caller, requestId, debugRunId } = await startDelegatedRequest(
		engine,
		root,
		workflowId,
		adapter,
	);
	const launch = claimDelegatedLaunch(engine, root, debugRunId);
	const run = engine.getRun(root, debugRunId);
	const outputPath = requireDefined(run.outputPath, "output path");
	writeArtifact(outputPath, debugRunId);
	engine.dispatch(root, {
		type: "agent.handoff",
		runId: debugRunId,
		generation: run.generation,
		token: requireDefined(launch.runToken, "run token"),
		outcome: "complete",
		artifact: outputPath,
	});
	expect(engine.debugRequest(root, requestId)?.status).toBe("done");
	// The race the guard's escape hatch hits: the request finished between the
	// read and the cancel. The command answers the row it has.
	const cancelled = engine.cancelDebugRequest(root, requestId, caller.runId);
	expect(cancelled.status).toBe("done");
});

test("a debug run cannot delegate another request", async () => {
	const root = createTempRepoFixture("debug-request-recursion-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-recursion";
	const engine = new WorkflowEngine(registerBuiltins());
	await startCaller(engine, root, workflowId);
	// The debug side run is written through the same kernel helper the engine
	// uses, so this is the real shape a delegated run has.
	const db = openStore(root);
	let debugRunId = "";
	try {
		const callerRow = requireDefined(
			engine.getRun(root, engine.status(root, workflowId).runs[0]?.id ?? ""),
			"caller run",
		);
		const snapshot = engine.getSnapshot(root, workflowId);
		debugRunId = createDebugRequestRun(
			db,
			snapshot,
			callerRow,
			{ id: "core.debug-report", version: 1 },
			() => new Date(),
		).id;
	} finally {
		db.close();
	}
	expect(() =>
		engine.requestDebugRun(root, {
			workflowId,
			callerRunId: debugRunId,
			callerRole: "debug",
			goal: "delegate again",
		}),
	).toThrow(/may not delegate/);
});

test("the lifecycle effect starts one run with a baseline, and the handoff finishes the request", async () => {
	const root = createTempRepoFixture("debug-request-run-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-run";
	const engine = new WorkflowEngine(registerBuiltins());
	const adapter = new StubAdapter();
	const { caller, requestId, debugRunId } = await startDelegatedRequest(
		engine,
		root,
		workflowId,
		adapter,
	);
	// The baseline records the checkout as it is now.
	const started = requireDefined(
		engine.debugRequest(root, requestId),
		"started request",
	);
	expect(started.status).toBe("running");
	expect(started.baselineRef).toBe(git(root, ["rev-parse", "HEAD"]));
	expect(started.baselineUsable).toBe(true);
	// Exactly one launch row for the delegated run, whatever a retried effect
	// does: the launch's own idempotency key is the guarantee.
	const launchKey = `run:${debugRunId}:launch`;
	engine.enqueueEffect(root, workflowId, "agent.launch", launchKey, {
		runId: debugRunId,
		debugRequestId: requestId,
	});
	expect(
		outbox(root).filter(
			(effect) =>
				effect.kind === "agent.launch" && effect.idempotency_key === launchKey,
		).length,
	).toBe(1);
	// The delegated run's launch runs the debug role's own step: its assignment
	// carries the caller's goal and the shared-worktree rule.
	const launch = claimDelegatedLaunch(engine, root, debugRunId);
	const handlers = agentEffectHandlers(root, engine, {
		registry: registerBuiltins(),
		adapters: new Map([["pi-durable", adapter as never]]),
	});
	await Effect.runPromise(
		handlers["agent.launch"]?.execute(
			launch,
			undefined,
		) as Effect.Effect<unknown>,
	);
	expect(adapter.launched).toEqual([debugRunId]);
	const prompt = requireDefined(adapter.prompts[0], "delegated assignment");
	expect(prompt).toContain("You are the debug agent");
	expect(prompt).toContain("reproduce the empty result");
	expect(prompt).toContain("shared worktree");
	expect(prompt).toContain(requestId);
	expect(engine.getRun(root, debugRunId).profile.name).toBe(
		engine.getRun(root, caller.runId).profile.name,
	);
	const run = engine.getRun(root, debugRunId);
	const outputPath = requireDefined(run.outputPath, "output path");
	// The caller's own edit beside the delegated run, and the report the run
	// hands off: both are what the touched-file report must show.
	fs.writeFileSync(
		path.join(root, "probe.txt"),
		"changed while the request ran\n",
	);
	writeArtifact(outputPath, debugRunId);
	engine.dispatch(root, {
		type: "agent.handoff",
		runId: debugRunId,
		generation: run.generation,
		token: requireDefined(launch.runToken, "run token"),
		outcome: "complete",
		artifact: outputPath,
	});
	const finished = requireDefined(
		engine.debugRequest(root, requestId),
		"finished request",
	);
	expect(finished.status).toBe("done");
	expect(finished.changedFiles).toEqual(["probe.txt"]);
	expect(finished.reportPath).toBeDefined();
	expect(
		fs.readFileSync(requireDefined(finished.reportPath, "report"), "utf8"),
	).toBe(`${reportMarkdown()}\n`);
	// The caller keeps working: its step, its run and its status are untouched.
	const after = engine.status(root, workflowId);
	expect(after.currentStep.id).toBe("core.implementation");
	// The caller's own run is left exactly as it was: still active, never
	// completed or expired by the delegated run's handoff.
	expect(["pending", "working"]).toContain(
		engine.getRun(root, caller.runId).status,
	);
	// The delivery is durable and enqueued exactly once.
	expect(
		outbox(root).filter((effect) => effect.kind === "debug.request.deliver")
			.length,
	).toBe(1);
});

test("a blocked investigation fails the request and still delivers its outcome", async () => {
	const root = createTempRepoFixture("debug-request-blocked-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-blocked";
	const engine = new WorkflowEngine(registerBuiltins());
	const adapter = new StubAdapter();
	const { requestId, debugRunId } = await startDelegatedRequest(
		engine,
		root,
		workflowId,
		adapter,
	);
	const launch = claimDelegatedLaunch(engine, root, debugRunId);
	const run = engine.getRun(root, debugRunId);
	engine.dispatch(root, {
		type: "agent.handoff",
		runId: debugRunId,
		generation: run.generation,
		token: requireDefined(launch.runToken, "run token"),
		outcome: "blocked",
		message: "the app has no run target",
	});
	const finished = requireDefined(
		engine.debugRequest(root, requestId),
		"blocked request",
	);
	expect(finished.status).toBe("failed");
	// No report and no changed-file list: the run never measured them.
	expect(finished.reportPath).toBeUndefined();
	expect(finished.changedFiles).toEqual([]);
	expect(engine.getRun(root, debugRunId).status).toBe("blocked");
	// The caller still hears the outcome: exactly one delivery is enqueued.
	expect(
		outbox(root).filter((effect) => effect.kind === "debug.request.deliver")
			.length,
	).toBe(1);
});

test("a finished report is injected into the caller's conversation exactly once", async () => {
	const root = createTempRepoFixture("debug-request-deliver-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-deliver";
	const engine = new WorkflowEngine(registerBuiltins());
	const socketDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "debug-request-host-"),
	);
	const socketPath = path.join(socketDir, "host.sock");
	const frames: HostRequest[] = [];
	const server = fakeHost(socketPath, frames);
	const adapter = new StubAdapter(socketPath);
	try {
		const { caller, requestId, debugRunId } = await startDelegatedRequest(
			engine,
			root,
			workflowId,
			adapter,
		);
		// The caller run is given the handle its own launch would have persisted,
		// pointing at the fake host: the delivery then has a live conversation to
		// inject the report into.
		writeCallerHandle(root, caller.runId, socketPath);
		const callerHandle = requireDefined(
			engine.getRun(root, caller.runId).handle,
			"caller handle",
		);
		expect(callerHandle.hostSocket).toBe(socketPath);
		expect(callerHandle.sessionId).toBe(caller.runId);
		const launch = claimDelegatedLaunch(engine, root, debugRunId);
		const run = engine.getRun(root, debugRunId);
		const outputPath = requireDefined(run.outputPath, "output path");
		fs.writeFileSync(path.join(root, "probe.txt"), "touched\n");
		writeArtifact(outputPath, debugRunId);
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: debugRunId,
			generation: run.generation,
			token: requireDefined(launch.runToken, "run token"),
			outcome: "complete",
			artifact: outputPath,
		});
		const finished = requireDefined(
			engine.debugRequest(root, requestId),
			"finished request",
		);
		const handlers = agentEffectHandlers(root, engine, {
			registry: registerBuiltins(),
			adapters: new Map([["pi-durable", adapter as never]]),
		});
		const delivery = claimDeliverEffect(engine, root);
		await Effect.runPromise(
			handlers["debug.request.deliver"]?.execute(
				delivery,
				undefined,
			) as Effect.Effect<unknown>,
		);
		const submitted = frames.filter(
			(frame): frame is Extract<HostRequest, { type: "submit" }> =>
				frame.type === "submit",
		);
		expect(submitted.length).toBe(1);
		const submission = requireDefined(submitted[0], "submission");
		// The delivery's own identity, its follow-up mode, and the message the
		// caller reads: summary, report path, evidence and changed files.
		expect(submission.requestId).toBe(`debug:${requestId}`);
		expect(submission.whenBusy).toBe("followUp");
		expect(submission.text).toContain("# Summary");
		expect(submission.text).toContain(
			requireDefined(finished.reportPath, "report path"),
		);
		expect(submission.text).toContain("Files changed during the request");
		expect(submission.text).toContain("probe.txt");
		expect(submission.text).toContain(`debug_result("${requestId}")`);
		expect(
			requireDefined(engine.debugRequest(root, requestId), "delivered request")
				.deliveredAt,
		).toBeDefined();
		// Running the effect again is a no-op: the scenario's "only once".
		await Effect.runPromise(
			handlers["debug.request.deliver"]?.execute(
				delivery,
				undefined,
			) as Effect.Effect<unknown>,
		);
		expect(frames.filter((frame) => frame.type === "submit").length).toBe(1);
	} finally {
		server.close();
		fs.rmSync(socketDir, { recursive: true, force: true });
	}
});

test("delivery stands down when the caller run has ended", async () => {
	const root = createTempRepoFixture("debug-request-caller-ended-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-caller-ended";
	const engine = new WorkflowEngine(registerBuiltins());
	const socketDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "debug-request-host-ended-"),
	);
	const socketPath = path.join(socketDir, "host.sock");
	const frames: HostRequest[] = [];
	const server = fakeHost(socketPath, frames);
	const adapter = new StubAdapter(socketPath);
	try {
		const { caller, requestId, debugRunId } = await startDelegatedRequest(
			engine,
			root,
			workflowId,
			adapter,
		);
		// The caller keeps a stored handle after it hands off: the run's own
		// lifecycle status is what says it has ended.
		writeCallerHandle(root, caller.runId, socketPath);
		const launch = claimDelegatedLaunch(engine, root, debugRunId);
		const run = engine.getRun(root, debugRunId);
		const outputPath = requireDefined(run.outputPath, "output path");
		writeArtifact(outputPath, debugRunId);
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: debugRunId,
			generation: run.generation,
			token: requireDefined(launch.runToken, "run token"),
			outcome: "complete",
			artifact: outputPath,
		});
		// The caller hands off in the window before the delivery drains: it keeps
		// its stored handle, so the run's own status is what says it has ended.
		engine.dispatch(root, {
			type: "agent.handoff",
			runId: caller.runId,
			generation: 1,
			token: caller.token,
			outcome: "blocked",
			message: "the caller gave up",
		});
		expect(["blocked", "completed"]).toContain(
			engine.getRun(root, caller.runId).status,
		);
		await runner(root, engine, adapter, "debug.request.deliver").drain(1);
		// Nothing was injected, the artifact stands, and the effect completed
		// rather than burning its attempts on a retired conversation.
		expect(frames.filter((frame) => frame.type === "submit").length).toBe(0);
		const request = requireDefined(
			engine.debugRequest(root, requestId),
			"request",
		);
		expect(request.deliveredAt).toBeUndefined();
		expect(request.reportPath).toBeDefined();
		expect(
			outbox(root).filter(
				(effect) =>
					effect.kind === "debug.request.deliver" && effect.status !== "failed",
			).length,
		).toBe(1);
	} finally {
		server.close();
		fs.rmSync(socketDir, { recursive: true, force: true });
	}
});

test("a repair closes the retired run's open requests and keeps their lifecycle effects", async () => {
	const root = createTempRepoFixture("debug-request-repair-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-repair";
	const engine = new WorkflowEngine(registerBuiltins());
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
	});
	const view = engine.status(root, workflowId);
	engine.dispatch(root, {
		type: "operator.repair",
		workflowId,
		revision: view.revision,
		targetStep: "core.implementation",
		reason: "retry the implementation round",
	});
	const request = requireDefined(
		engine.debugRequest(root, created.request.id),
		"repaired request",
	);
	// The request is closed in the same transaction, so it cannot hold one of the
	// workflow's two open slots with no effect that could ever advance it.
	expect(request.status).toBe("cancelled");
	expect(request.finishedAt).toBeDefined();
	expect(engine.getRun(root, created.runId).status).toBe("expired");
	// Its lifecycle effect survives the blanket expiry: the idempotency key is the
	// durable entry contract for the delegated run's launch.
	expect(
		outbox(root).filter(
			(effect) =>
				effect.kind === "debug.request.run" && effect.status === "expired",
		).length,
	).toBe(0);
});

test("the research handoff lane applies the same open-request guard", async () => {
	const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-request-wiki-"));
	const previousWikiRoot = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(wikiDir, "wiki");
	const engine = new WorkflowEngine(registerBuiltins());
	const target = researchWorkflowTarget();
	const researchProfile: ResolvedProfile = {
		...profile,
		name: "research",
		readOnly: true,
		capabilities: ["prompt", "run-environment", "observe", "read-only"],
		digest: "research-profile",
	};
	try {
		engine.start({
			repo: target,
			workflowId: "debug-request-research",
			definitionId: "research",
			definitionVersion: definitionVersionForManifestPolicy(6),
			metadata: { branch: "", baseBranch: "", baseCommit: "", task: "probe" },
			routing: {
				defaultProfile: researchProfile.name,
				routes: [
					{
						stepId: "core.research",
						role: "researcher",
						profile: researchProfile,
					},
					{
						stepId: "core.wiki",
						role: "research-wiki",
						profile: researchProfile,
					},
				],
			},
		});
		await new EffectRunner(
			target,
			engine,
			agentEffectHandlers(target, engine, {
				registry: registerBuiltins(),
				adapters: new Map(),
				worktree: recordingPort(target, []),
			}),
			{ claimKind: "workspace.setup" },
		).drain(1);
		const view = engine.status(target, "debug-request-research");
		const runId = requireDefined(view.runs[0]?.id, "researcher run");
		const token = engine.issueRunCapability(target, runId);
		const created = engine.requestDebugRun(target, {
			workflowId: "debug-request-research",
			callerRunId: runId,
			callerRole: "researcher",
			goal: "reproduce the empty result",
		});
		const handoff = {
			type: "agent.research-handoff" as const,
			workflowId: "debug-request-research",
			runId,
			stepId: "core.research",
			role: "researcher",
			token,
			handoff: {
				subject: "widget subsystem",
				directives: [
					{
						target: "projects/demo",
						intent: "create" as const,
						claims: ["widgets come from the factory"],
						citations: ["src/widget.ts"],
					},
				],
				citations: ["src/widget.ts"],
				noSourcesUsed: false,
			},
		};
		// The research lane is the family's only successful completion, so the
		// guard has to be here too, not only on `agent.handoff`.
		expect(() => engine.dispatch(target, handoff)).toThrow(
			new RegExp(`open debug request\\(s\\): ${created.request.id}`),
		);
		expect(engine.status(target, "debug-request-research").currentStep.id).toBe(
			"core.research",
		);
		engine.cancelDebugRequest(target, created.request.id, runId);
		engine.dispatch(target, handoff);
		expect(engine.status(target, "debug-request-research").currentStep.id).toBe(
			"core.wiki",
		);
	} finally {
		if (previousWikiRoot === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previousWikiRoot;
		fs.rmSync(wikiDir, { recursive: true, force: true });
	}
});

test("a report staged before a crash is completed on the next read", async () => {
	const root = createTempRepoFixture("debug-request-staged-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-staged";
	const engine = new WorkflowEngine(registerBuiltins());
	const adapter = new StubAdapter();
	const { requestId, debugRunId } = await startDelegatedRequest(
		engine,
		root,
		workflowId,
		adapter,
	);
	const launch = claimDelegatedLaunch(engine, root, debugRunId);
	const run = engine.getRun(root, debugRunId);
	const outputPath = requireDefined(run.outputPath, "output path");
	writeArtifact(outputPath, debugRunId);
	engine.dispatch(root, {
		type: "agent.handoff",
		runId: debugRunId,
		generation: run.generation,
		token: requireDefined(launch.runToken, "run token"),
		outcome: "complete",
		artifact: outputPath,
	});
	const finished = requireDefined(
		engine.debugRequest(root, requestId),
		"finished request",
	);
	const reportPath = requireDefined(finished.reportPath, "report path");
	// The crash window: the row names the report, the bytes are still staged.
	const bytes = fs.readFileSync(reportPath, "utf8");
	const staged = requireDefined(
		stagedDebugReportPath(finished),
		"staged report path",
	);
	fs.writeFileSync(staged, bytes);
	fs.rmSync(reportPath);
	// The row alone is enough to recover: the readers complete the rename.
	expect(resolveDebugReportPath(finished)).toBe(reportPath);
	expect(fs.readFileSync(reportPath, "utf8")).toBe(bytes);
	expect(fs.existsSync(staged)).toBe(false);
	// And the observation serves it without a second handoff.
	const observed = loadDebugRequests(root, workflowId);
	expect(observed.requests[0]?.report).toBe(bytes);
});

test("an unusable baseline is reported instead of silently listing a subset", async () => {
	const root = createTempRepoFixture("debug-request-baseline-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-baseline";
	const engine = new WorkflowEngine(registerBuiltins());
	const adapter = new StubAdapter();
	const { requestId, debugRunId } = await startDelegatedRequest(
		engine,
		root,
		workflowId,
		adapter,
	);
	// A baseline ref git can no longer resolve: the touched-file report cannot
	// measure tracked changes at all.
	const db = openStore(root);
	try {
		db.query("UPDATE debug_requests SET baseline_ref=? WHERE id=?").run(
			"0000000000000000000000000000000000000000",
			requestId,
		);
	} finally {
		db.close();
	}
	const launch = claimDelegatedLaunch(engine, root, debugRunId);
	const run = engine.getRun(root, debugRunId);
	const outputPath = requireDefined(run.outputPath, "output path");
	writeArtifact(outputPath, debugRunId);
	engine.dispatch(root, {
		type: "agent.handoff",
		runId: debugRunId,
		generation: run.generation,
		token: requireDefined(launch.runToken, "run token"),
		outcome: "complete",
		artifact: outputPath,
	});
	const finished = requireDefined(
		engine.debugRequest(root, requestId),
		"finished request",
	);
	expect(finished.baselineUsable).toBe(false);
	expect(finished.changedFiles).toEqual([]);
	// The row says so, and so does the dashboard view the developer reads.
	const observed = loadDebugRequests(root, workflowId);
	expect(observed.requests[0]?.baseline).toBe("unavailable");
	const lines = debugRequestDetailLines(
		requireDefined(observed.requests[0], "observed request"),
	);
	expect(lines.join("\n")).toContain("baseline unavailable");
});

test("the observation serves only the report path this workflow's request owns", async () => {
	const root = createTempRepoFixture("debug-request-confine-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-confine";
	const engine = new WorkflowEngine(registerBuiltins());
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
	});
	// A row whose report path points outside the workflow's own data directory:
	// the store lives in the checkout, so its value is not trusted for a read.
	const outside = path.join(root, "..", "outside-secret.txt");
	fs.writeFileSync(outside, "not this workflow's report\n");
	const db = openStore(root);
	try {
		db.query(
			"UPDATE debug_requests SET status='done', report_path=?, finished_at=? WHERE id=?",
		).run(outside, new Date().toISOString(), created.request.id);
	} finally {
		db.close();
	}
	const observed = loadDebugRequests(root, workflowId);
	const request = requireDefined(observed.requests[0], "observed request");
	expect(request.report).toBeUndefined();
	expect(request.reportPath).toBeUndefined();
	// The derivation itself refuses an id the store could not have written.
	expect(() =>
		debugRequestReportPathFor(root, root, workflowId, "../../etc/passwd"),
	).toThrow(/invalid debug request id/);
	fs.rmSync(outside, { force: true });
});

test("the dashboard opener refuses a report path outside the workflow", () => {
	const state = {
		workflowId: "debug-request-opener",
		worktree: "/tmp/worktree",
		repository: "/tmp/repository",
	};
	const request = {
		id: "5b2f0a0e-6f2f-4a4e-9d3f-2f7a1b0c9d8e",
		reportPath: "/tmp/elsewhere/debug-report.md",
	};
	expect(() => debugRequestReportLocalPath(state, request)).toThrow(
		/outside this workflow/,
	);
	// The path the engine would have written is accepted.
	expect(
		debugRequestReportLocalPath(state, {
			...request,
			reportPath: debugRequestReportPathFor(
				state.repository,
				state.worktree,
				state.workflowId,
				request.id,
			),
		}),
	).toBe(
		debugRequestReportPathFor(
			state.repository,
			state.worktree,
			state.workflowId,
			request.id,
		),
	);
	// An id the store could not have written names no path at all.
	expect(() =>
		debugRequestReportLocalPath(state, {
			id: "../../etc",
			reportPath: undefined,
		}),
	).toThrow(/not a usable debug request id/);
});

test("the delegated debug request tools are withheld from a debug run", async () => {
	const names = debugRequestToolNames();
	expect(names).toEqual([
		"debug_request",
		"debug_result",
		"debug_wait",
		"debug_cancel",
	]);
	// A debug run's explicit selection is the same list minus exactly these.
	const offered = [
		{ name: "read" },
		...names.map((name) => ({ name })),
		{ name: "grep" },
	];
	expect(withoutDebugRequestTools(offered).map((tool) => tool.name)).toEqual([
		"read",
		"grep",
	]);
	const extension = createDebugRequestExtension(() => ({
		runId: "run-1",
		cwd: process.cwd(),
		env: {},
	}));
	expect(extension.tools?.map((tool) => tool.name).sort()).toEqual(
		[...names].sort(),
	);
});

test("the CLI exposes the four delegated debug request commands", () => {
	expect(SUBCOMMANDS).toContain("debug-request");
	expect(SUBCOMMANDS).toContain("debug-result");
	expect(SUBCOMMANDS).toContain("debug-wait");
	expect(SUBCOMMANDS).toContain("debug-cancel");
	expect(REQUIRED_FLAGS["debug-request"]).toEqual(["goal"]);
	expect(REQUIRED_FLAGS["debug-result"]).toEqual(["request-id"]);
	expect(REQUIRED_FLAGS["debug-wait"]).toEqual(["request-id"]);
	expect(REQUIRED_FLAGS["debug-cancel"]).toEqual(["request-id"]);
	// The flag schema rejects an unknown flag and a missing value, and accepts
	// the documented shapes.
	expect(() =>
		validateArgs("debug-request", ["--goal", "probe the empty result"]),
	).not.toThrow();
	expect(() =>
		validateArgs("debug-wait", ["--request-id", "r1", "--timeout-sec", "60"]),
	).not.toThrow();
	expect(() => validateArgs("debug-request", ["--nope"])).toThrow(
		/unknown flag/,
	);
	expect(() => validateArgs("debug-request", ["--goal"])).toThrow(
		/requires a value/,
	);
	expect(() => required("debug-request", [])).toThrow(/--goal is required/);
});

test("every debug request tool calls the workflow CLI with the documented argv", async () => {
	const shim = installAgenticCodingShim();
	try {
		const extension = createDebugRequestExtension(() => ({
			runId: "run-1",
			cwd: process.cwd(),
			env: {},
		}));
		const tools = new Map(
			(extension.tools ?? []).map((tool) => [tool.name, tool]),
		);
		const invoke = (name: string, args: unknown) => {
			const tool = requireDefined(tools.get(name), `${name} tool`);
			return tool.execute(
				args as never,
				{ conversationId: 1 } as never,
				undefined as never,
			);
		};
		const request = await invoke("debug_request", {
			goal: "reproduce it",
			context: "on empty input",
			apps: ["app", "api"],
		});
		expect(
			(request.output?.[0] as { text: string } | undefined)?.text,
		).toContain("shim: workflow debug-request");
		await invoke("debug_result", { requestId: "request-1" });
		await invoke("debug_wait", { requestId: "request-1", timeoutSec: 300 });
		await invoke("debug_cancel", { requestId: "request-1" });
		const calls = fs.readFileSync(shim.log, "utf8");
		expect(calls).toContain(
			"workflow debug-request --goal reproduce it --context on empty input --apps app,api",
		);
		expect(calls).toContain("workflow debug-result --request-id request-1");
		expect(calls).toContain(
			"workflow debug-wait --request-id request-1 --timeout-sec 300",
		);
		expect(calls).toContain("workflow debug-cancel --request-id request-1");
	} finally {
		shim.restore();
	}
});

test("the requests view model renders one row and one detail per request", () => {
	expect(
		debugRequestRowLabel({
			id: "request-1",
			status: "done",
			callerRole: "worker",
			callerRunId: "run-1",
			goal: "reproduce the empty result\nand say why",
			createdAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:04:12.000Z",
			durationSeconds: 252,
			changedFiles: ["probe.txt"],
			baseline: "usable",
			delivered: true,
			evidence: [],
		}),
	).toBe("✓ done · worker · 4m · reproduce the empty result");
	const lines = debugRequestDetailLines({
		id: "request-1",
		status: "done",
		callerRole: "worker",
		callerRunId: "run-1",
		goal: "reproduce the empty result",
		createdAt: "2026-01-01T00:00:00.000Z",
		durationSeconds: 12,
		changedFiles: ["probe.txt"],
		baseline: "usable",
		delivered: true,
		report: "# Summary\n\nit is empty",
		evidence: [
			{
				id: "01H",
				kind: "screenshot",
				file: "req-request-1/01H.png",
				caption: "empty list",
				createdAt: "2026-01-01T00:01:00.000Z",
			},
		],
	});
	expect(lines).toContain("  probe.txt");
	expect(
		lines.some((line) => line.includes("01H · screenshot · empty list")),
	).toBe(true);
	expect(lines).toContain("it is empty");
	// The window is clamped, so a refresh that shortens the detail never scrolls
	// past its own end.
	expect(debugRequestWindow(["a", "b", "c", "d"], 99, 2)).toEqual({
		start: 2,
		visible: ["c", "d"],
	});
	expect(debugRequestWindow(["a", "b"], -5, 2).visible).toEqual(["a", "b"]);
	// The list window always contains the selection, however long the history is.
	const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);
	expect(debugRequestListWindow(rows, 0, 4)).toEqual(rows.slice(0, 4));
	expect(debugRequestListWindow(rows, 19, 4)).toEqual(rows.slice(16));
	expect(debugRequestListWindow(rows, 10, 4)).toContain("row-10");
	expect(debugRequestListWindow(rows, 10, 4).length).toBe(4);
});

test("the debug requests dialog offers navigation and opening only", () => {
	// The dialog's whole key surface is one pure function: every key it accepts
	// maps to a navigation, scroll, open or close action — never to a mutation.
	const allowed = new Set(["close", "select", "scroll", "open", "none"]);
	const state = { selection: 1, offset: 0, count: 3 };
	for (const key of [
		...Array.from("abcdefghijklmnopqrstuvwxyz"),
		...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
		"escape",
		"enter",
		"return",
		"up",
		"down",
		"space",
		"tab",
	])
		for (const shift of [false, true])
			expect(
				allowed.has(debugRequestsKeyAction({ name: key, shift }, state).kind),
			).toBe(true);
	// The declared footer/help entries are exactly those keys.
	expect(DEBUG_REQUESTS_HELP.map((entry) => entry.key)).toEqual([
		"j/k",
		"J/K",
		"Enter",
		"Esc",
	]);
	const sections = dashboardDetailKeybindCatalog({ artifactsVisible: true });
	const global = sections.find((section) => section.title === "Global");
	const entry = global?.keybinds.find((keybind) => keybind.key === "d");
	expect(entry?.action).toBe("Show delegated debug requests");
	expect(entry?.short).toBe("debug");
});

test("a shifted j/k scrolls the report while the bare pair moves the selection", () => {
	const state = { selection: 1, offset: 0, count: 3 };
	// A shifted letter arrives as `name: "j"` with `shift: true`: the modifier
	// has to win over the bare key, or the footer's `J/K` is a dead key.
	expect(debugRequestsKeyAction({ name: "j", shift: true }, state)).toEqual({
		kind: "scroll",
		offset: 1,
	});
	expect(
		debugRequestsKeyAction({ name: "k", shift: true }, { ...state, offset: 2 }),
	).toEqual({ kind: "scroll", offset: 1 });
	expect(debugRequestsKeyAction({ name: "k", shift: true }, state)).toEqual({
		kind: "scroll",
		offset: 0,
	});
	expect(debugRequestsKeyAction({ name: "j" }, state)).toEqual({
		kind: "select",
		index: 2,
	});
	expect(debugRequestsKeyAction({ name: "k" }, state)).toEqual({
		kind: "select",
		index: 0,
	});
	// The selection never leaves the list.
	expect(
		debugRequestsKeyAction({ name: "j" }, { ...state, selection: 2 }),
	).toEqual({ kind: "select", index: 2 });
	expect(debugRequestsKeyAction({ name: "escape" }, state)).toEqual({
		kind: "close",
	});
	expect(debugRequestsKeyAction({ name: "enter" }, state)).toEqual({
		kind: "open",
	});
	expect(debugRequestsKeyAction({ name: "x" }, state)).toEqual({
		kind: "none",
	});
});

test("the debug request observation serves the request, its report and its evidence", async () => {
	const root = createTempRepoFixture("debug-request-observation-", {
		files: { "README.md": "test\n" },
		excludeWorkflowState: true,
	});
	const workflowId = "debug-request-observation";
	const engine = new WorkflowEngine(registerBuiltins());
	const caller = await startCaller(engine, root, workflowId);
	const created = engine.requestDebugRun(root, {
		workflowId,
		callerRunId: caller.runId,
		callerRole: "worker",
		goal: "reproduce the empty result",
	});
	const observed = loadDebugRequests(root, workflowId);
	expect(observed.workflowId).toBe(workflowId);
	expect(observed.requests.map((request) => request.id)).toEqual([
		created.request.id,
	]);
	const [first] = observed.requests;
	expect(first?.status).toBe("queued");
	expect(first?.goal).toBe("reproduce the empty result");
	expect(first?.callerRole).toBe("worker");
	expect(first?.evidence).toEqual([]);
	expect(first?.delivered).toBe(false);
	// The lifecycle effect has not run, so no baseline was taken yet.
	expect(first?.baseline).toBe("unavailable");
});

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import type { AgentAdapter } from "../src/workflow/adapters.ts";
import type {
	AgentHandle,
	ResolvedProfile,
} from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { agentEffectHandlers } from "../src/workflow/effect-runner.ts";
import { runtimeTest, WorkflowEngine } from "../src/workflow/runtime.ts";

function repository(root: string): string {
	fs.mkdirSync(root, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	fs.writeFileSync(path.join(root, "README.md"), "test\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			"commit",
			"-qm",
			"base",
		],
		{ cwd: root },
	);
	return root;
}

const profile: ResolvedProfile = {
	name: "test",
	runtime: "pi",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "profile",
};

type Engine = WorkflowEngine;
type Claims = ReturnType<WorkflowEngine["claimEffects"]>;

class CapturingAdapter implements AgentAdapter {
	readonly id = "pi" as const;
	prompts: string[] = [];
	preflight() {}
	launch() {
		return Effect.die("launch is not used by this test");
	}
	prompt(_handle: AgentHandle, message: string) {
		this.prompts.push(message);
		return Effect.void;
	}
	observe(handle: AgentHandle) {
		return Effect.succeed({ status: "idle" as const, paneId: handle.paneId });
	}
	stop() {
		return Effect.void;
	}
}

function completeClaims(engine: Engine, repo: string, claims: Claims): void {
	for (const effect of claims) {
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: effect.id,
			lease: effect.lease,
			outcome: "complete",
			data:
				effect.kind === "agent.launch"
					? {
							runtime: "pi",
							name: `agent-${effect.id}`,
							paneId: `pane-${effect.id}`,
						}
					: {},
		});
	}
}

function setup() {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "workflow-agent-consult-"),
	);
	const repo = repository(root);
	const time = new Date("2026-01-01T00:00:00Z");
	const engine = new WorkflowEngine(registerBuiltins(), () => time);
	const workflowId = "consult";
	engine.start({
		repo,
		workflowId,
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "do work",
		},
		routing: {
			defaultProfile: "test",
			routes: [
				{ stepId: "core.implementation", role: "worker", profile },
				{ stepId: "core.triage", role: "triage", profile },
			],
		},
	});
	const workerView = engine
		.status(repo, workflowId)
		.runs.find((run) => run.role === "worker");
	if (!workerView?.outputPath) throw new Error("worker run missing");
	const worker = engine.getRun(repo, workerView.id);
	if (!worker.outputPath) throw new Error("worker output path missing");
	const workerOutput = worker.outputPath;
	const initial = engine.claimEffects(repo);
	const workerLaunch = initial.find(
		(effect) =>
			effect.kind === "agent.launch" &&
			(effect.payload as { runId?: string }).runId === worker.id,
	);
	if (!workerLaunch?.runToken) throw new Error("worker capability missing");
	completeClaims(engine, repo, initial);
	fs.mkdirSync(path.dirname(workerOutput), { recursive: true });
	fs.writeFileSync(
		workerOutput,
		JSON.stringify({
			runId: worker.id,
			schemaId: worker.outputSchema?.id,
			schemaVersion: worker.outputSchema?.version,
			payload: { done: true },
		}),
	);
	const handedOff = engine.dispatch(repo, {
		type: "agent.handoff",
		runId: worker.id,
		generation: worker.generation,
		token: workerLaunch.runToken,
		outcome: "complete",
		artifact: workerOutput,
	});
	if (handedOff.view.currentStep.id !== "core.triage")
		throw new Error("workflow did not advance to triage");
	const triageView = handedOff.view.runs.find((run) => run.role === "triage");
	if (!triageView) throw new Error("triage run missing");
	const triage = engine.getRun(repo, triageView.id);
	const triageClaims = engine.claimEffects(repo);
	const triageLaunch = triageClaims.find(
		(effect) =>
			effect.kind === "agent.launch" &&
			(effect.payload as { runId?: string }).runId === triage.id,
	);
	if (!triageLaunch?.runToken) throw new Error("triage capability missing");
	completeClaims(engine, repo, triageClaims);
	return {
		repo,
		engine,
		workflowId,
		worker,
		triage,
		triageToken: triageLaunch.runToken,
	};
}

test("agent asks a completed peer and the peer answer unblocks the record", () => {
	const { repo, engine, workflowId, worker, triage, triageToken } = setup();
	try {
		const asked = engine.dispatch(repo, {
			type: "agent.ask",
			workflowId,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
			targetRole: "worker",
			description: "Which module owns the question reducer?",
			context: "The worker just implemented it.",
			options: [{ label: "reducers", value: "reducers" }],
		});
		expect(asked.snapshot.status).toBe("active");
		const question = asked.snapshot.developerDialogue.at(-1);
		if (!question) throw new Error("question missing");
		expect(question.targetRole).toBe("worker");
		expect(question.targetRunId).toBe(worker.id);
		expect(question.status).toBe("pending");
		// Peer questions never open the developer modal.
		expect(
			engine
				.status(repo, workflowId)
				.pendingQuestions?.some((item) => item.id === question.id),
		).toBe(false);

		const claimed = engine.claimEffects(repo);
		const prompt = claimed.find((effect) => effect.kind === "agent.prompt");
		expect(prompt).toBeDefined();
		if (!prompt) throw new Error("prompt missing");
		const payload = prompt.payload as {
			runId?: string;
			questionId?: unknown;
			message?: unknown;
		};
		expect(payload.runId).toBe(worker.id);
		expect(payload.questionId).toBe(question.id);
		// The one-shot nonce must never rest in the durable outbox payload.
		expect(payload.message).toBeUndefined();
		expect(JSON.stringify(payload)).not.toContain("nonce");
		const nonce = "test-answer-nonce";
		// Simulate the prompt handler's delivery result: it mints the nonce and
		// reports only its hash.
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: prompt.id,
			lease: prompt.lease,
			outcome: "complete",
			data: { prompted: true, answerNonceHash: runtimeTest.hashToken(nonce) },
		});

		const answered = engine.dispatch(repo, {
			type: "agent.answer",
			workflowId,
			runId: worker.id,
			stepId: "core.implementation",
			role: "worker",
			questionId: question.id,
			answerNonce: nonce,
			answer: "runtime/reducers/agent-consult.ts",
		});
		const record = answered.snapshot.developerDialogue.find(
			(item) => item.id === question.id,
		);
		expect(record?.status).toBe("answered");
		expect(record?.answer).toEqual({
			kind: "custom",
			value: "runtime/reducers/agent-consult.ts",
		});
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("only a completed peer role with a live session is consultable", () => {
	const { repo, engine, workflowId, triage, triageToken } = setup();
	try {
		expect(() =>
			engine.dispatch(repo, {
				type: "agent.ask",
				workflowId,
				runId: triage.id,
				stepId: "core.triage",
				role: "triage",
				token: triageToken,
				targetRole: "security-verifier",
				description: "unreachable",
			}),
		).toThrow(/no completed agent/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a peer answer requires the addressed run and its one-shot nonce", () => {
	const { repo, engine, workflowId, worker, triage, triageToken } = setup();
	try {
		const asked = engine.dispatch(repo, {
			type: "agent.ask",
			workflowId,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
			targetRole: "worker",
			description: "clarify",
		});
		const question = asked.snapshot.developerDialogue.at(-1);
		if (!question) throw new Error("question missing");
		const base = {
			type: "agent.answer" as const,
			workflowId,
			runId: worker.id,
			stepId: "core.implementation",
			role: "worker",
			questionId: question.id,
			answerNonce: "forged",
			answer: "nope",
		};
		expect(() => engine.dispatch(repo, base)).toThrow(/capability/);
		expect(() =>
			engine.dispatch(repo, {
				...base,
				runId: triage.id,
				stepId: "core.triage",
				role: "triage",
			}),
		).toThrow(/not addressed|identity/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a failed peer prompt expires the question without parking the workflow", () => {
	const { repo, engine, workflowId, triage, triageToken } = setup();
	try {
		const asked = engine.dispatch(repo, {
			type: "agent.ask",
			workflowId,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
			targetRole: "worker",
			description: "will fail",
		});
		const question = asked.snapshot.developerDialogue.at(-1);
		if (!question) throw new Error("question missing");
		const claimed = engine.claimEffects(repo);
		const prompt = claimed.find((effect) => effect.kind === "agent.prompt");
		if (!prompt) throw new Error("prompt missing");
		const failed = engine.dispatch(repo, {
			type: "effect.result",
			effectId: prompt.id,
			lease: prompt.lease,
			outcome: "failed",
			data: "peer session is gone",
		});
		expect(failed.snapshot.status).toBe("active");
		expect(
			failed.snapshot.developerDialogue.find((item) => item.id === question.id)
				?.status,
		).toBe("expired");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a resolved peer question never aborts effect claiming", () => {
	const { repo, engine, workflowId, triage, triageToken } = setup();
	try {
		const asked = engine.dispatch(repo, {
			type: "agent.ask",
			workflowId,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
			targetRole: "worker",
			description: "resolve before delivery",
		});
		const question = asked.snapshot.developerDialogue.at(-1);
		if (!question) throw new Error("question missing");
		// The asker resolves the question before its prompt row drains; the
		// lingering row must stay claimable instead of poisoning every claim.
		engine.dispatch(repo, {
			type: "agent.question-expire",
			workflowId,
			questionId: question.id,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
		});
		expect(
			engine
				.getSnapshot(repo, workflowId)
				.developerDialogue.find((item) => item.id === question.id)?.status,
		).toBe("expired");
		const claims = engine.claimEffects(repo);
		const prompt = claims.find((effect) => effect.kind === "agent.prompt");
		expect(prompt).toBeDefined();
		// The handler no-ops on a resolved record rather than prompting the peer.
		const completed = engine.dispatch(repo, {
			type: "effect.result",
			effectId: prompt?.id ?? "",
			lease: prompt?.lease ?? "",
			outcome: "complete",
			data: { prompted: false, resolved: true },
		});
		expect(completed.snapshot.status).toBe("active");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("the prompt handler mints the peer nonce outside the durable store", async () => {
	const { repo, engine, workflowId, worker, triage, triageToken } = setup();
	try {
		const asked = engine.dispatch(repo, {
			type: "agent.ask",
			workflowId,
			runId: triage.id,
			stepId: "core.triage",
			role: "triage",
			token: triageToken,
			targetRole: "worker",
			description: "which file owns this?",
		});
		const question = asked.snapshot.developerDialogue.at(-1);
		if (!question) throw new Error("question missing");
		const prompt = engine
			.claimEffects(repo)
			.find((effect) => effect.kind === "agent.prompt");
		if (!prompt) throw new Error("prompt missing");
		const adapter = new CapturingAdapter();
		const handlers = agentEffectHandlers(repo, engine, {
			registry: registerBuiltins(),
			adapters: new Map([["pi", adapter]]),
			herdr: {
				call() {
					throw new Error("herdr is not used by this test");
				},
			},
			async paneForRun() {
				return { paneId: "pane", owned: true };
			},
		});
		const result = (await Effect.runPromise(
			handlers["agent.prompt"]?.execute(prompt, undefined) as Effect.Effect<
				unknown,
				Error
			>,
		)) as { answerNonceHash?: string };
		expect(result.answerNonceHash).toBeTruthy();
		expect(adapter.prompts).toHaveLength(1);
		const nonce = /--nonce (\S+)/.exec(adapter.prompts[0] ?? "")?.[1];
		expect(nonce).toBeTruthy();
		// Only the hash crosses into durable state.
		engine.dispatch(repo, {
			type: "effect.result",
			effectId: prompt.id,
			lease: prompt.lease,
			outcome: "complete",
			data: result,
		});
		expect(
			engine
				.getSnapshot(repo, workflowId)
				.developerDialogue.find((item) => item.id === question.id)
				?.answerNonceHash,
		).toBe(result.answerNonceHash);
		const answered = engine.dispatch(repo, {
			type: "agent.answer",
			workflowId,
			runId: worker.id,
			stepId: "core.implementation",
			role: "worker",
			questionId: question.id,
			answerNonce: nonce ?? "",
			answer: "handler path",
		});
		expect(
			answered.snapshot.developerDialogue.find(
				(item) => item.id === question.id,
			)?.status,
		).toBe("answered");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

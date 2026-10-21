import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import {
	type AgentHandle,
	decodeCommand,
	decodeDeveloperQuestionAnswer,
	type ResolvedProfile,
} from "../src/contracts/workflow.ts";
import { workflowLoginHandoffAttention } from "../src/server/browser/attention.ts";
import type { AgentAdapter, LaunchContext } from "../src/workflow/adapters.ts";
import { decodeSnapshot } from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	agentEffectHandlers,
	EffectRunner,
} from "../src/workflow/effect-runner.ts";
import {
	MAX_DEVELOPER_DIALOGUE_RECORDS,
	questionRecordCount,
} from "../src/workflow/runtime/dialogue.ts";
import { QUESTION_WAIT_MS, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

function requireDefined<T>(value: T | null | undefined, what: string): T {
	if (value === undefined || value === null)
		throw new Error(`expected ${what} to exist`);
	return value;
}

function repository(root: string): string {
	return createRepoFixture(root, repoPreset.readme);
}
const profile: ResolvedProfile = {
	name: "test",
	runtime: "pi-durable",
	executable: process.execPath,
	tools: [],
	extensions: [],
	readOnly: false,
	capabilities: ["prompt", "run-environment", "observe"],
	digest: "profile",
};

/** A launch that succeeds without a host, so the assignment render path runs
 * and the resumed attempt's prior dialogue can be read from disk. */
class StubAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	launch(ctx: LaunchContext) {
		return Effect.succeed({
			runtime: "pi-durable" as const,
			name: ctx.name,
			hostSocket: "/tmp/question-host.sock",
			sessionId: ctx.assignment.runId,
		});
	}
	preflight() {}
	prompt() {
		return Effect.void;
	}
	observe(_handle: AgentHandle) {
		return Effect.succeed({ status: "working" as const });
	}
	stop() {
		return Effect.void;
	}
}

/** Render the assignment of every pending run through the runner's own path. */
async function drainAssignments(repo: string, engine: WorkflowEngine) {
	const handlers = agentEffectHandlers(repo, engine, {
		registry: registerBuiltins(),
		adapters: new Map([["pi-durable", new StubAdapter()]]),
	});
	await new EffectRunner(repo, engine, handlers).drain();
}

function setup(options: { startedBy?: "developer" | "orchestrator" } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-question-"));
	const repo = repository(root);
	let time = new Date("2026-01-01T00:00:00Z");
	const engine = new WorkflowEngine(registerBuiltins(), () => time);
	const started = engine.start({
		repo,
		workflowId: "question",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "do work",
			...(options.startedBy ? { startedBy: options.startedBy } : {}),
		},
		routing: {
			defaultProfile: "test",
			routes: [{ stepId: "core.implementation", role: "worker", profile }],
		},
	});
	const run = engine.getRun(repo, started.view.runs[0]?.id ?? "");
	const launch = engine
		.claimEffects(repo)
		.find((effect) => effect.kind === "agent.launch");
	if (!launch?.runToken || !launch.lease)
		throw new Error("launch capability missing");
	engine.dispatch(repo, {
		type: "effect.result",
		effectId: launch.id,
		lease: launch.lease,
		outcome: "complete",
		data: { runtime: "pi-durable", name: "worker", paneId: "pane" },
	});
	return {
		repo,
		engine,
		run,
		token: launch.runToken,
		now: (value: Date) => (time = value),
	};
}

test("question contracts accept legacy snapshots and reject invalid answers", () => {
	const snapshot = decodeSnapshot({
		schemaVersion: 1,
		workflowId: "w",
		revision: 0,
		definition: { id: "no-openspec", version: 1, digest: "d" },
		status: "active",
		currentStep: "core.implementation",
		step: {
			attempt: 1,
			activeRunIds: [],
			completedRunIds: [],
			selectedRoles: [],
			testRunStarted: false,
			results: [],
		},
		metadata: {
			repository: ".",
			worktree: ".",
			workflowId: "c",
			branch: "main",
			baseBranch: "main",
			baseCommit: "x",
			createdAt: "x",
			updatedAt: "x",
			stepEnteredAt: "x",
		},
		routing: { defaultProfile: "x", routes: [] },
		evidence: [],
		loopCounts: {},
		attention: [],
		// State written by an earlier schema of this feature may carry more than
		// one recommendation; persisted-record decode must stay permissive so
		// that state can still be loaded, answered, and repaired.
		developerDialogue: [
			{
				id: "legacy-question",
				workflowId: "w",
				runId: "r",
				stepId: "core.implementation",
				role: "worker",
				description: "legacy question",
				options: [
					{ label: "A", value: "a", recommended: true },
					{ label: "B", value: "b", recommended: true },
				],
				status: "pending",
				createdAt: "x",
				expiresAt: "2099-01-01T00:00:00.000Z",
			},
		],
	});
	expect(snapshot.developerDialogue).toHaveLength(1);
	expect(snapshot.developerDialogue[0]?.options).toHaveLength(2);
	expect(() =>
		decodeCommand({
			type: "agent.question",
			workflowId: "w",
			runId: "r",
			stepId: "core.implementation",
			role: "worker",
			token: "t",
			description: "choose",
			options: [
				{ label: "A", value: "a" },
				{ label: "A", value: "a" },
			],
		}),
	).toThrow();
});

test("questionnaire contracts preserve order and require complete response sets", () => {
	const command = decodeCommand({
		type: "agent.question",
		workflowId: "w",
		runId: "r",
		stepId: "core.implementation",
		role: "worker",
		token: "t",
		questions: [
			{
				description: "first",
				context: "evidence",
				options: [{ label: "A", value: "a" }],
			},
			{ description: "second", options: [] },
		],
	});
	expect(command.type).toBe("agent.question");
	if (command.type !== "agent.question") throw new Error("wrong command");
	expect(command.questions?.map((item) => item.description)).toEqual([
		"first",
		"second",
	]);
	expect(
		decodeDeveloperQuestionAnswer({
			groupId: "g",
			responses: [
				{ questionId: "a", kind: "option", value: "a" },
				{ questionId: "b", kind: "custom", value: "line 1\nline 2" },
			],
		}),
	).toEqual({
		groupId: "g",
		responses: [
			{ questionId: "a", kind: "option", value: "a" },
			{ questionId: "b", kind: "custom", value: "line 1\nline 2" },
		],
	});
	expect(() =>
		decodeCommand({
			type: "agent.question",
			workflowId: "w",
			runId: "r",
			stepId: "core.implementation",
			role: "worker",
			token: "t",
			description: "ambiguous",
			questions: [{ description: "also present" }],
		}),
	).toThrow(/either description or questions/);
});

test("questionnaires persist and answer all items atomically", () => {
	const { repo, engine, run, token } = setup();
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			questions: [
				{ description: "format", options: [{ label: "JSON", value: "json" }] },
				{ description: "notes", options: [] },
			],
		});
		const items = created.snapshot.developerDialogue;
		expect(items).toHaveLength(2);
		const groupId = items[0]?.groupId;
		if (!groupId || !items[1]?.id)
			throw new Error("questionnaire metadata missing");
		expect(items.map((item) => item.itemIndex)).toEqual([0, 1]);
		const beforeInvalid = engine.getSnapshot(repo, run.workflowId);
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: created.snapshot.revision,
				actionId: "answer-question",
				input: {
					groupId,
					responses: [
						{ questionId: items[0]?.id, kind: "option", value: "json" },
					],
				},
			}),
		).toThrow(/every item/);
		expect(engine.getSnapshot(repo, run.workflowId).revision).toBe(
			beforeInvalid.revision,
		);
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: created.snapshot.revision,
			actionId: "answer-question",
			input: {
				groupId,
				responses: [
					{ questionId: items[0]?.id, kind: "option", value: "json" },
					{
						questionId: items[1]?.id,
						kind: "custom",
						value: "line 1\nline 2",
					},
				],
			},
		});
		expect(answered.view.pendingQuestions).toHaveLength(0);
		expect(
			answered.view.developerDialogue?.map((item) => item.answer?.value),
		).toEqual(["json", "line 1\nline 2"]);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("rich question items normalize ident, question, context, and option metadata", () => {
	const { repo, engine, run, token } = setup();
	try {
		const created = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			questions: [
				{
					ident: "scope",
					question: "Which scope?",
					context: "## Background\n\nEvidence.",
					options: [
						{
							title: "Narrow",
							value: "narrow",
							recommended: true,
							description: "**Narrow** keeps it small.",
						},
						{ title: "Wide" },
					],
				},
			],
		});
		const item = created.snapshot.developerDialogue[0];
		expect(item?.ident).toBe("scope");
		expect(item?.description).toBe("Which scope?");
		expect(item?.context).toContain("Background");
		expect(item?.options).toEqual([
			{
				label: "Narrow",
				value: "narrow",
				recommended: true,
				description: "**Narrow** keeps it small.",
			},
			{ label: "Wide", value: "Wide" },
		]);
		expect(() =>
			decodeCommand({
				type: "agent.question",
				workflowId: "w",
				runId: "r",
				stepId: "core.implementation",
				role: "worker",
				token: "t",
				description: "choose",
				options: [{ recommended: true }],
			}),
		).toThrow();
		expect(() =>
			decodeCommand({
				type: "agent.question",
				workflowId: "w",
				runId: "r",
				stepId: "core.implementation",
				role: "worker",
				token: "t",
				description: "choose",
				options: [
					{ title: "A", value: "a", recommended: true },
					{ title: "B", value: "b", recommended: true },
				],
			}),
		).toThrow(/at most one recommended/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("an answer that would overflow the dialogue bound is rejected without losing the question", () => {
	const { repo, engine, run, token } = setup();
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		// Max-size questions stay under the create-time bound; max-size custom
		// answers then push the aggregate past it, which must fail with an
		// actionable diagnostic instead of the opaque snapshot-decode rollback.
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			questions: Array.from({ length: 8 }, (_, index) => ({
				ident: `q${index}`,
				question: "q".repeat(4096),
				context: "c".repeat(4096),
				options: [],
			})),
		});
		const groupId = created.snapshot.developerDialogue[0]?.groupId;
		if (!groupId) throw new Error("questionnaire metadata missing");
		const before = engine.getSnapshot(repo, run.workflowId);
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: created.snapshot.revision,
				actionId: "answer-question",
				input: {
					groupId,
					responses: created.snapshot.developerDialogue.map((item) => ({
						questionId: item.id,
						kind: "custom" as const,
						value: "y".repeat(8000),
					})),
				},
			}),
		).toThrow(/content limit/);
		expect(engine.getSnapshot(repo, run.workflowId).revision).toBe(
			before.revision,
		);
		expect(engine.status(repo, "question").pendingQuestions).toHaveLength(8);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("questions persist, answer in FIFO order, and do not change workflow lifecycle", () => {
	const { repo, engine, run, token } = setup();
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const first = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "first decision",
			options: [{ label: "Use A", value: "a" }],
		});
		const second = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "second decision",
			options: [],
		});
		expect(first.snapshot.status).toBe("active");
		expect(
			engine.status(repo, "question").pendingQuestions?.map((item) => item.id),
		).toEqual([
			first.snapshot.developerDialogue[0]?.id,
			second.snapshot.developerDialogue[1]?.id,
		]);
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: second.snapshot.revision,
			actionId: "answer-question",
			input: {
				questionId: first.snapshot.developerDialogue[0]?.id,
				kind: "option",
				value: "a",
			},
		});
		expect(answered.view.pendingQuestions?.[0]?.description).toBe(
			"second decision",
		);
		expect(answered.view.developerDialogue?.[0]?.answer?.value).toBe("a");
		expect(answered.view.status).toBe("active");
		// The asking run never handed off `blocked`, so answering adds no run: the
		// resume path is only for a parked asker.
		expect(
			answered.view.runs.filter((candidate) => candidate.role === "worker"),
		).toHaveLength(1);
		const reloaded = new WorkflowEngine(registerBuiltins()).status(
			repo,
			"question",
		);
		expect(reloaded.developerDialogue?.[0]?.answer?.value).toBe("a");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("question capability rejects another run and expires after 24 hours", () => {
	const { repo, engine, run, token, now } = setup();
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "need guidance",
			options: [],
		});
		const question = created.snapshot.developerDialogue[0];
		const questionId = question?.id;
		const timerNonce = question?.timerNonce;
		if (!questionId || !timerNonce) throw new Error("question data missing");
		expect(question?.expiresAt).toBe(
			new Date(
				new Date("2026-01-01T00:00:00Z").getTime() + QUESTION_WAIT_MS,
			).toISOString(),
		);
		now(new Date("2026-01-01T23:59:59.999Z"));
		expect(engine.status(repo, "question").pendingQuestions).toHaveLength(1);
		now(new Date("2026-01-02T00:00:00.000Z"));
		const observedView = engine.status(repo, "question");
		expect(observedView.pendingQuestions).toHaveLength(0);
		expect(observedView.revision).toBe(created.snapshot.revision);
		expect(observedView.developerDialogue?.[0]?.status).toBe("pending");
		const expired = engine.dispatch(repo, {
			type: "timer.question-expire",
			workflowId: run.workflowId,
			questionId,
			timerNonce,
		});
		expect(expired.view.developerDialogue?.[0]?.status).toBe("expired");
		const expiredView = expired.view;
		expect(() =>
			engine.dispatch(repo, {
				type: "agent.question",
				...identity,
				token: "wrong",
				description: "forged",
				options: [],
			}),
		).toThrow(/capability/);
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: expiredView.revision,
				actionId: "answer-question",
				input: { questionId, kind: "custom", value: "too late" },
			}),
		).toThrow(/no longer pending/);
		now(new Date("2026-01-01T23:59:59.999Z"));
		expect(() =>
			engine.dispatch(repo, {
				type: "agent.question-expire",
				...identity,
				questionId,
			}),
		).toThrow(/no longer pending/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a developer question opens a wait and the answer ends it", () => {
	const { repo, engine, run, token, now } = setup();
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const telemetry = () =>
			fs
				.readFileSync(
					path.join(repo, ".herdr-workflow", "question", "telemetry.jsonl"),
					"utf8",
				)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		const of = (event: string) =>
			telemetry().filter((envelope) => envelope.event === event);
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "which design?",
			options: [{ label: "A", value: "a" }],
		});
		const question = created.snapshot.developerDialogue[0];
		const questionId = question?.id;
		const timerNonce = question?.timerNonce;
		if (!questionId || !timerNonce) throw new Error("question missing");
		// The wait is the question: the developer owes an answer, and the view says
		// since when.
		expect(created.view.waiting).toEqual({
			kind: "question",
			subject: questionId,
			since: question.createdAt,
		});
		expect(of("workflow.waiting")).toHaveLength(1);
		expect(of("workflow.waiting")[0]?.["herdr.wait.kind"]).toBe("question");
		expect(of("workflow.waiting")[0]?.["herdr.wait.subject"]).toBe(questionId);
		// Reading the workflow is not progress: a poll records nothing.
		const polled = telemetry().length;
		engine.status(repo, "question");
		expect(telemetry()).toHaveLength(polled);
		// The answer ends the wait and says how long the developer took.
		now(new Date("2026-01-01T00:01:40Z"));
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: created.snapshot.revision,
			actionId: "answer-question",
			input: { questionId, kind: "option", value: "a" },
		});
		expect(answered.view.waiting).toBeUndefined();
		const ended = of("workflow.waiting.ended");
		expect(ended).toHaveLength(1);
		expect(ended[0]?.["herdr.wait.kind"]).toBe("question");
		expect(ended[0]?.["herdr.wait.subject"]).toBe(questionId);
		expect(ended[0]?.["herdr.wait.seconds"]).toBe(100);
		// An expiry ends the wait the same way, so a question nobody answers leaves
		// no open wait behind.
		const second = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "and now?",
			options: [],
		});
		const secondQuestion = second.snapshot.developerDialogue[1];
		if (!secondQuestion) throw new Error("second question missing");
		expect(second.view.waiting?.subject).toBe(secondQuestion.id);
		// Past the durable expiry the timer owns, the record may be expired.
		now(new Date(Date.parse(secondQuestion.expiresAt) + 1_000));
		const expired = engine.dispatch(repo, {
			type: "timer.question-expire",
			workflowId: run.workflowId,
			questionId: secondQuestion.id,
			timerNonce: requireDefined(secondQuestion.timerNonce, "timer nonce"),
		});
		expect(expired.view.waiting).toBeUndefined();
		expect(of("workflow.waiting.ended")).toHaveLength(2);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("orchestrator-started workflows route questions to the orchestrator first", () => {
	const { repo, engine, run, token } = setup({ startedBy: "orchestrator" });
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "which design?",
			options: [{ label: "A", value: "a" }],
		});
		const question = created.snapshot.developerDialogue[0];
		const questionId = question?.id;
		if (!questionId) throw new Error("question missing");
		// Routed to the orchestrator: it sees the question, and the developer's
		// pending set lists it too so an idle orchestrator cannot strand the
		// workflow (make-developer-questions-asynchronous).
		expect(question?.targetRole).toBe("orchestrator");
		const view = engine.status(repo, "question");
		expect(view.pendingQuestions?.map((item) => item.id)).toEqual([questionId]);
		expect(view.orchestratorQuestions?.map((item) => item.id)).toEqual([
			questionId,
		]);
		// The orchestrator answers it.
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: created.snapshot.revision,
			actionId: "answer-question",
			principal: "orchestrator",
			input: { questionId, kind: "option", value: "a" },
		});
		expect(answered.view.developerDialogue?.[0]?.status).toBe("answered");
		expect(answered.view.developerDialogue?.[0]?.answer?.value).toBe("a");
		expect(answered.view.orchestratorQuestions).toHaveLength(0);
		expect(answered.view.pendingQuestions).toHaveLength(0);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("the developer answers an orchestrator-routed question when the orchestrator does not act", () => {
	const { repo, engine, run, token } = setup({ startedBy: "orchestrator" });
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "which design?",
			options: [{ label: "A", value: "a" }],
		});
		const questionId = created.snapshot.developerDialogue[0]?.id;
		if (!questionId) throw new Error("question missing");
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: created.snapshot.revision,
			actionId: "answer-question",
			input: { questionId, kind: "custom", value: "do it" },
		});
		expect(answered.view.developerDialogue?.[0]?.status).toBe("answered");
		expect(answered.view.orchestratorQuestions).toHaveLength(0);
		// The routing marker is cleared in durable state, so nothing forwards a
		// question that is already answered.
		expect(
			engine.getSnapshot(repo, "question").developerDialogue[0]?.targetRole,
		).toBeUndefined();
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("the orchestrator cannot answer a developer-routed question", () => {
	const { repo, engine, run, token } = setup();
	try {
		const created = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which design?",
			options: [],
		});
		const questionId = created.snapshot.developerDialogue[0]?.id;
		if (!questionId) throw new Error("question missing");
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: created.snapshot.revision,
				actionId: "answer-question",
				principal: "orchestrator",
				input: { questionId, kind: "option", value: "a" },
			}),
		).toThrow(/another responder/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a stage_login hand-off is raised and resolved as workflow state, without routing or resuming anything", async () => {
	const { repo, engine, run, token } = setup({ startedBy: "orchestrator" });
	try {
		const opened = engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: "Log in to Grid integration as clerk",
			context: "stage grid-int, session web",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		expect(opened.view.status).toBe("active");
		const record = opened.view.developerDialogue?.find(
			(item) => item.id === "handoff-1",
		);
		expect(record?.kind).toBe("login-handoff");
		expect(record?.status).toBe("pending");
		expect(record?.options.map((option) => option.value)).toEqual([
			"done",
			"abort",
		]);
		// The developer's dashboard sees it, the orchestrator never does: a login
		// hand-off is answered by the person at the window, and an orchestrator
		// that tries anyway is refused like any other developer-routed question.
		expect(
			opened.view.pendingQuestions?.map((question) => question.id),
		).toContain("handoff-1");
		expect(opened.view.orchestratorQuestions ?? []).toEqual([]);
		expect(record?.targetRole).toBeUndefined();
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: opened.snapshot.revision,
				actionId: "answer-question",
				principal: "orchestrator",
				input: { questionId: "handoff-1", kind: "option", value: "done" },
			}),
		).toThrow(/another responder/);
		expect(opened.view.runs).toHaveLength(1);

		// The asking run is parked on a bounded blocker, exactly as a real hand-off
		// would leave it.
		const blocked = engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "waiting for the developer to log in",
		});
		expect(blocked.view.status).toBe("attention-required");

		const resolved = engine.dispatch(repo, {
			type: "login-handoff.resolve",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			answer: "done",
		});
		const answered = resolved.view.developerDialogue?.find(
			(item) => item.id === "handoff-1",
		);
		expect(answered?.status).toBe("answered");
		expect(answered?.answer?.value).toBe("done");
		expect(resolved.view.pendingQuestions ?? []).toEqual([]);
		// Nothing is resumed and no successor appears: the browser coordinator owns
		// the outcome, and the run stays parked until its own hand-off resumes it.
		expect(resolved.view.runs).toHaveLength(1);
		expect(
			resolved.view.runs.every((candidate) => candidate.status !== "pending"),
		).toBe(true);

		// Resolving the same record again is the same resolution, not a second one.
		const again = engine.dispatch(repo, {
			type: "login-handoff.resolve",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			answer: "abort",
		});
		const replayed = again.view.developerDialogue?.find(
			(item) => item.id === "handoff-1",
		);
		expect(replayed?.status).toBe("answered");
		expect(replayed?.answer?.value).toBe("done");

		// Re-opening the same record is a replay of the same hand-off: a restarted
		// server must not raise a second dialog.
		const reopened = engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			description: "Log in to Grid integration as clerk",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		expect(
			reopened.view.developerDialogue?.filter(
				(item) => item.id === "handoff-1",
			),
		).toHaveLength(1);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a hand-off whose ending is the server's own offers Abort alone, never a Done that cannot verify", () => {
	const { repo, engine, run } = setup();
	try {
		const opened = engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-code",
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: "Sign in to Grid integration as your own identity",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
			// A completion-driven login (the authorization code grant): its `ok` is the
			// server's own receiver, so a *Done* could only end it unverified
			// (USAB-207).
			canConfirm: false,
		});
		const record = opened.view.developerDialogue?.find(
			(item) => item.id === "handoff-code",
		);
		expect(record?.kind).toBe("login-handoff");
		expect(record?.options.map((option) => option.value)).toEqual(["abort"]);
		expect(record?.options[0]?.label).toBe("Abort");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a hand-off record expires on the question timer at its deadline, without resuming anything", () => {
	const { repo, engine, run, token, now } = setup();
	try {
		const opened = engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: "Log in to Grid integration as clerk",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		// The timer's capability is not part of the view; the snapshot keeps it.
		const record = opened.snapshot.developerDialogue.find(
			(item) => item.id === "handoff-1",
		);
		// The durable timer is the record's own: without a nonce the question
		// machinery would never expire it.
		expect(record?.timerNonce).toBeTruthy();
		const blocked = engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "waiting for the developer to log in",
		});
		// Someone else's timer cannot expire this record.
		expect(() =>
			engine.dispatch(repo, {
				type: "timer.question-expire",
				workflowId: run.workflowId,
				questionId: "handoff-1",
				timerNonce: "not-the-nonce",
			}),
		).toThrow(/timer capability/);
		now(new Date(Date.now() + 900_001));
		const expired = engine.dispatch(repo, {
			type: "timer.question-expire",
			workflowId: run.workflowId,
			questionId: "handoff-1",
			timerNonce: record?.timerNonce ?? "",
		});
		expect(
			expired.view.developerDialogue?.find((item) => item.id === "handoff-1")
				?.status,
		).toBe("expired");
		expect(expired.view.pendingQuestions ?? []).toEqual([]);
		// The parked run stays parked: the hand-off's own deadline, not the dialog,
		// is what ends the wait.
		expect(
			expired.view.runs.every((candidate) => candidate.status !== "pending"),
		).toBe(true);
		void blocked;
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a hand-off record takes Done or Abort and nothing else", () => {
	const { repo, engine, run } = setup();
	try {
		engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			description: "Log in to Grid integration as clerk",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		const view = engine.status(repo, run.workflowId);
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: view.revision,
				actionId: "answer-question",
				input: {
					questionId: "handoff-1",
					kind: "custom",
					value: "typed an answer the modal cannot produce",
				},
			}),
		).toThrow(/Done or Abort/);
		// A resolve of a record that is not a hand-off is refused by name.
		expect(() =>
			engine.dispatch(repo, {
				type: "login-handoff.resolve",
				workflowId: run.workflowId,
				recordId: "not-a-handoff",
				answer: "done",
			}),
		).toThrow(/not a login hand-off/);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("one dialogue record is readable on its own, and nothing else is", () => {
	const { repo, engine, run } = setup();
	try {
		engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-narrow",
			description: "Log in to Grid integration as clerk",
			context: "stage grid-int, app web, role clerk",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		// The narrow read is the one the coordinator's poll uses each tick: one
		// record, decoded on its own, instead of the run's whole snapshot.
		const record = engine.getDialogueRecord(
			repo,
			run.workflowId,
			"handoff-narrow",
		);
		expect(record?.kind).toBe("login-handoff");
		expect(record?.status).toBe("pending");
		expect(record?.runId).toBe("login-handoff");
		expect(
			engine.getDialogueRecord(repo, run.workflowId, "handoff-missing"),
		).toBeUndefined();
		// Another workflow's record, and another workflow, are both simply absent:
		// the reader has no way to reach a snapshot it was not asked about.
		expect(
			engine.getDialogueRecord(repo, "wf-nothing", "handoff-narrow"),
		).toBeUndefined();
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a series of hand-offs is bounded by the dialogue's content budget, not by the question count", () => {
	const { repo, engine, run } = setup();
	try {
		// A hand-off record stays in the workflow for the life of the workflow and
		// nothing prunes it, so what bounds a series of them is the dialogue's byte
		// budget — a long description reaches it first — and the question count
		// stays at zero throughout (MIG-005).
		const description = "d".repeat(3_000);
		let opened = 0;
		let refusal: string | undefined;
		for (let index = 0; index < MAX_DEVELOPER_DIALOGUE_RECORDS; index++) {
			try {
				engine.dispatch(repo, {
					type: "login-handoff.open",
					workflowId: run.workflowId,
					recordId: `handoff-${index}`,
					description,
					expiresAt: new Date(Date.now() + 900_000).toISOString(),
				});
				opened += 1;
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
				break;
			}
		}
		expect(refusal).toContain("content limit");
		expect(opened).toBeLessThan(MAX_DEVELOPER_DIALOGUE_RECORDS);
		const snapshot = engine.getSnapshot(repo, run.workflowId);
		expect(snapshot.developerDialogue).toHaveLength(opened);
		expect(questionRecordCount(snapshot.developerDialogue)).toBe(0);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a hand-off record never spends a question's dialogue slot", () => {
	const { repo, engine, run, token } = setup();
	try {
		for (let index = 0; index < 3; index++) {
			engine.dispatch(repo, {
				type: "login-handoff.open",
				workflowId: run.workflowId,
				recordId: `handoff-${index}`,
				description: `Log in to Grid integration as clerk ${index}`,
				expiresAt: new Date(Date.now() + 900_000).toISOString(),
			});
		}
		// The question writer counts the shared way, so three hand-off records cost
		// the run nothing: its own question is created, and it is the only record
		// the question budget sees.
		const asked = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which approach?",
			options: [{ label: "Use A", value: "a" }],
		});
		expect(asked.snapshot.developerDialogue).toHaveLength(4);
		expect(questionRecordCount(asked.snapshot.developerDialogue)).toBe(1);
		expect(
			asked.snapshot.developerDialogue.filter(
				(record) => record.kind !== "login-handoff",
			),
		).toHaveLength(1);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a workflow's refusal to raise the record is surfaced, not swallowed", async () => {
	const { repo, engine, run, token } = setup();
	try {
		const attention = workflowLoginHandoffAttention({
			engine: () => engine,
			targets: () => [repo],
		});
		const owner = `workflow:${run.workflowId}`;
		// A real question, asked the ordinary way: its id can never be a hand-off's,
		// so asking for it as one is a refusal the workflow itself produces.
		const asked = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which approach?",
			options: [{ label: "Use A", value: "a" }],
		});
		const questionId = asked.snapshot.developerDialogue.at(-1)?.id;
		if (!questionId) throw new Error("question missing");
		await expect(
			attention.open({
				owner,
				recordId: questionId,
				description: "Log in to Grid integration as clerk",
				context: "stage grid-int, app web, role clerk",
				expiresAt: new Date(Date.now() + 900_000).toISOString(),
			}),
		).rejects.toThrow(
			/the login hand-off record was refused: .*not a login hand-off/,
		);
		// The refusal leaves no trace: the dialogue is the question and nothing else,
		// so a hand-off that could not raise its record has no dialog to read.
		expect(
			engine.getSnapshot(repo, run.workflowId).developerDialogue,
		).toHaveLength(1);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a hand-off record never reaches an assignment's prior dialogue", async () => {
	const { repo, engine, run, token } = setup();
	try {
		engine.dispatch(repo, {
			type: "login-handoff.open",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			description: "handoff-sentinel-should-not-reach-a-prompt",
			expiresAt: new Date(Date.now() + 900_000).toISOString(),
		});
		// Resolved, so only the record's kind keeps it out of the assignment: a
		// pending record would be dropped anyway.
		engine.dispatch(repo, {
			type: "login-handoff.resolve",
			workflowId: run.workflowId,
			recordId: "handoff-1",
			answer: "done",
		});
		// A real question, asked the ordinary way, is what the resumed attempt
		// should see.
		const asked = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which approach?",
			options: [{ label: "Use A", value: "a" }],
		});
		const questionId = asked.snapshot.developerDialogue.find(
			(item) => item.description === "which approach?",
		)?.id;
		if (!questionId) throw new Error("question missing");
		const blocked = engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "waiting on the developer",
		});
		engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: blocked.snapshot.revision,
			actionId: "answer-question",
			input: { questionId, kind: "option", value: "a" },
		});
		const resumed = engine
			.status(repo, run.workflowId)
			.runs.find(
				(candidate) =>
					candidate.role === "worker" && candidate.status === "pending",
			);
		if (!resumed) throw new Error("resumed run missing");
		await drainAssignments(repo, engine);
		const assignment = fs.readFileSync(
			engine.getRun(repo, resumed.id).assignmentPath,
			"utf8",
		);
		expect(assignment).toContain("which approach?");
		expect(assignment).not.toContain(
			"handoff-sentinel-should-not-reach-a-prompt",
		);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("an answered question resumes the blocked asking run with the answer in its assignment", async () => {
	const { repo, engine, run, token } = setup();
	try {
		const created = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which approach?",
			options: [{ label: "Use A", value: "a" }],
		});
		const questionId = created.snapshot.developerDialogue[0]?.id;
		if (!questionId) throw new Error("question missing");
		const blocked = engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "waiting on the developer",
		});
		expect(blocked.view.status).toBe("attention-required");
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: blocked.snapshot.revision,
			actionId: "answer-question",
			input: { questionId, kind: "option", value: "a" },
		});
		expect(answered.view.status).toBe("active");
		const resumed = answered.view.runs.find(
			(candidate) =>
				candidate.role === "worker" && candidate.status === "pending",
		);
		if (!resumed) throw new Error("resumed run missing");
		expect(resumed.attempt).toBe(2);
		await drainAssignments(repo, engine);
		const assignment = fs.readFileSync(
			engine.getRun(repo, resumed.id).assignmentPath,
			"utf8",
		);
		expect(assignment).toContain("## Prior dialogue (untrusted context)");
		expect(assignment).toContain("which approach?");
		expect(assignment).toContain("→ a");
		// The re-ask rule travels with the block, not with a protocol section.
		expect(assignment).toContain("never re-ask an answered decision");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a cancelled question leaves the parked run for explicit recovery", () => {
	const { repo, engine, run, token } = setup();
	try {
		const created = engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			description: "which approach?",
			options: [],
		});
		const questionId = created.snapshot.developerDialogue[0]?.id;
		if (!questionId) throw new Error("question missing");
		const blocked = engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "waiting on the developer",
		});
		const cancelled = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: blocked.snapshot.revision,
			actionId: "answer-question",
			input: { questionId, kind: "cancel" },
		});
		expect(cancelled.view.status).toBe("attention-required");
		expect(
			cancelled.view.runs.filter((candidate) => candidate.status === "blocked"),
		).toHaveLength(1);
		expect(
			cancelled.view.runs.filter((candidate) => candidate.status === "pending"),
		).toHaveLength(0);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("the orchestrator forwards a question it cannot answer to the developer", () => {
	const { repo, engine, run, token } = setup({ startedBy: "orchestrator" });
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "which design?",
			options: [],
		});
		const questionId = created.snapshot.developerDialogue[0]?.id;
		if (!questionId) throw new Error("question missing");
		// The operator cannot forward; only the orchestrator may.
		expect(() =>
			engine.dispatch(repo, {
				type: "developer.action",
				workflowId: run.workflowId,
				revision: created.snapshot.revision,
				actionId: "forward-question",
				input: { questionId },
			}),
		).toThrow(/reserved for the orchestrator/);
		const forwarded = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: created.snapshot.revision,
			actionId: "forward-question",
			principal: "orchestrator",
			input: { questionId },
		});
		// Now a normal developer question: visible to the developer, no longer the
		// orchestrator's, and still pending.
		expect(forwarded.view.orchestratorQuestions).toHaveLength(0);
		expect(forwarded.view.pendingQuestions?.map((item) => item.id)).toEqual([
			questionId,
		]);
		expect(forwarded.view.developerDialogue?.[0]?.status).toBe("pending");
		expect(forwarded.view.developerDialogue?.[0]?.targetRole).toBeUndefined();
		// The developer can now answer it.
		const answered = engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: forwarded.view.revision,
			actionId: "answer-question",
			input: { questionId, kind: "custom", value: "do A" },
		});
		expect(answered.view.developerDialogue?.[0]?.answer?.value).toBe("do A");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("an unanswered orchestrator question auto-forwards to the developer on timeout", () => {
	const { repo, engine, run, token, now } = setup({
		startedBy: "orchestrator",
	});
	try {
		const identity = {
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
		};
		const created = engine.dispatch(repo, {
			type: "agent.question",
			...identity,
			description: "which design?",
			options: [],
		});
		const question = created.snapshot.developerDialogue[0];
		const questionId = question?.id;
		const timerNonce = question?.timerNonce;
		if (!questionId || !timerNonce) throw new Error("question data missing");
		now(new Date("2026-01-02T00:00:00.000Z"));
		const forwarded = engine.dispatch(repo, {
			type: "timer.question-expire",
			workflowId: run.workflowId,
			questionId,
			timerNonce,
		});
		const record = forwarded.view.developerDialogue?.[0];
		// Not expired: forwarded to the developer with a fresh window.
		expect(record?.status).toBe("pending");
		expect(record?.targetRole).toBeUndefined();
		expect(forwarded.view.pendingQuestions?.map((item) => item.id)).toEqual([
			questionId,
		]);
		expect(Date.parse(record?.expiresAt ?? "")).toBe(
			new Date("2026-01-02T00:00:00.000Z").getTime() + QUESTION_WAIT_MS,
		);
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("the browser's hand-off adapter raises, reads and resolves the record through the real engine", async () => {
	const { repo, engine, run } = setup({ startedBy: "orchestrator" });
	try {
		// The adapter reaches the engine the server would hand it, so this covers
		// the bridge itself rather than a stub on either end of it.
		const attention = workflowLoginHandoffAttention({
			engine: () => engine,
			targets: () => [repo],
		});
		const owner = `workflow:${run.workflowId}`;
		const recordId = "handoff-adapter";
		const read = () =>
			engine
				.getSnapshot(repo, run.workflowId)
				.developerDialogue.find((item) => item.id === recordId);
		await attention.open({
			owner,
			recordId,
			description: "Log in to Grid integration as clerk",
			context: "stage grid-int, app web, role clerk",
			expiresAt: new Date("2026-01-01T00:15:00.000Z").toISOString(),
		});
		const opened = read();
		expect(opened?.kind).toBe("login-handoff");
		expect(opened?.status).toBe("pending");
		// It belongs to no run: a build that predates `kind` must not be able to
		// resume anything by this record's run id.
		expect(opened?.runId).not.toBe(run.id);
		// While the record is pending the coordinator is told nothing, which is
		// what keeps its poll loop a poll.
		expect(await attention.answer({ owner, recordId })).toBeUndefined();

		// An abort — the dashboard's Escape, or the agent's `browser_close` — is
		// read as the developer's answer.
		engine.dispatch(repo, {
			type: "login-handoff.resolve",
			workflowId: run.workflowId,
			recordId,
			answer: "abort",
		});
		expect(read()?.status).toBe("cancelled");
		expect(await attention.answer({ owner, recordId })).toBe("abort");

		// The coordinator's own resolution is idempotent: the record is already
		// answered, so closing it again resolves nothing a second time.
		await attention.close({
			owner,
			recordId,
			answer: "abort",
			by: "system",
			outcome: "login-handoff-aborted",
		});
		expect(read()?.status).toBe("cancelled");
		// Nothing resumed and nothing completed: the run is still the step's active
		// one, because resolving a hand-off never frees the asking run.
		expect(
			engine.getSnapshot(repo, run.workflowId).step.activeRunIds,
		).toContain(run.id);

		// A repeated open for the same record is the *same* hand-off — a restarted
		// server, a retried dispatch — so it replays the record instead of raising a
		// second dialog, and the developer keeps the words of the first one.
		await attention.open({
			owner,
			recordId: "handoff-adapter",
			description: "different",
			context: "different",
			expiresAt: new Date("2026-01-01T00:15:00.000Z").toISOString(),
		});
		expect(read()?.description).toBe("Log in to Grid integration as clerk");
		expect(
			engine.getSnapshot(repo, run.workflowId).developerDialogue,
		).toHaveLength(1);

		// A hand-off whose ending is the server's own arrives with `canConfirm: false`,
		// and this hop is what turns it into *Abort* alone: dropping it here would put
		// the *Done* that can only close the receiver back in front of the developer
		// (USAB-207, TQ-010).
		const completionDriven = "handoff-adapter-completion";
		await attention.open({
			owner,
			recordId: completionDriven,
			description: "Sign in to Grid integration as user",
			context: "stage grid-int, app api, role user",
			expiresAt: new Date("2026-01-01T00:15:00.000Z").toISOString(),
			canConfirm: false,
		});
		const completionRecord = engine
			.getSnapshot(repo, run.workflowId)
			.developerDialogue.find((item) => item.id === completionDriven);
		expect(completionRecord?.kind).toBe("login-handoff");
		expect(completionRecord?.options.map((option) => option.value)).toEqual([
			"abort",
		]);
		expect(completionRecord?.options[0]?.label).toBe("Abort");
		// The record opened without the field keeps both answers, which is what makes
		// the assertion above about the flag and not about the record kind.
		expect(opened?.options.map((option) => option.value)).toEqual([
			"done",
			"abort",
		]);
		// A workflow this server does not host is honestly dialog-less rather than
		// a failure: a session can outlive the run that opened it.
		await expect(
			attention.open({
				owner: "workflow:wf-not-hosted-here",
				recordId: "handoff-elsewhere",
				description: "Log in to Grid integration as clerk",
				context: "stage grid-int, app web, role clerk",
				expiresAt: new Date("2026-01-01T00:15:00.000Z").toISOString(),
			}),
		).resolves.toBeUndefined();
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

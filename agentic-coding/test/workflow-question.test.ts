import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	commandContract,
	parseDeveloperQuestionAnswer,
	parseSnapshot,
	type ResolvedProfile,
} from "../src/workflow/contracts.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { QUESTION_WAIT_MS, WorkflowEngine } from "../src/workflow/runtime.ts";

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

function setup() {
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
		data: { runtime: "pi", name: "worker", paneId: "pane" },
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
	const snapshot = parseSnapshot({
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
	});
	expect(snapshot.developerDialogue).toEqual([]);
	expect(() =>
		commandContract.parse({
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
	const command = commandContract.parse({
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
		parseDeveloperQuestionAnswer({
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
		commandContract.parse({
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
		if (!questionId) throw new Error("question id missing");
		expect(question?.expiresAt).toBe(
			new Date(
				new Date("2026-01-01T00:00:00Z").getTime() + QUESTION_WAIT_MS,
			).toISOString(),
		);
		now(new Date("2026-01-01T23:59:59.999Z"));
		expect(engine.status(repo, "question").pendingQuestions).toHaveLength(1);
		now(new Date("2026-01-02T00:00:00.000Z"));
		const expiredView = engine.status(repo, "question");
		expect(expiredView.pendingQuestions).toHaveLength(0);
		expect(expiredView.developerDialogue?.[0]?.status).toBe("expired");
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

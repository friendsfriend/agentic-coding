import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	ClarificationAuthority,
	ClarificationResponse,
	ResolvedProfile,
} from "../src/contracts/workflow.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import {
	clarificationDigest,
	renderClarificationProposal,
} from "../src/workflow/runtime/clarification-actions.ts";
import { openReadStore } from "../src/workflow/runtime/store.ts";
import { QUESTION_WAIT_MS, WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	createRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();
const attachment = {
	hostId: "home-host",
	conversationId: "home-conversation",
	epoch: 1,
};
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
function fixture(attached = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "clarification-actions-"));
	const repo = createRepoFixture(root, repoPreset.readme);
	let time = new Date("2026-01-01T00:00:00Z");
	const engine = new WorkflowEngine(registerBuiltins(), () => time);
	const started = engine.start({
		repo,
		workflowId: "clarification",
		definitionId: "no-openspec",
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: "Use the agreed A implementation",
			approvedDesign: {
				content: "forged caller approval",
				digest: clarificationDigest("forged caller approval"),
				revision: 1,
				approvedAt: "2026-01-01T00:00:00Z",
			},
			...(attached ? { clarificationAttachment: attachment } : {}),
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
	if (!launch?.runToken || !launch.lease) throw new Error("missing launch");
	const token = launch.runToken;
	engine.dispatch(repo, {
		type: "effect.result",
		effectId: launch.id,
		lease: launch.lease,
		outcome: "complete",
		data: { runtime: "pi-durable", name: "worker", paneId: "test-pane" },
	});
	const authority: ClarificationAuthority = {
		attachment,
		messages: [],
		sources: [
			{
				kind: "task",
				id: "task",
				digest: clarificationDigest("Use the agreed A implementation"),
			},
		],
	};
	const action = (
		actionId: string,
		input: unknown,
		trusted: ClarificationAuthority | null = authority,
		principal: "operator" | "orchestrator" = "orchestrator",
	) =>
		engine.dispatch(repo, {
			type: "developer.action",
			workflowId: run.workflowId,
			revision: engine.status(repo, run.workflowId).revision,
			actionId,
			input,
			principal,
			...(trusted ? { clarificationAuthority: trusted } : {}),
		});
	const ask = (group = false) =>
		engine.dispatch(repo, {
			type: "agent.question",
			workflowId: run.workflowId,
			runId: run.id,
			stepId: run.stepId,
			role: run.role,
			token,
			...(group
				? {
						questions: [
							{ question: "First?", options: [{ label: "Use A", value: "a" }] },
							{ question: "Second?", options: [] },
						],
					}
				: {
						description: "Which approach?",
						options: [{ label: "Use A", value: "a" }],
					}),
		});
	const block = () =>
		engine.dispatch(repo, {
			type: "agent.handoff",
			runId: run.id,
			generation: run.generation,
			token,
			outcome: "blocked",
			message: "Waiting for clarification",
		});
	return {
		root,
		repo,
		engine,
		run,
		token,
		action,
		ask,
		block,
		authority,
		setTime: (next: Date) => {
			time = next;
		},
	};
}
function mutation(questionId: string, askingRunId: string) {
	return { epoch: 1, questionId, askingRunId, homeRunId: "home-run" };
}

test("unassigned pending-return markers survive reopen and late explicit attachment; start metadata cannot manufacture design approval", () => {
	const f = fixture(false);
	try {
		expect(
			f.engine.status(f.repo, f.run.workflowId).approvedDesign,
		).toBeUndefined();
		const question = f.ask().snapshot.developerDialogue[0];
		if (!question) throw new Error("missing question");
		f.engine.dispatch(f.repo, {
			type: "agent.question-wait",
			workflowId: f.run.workflowId,
			runId: f.run.id,
			stepId: f.run.stepId,
			role: f.run.role,
			token: f.token,
			questionId: question.id,
		});
		const reopened = new WorkflowEngine(
			registerBuiltins(),
			() => new Date("2026-01-01T00:00:00Z"),
		);
		expect(
			reopened.getSnapshot(f.repo, f.run.workflowId).developerDialogue[0]
				?.clarificationAwaitingHandoff,
		).toBe(true);
		f.action(
			"clarification.attach",
			{
				hostId: attachment.hostId,
				conversationId: attachment.conversationId,
				homeRunId: "home-run",
			},
			f.authority,
			"operator",
		);
		expect(
			f.engine.status(f.repo, f.run.workflowId).developerDialogue?.[0]
				?.clarification?.awaitingHandoff,
		).toBe(true);
		f.action("clarification.grounded", {
			...mutation(question.id, f.run.id),
			responses: [{ questionId: question.id, kind: "option", value: "a" }],
			rationale: "The task explicitly agrees A.",
			sources: f.authority.sources,
			receipt: "late-attach-grounded",
		});
		expect(f.engine.status(f.repo, f.run.workflowId).runs).toHaveLength(1);
		f.block();
		expect(
			f.engine
				.status(f.repo, f.run.workflowId)
				.runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test("attached UI-origin question grounds an exact group atomically and resumes the blocked asker once", () => {
	const f = fixture();
	try {
		const created = f.ask(true);
		const questions = created.snapshot.developerDialogue;
		const first = questions[0];
		if (!first?.clarification) throw new Error("question missing");
		expect(created.view.startedBy).toBe("developer");
		expect(
			questions.every((question) => question.targetRole === "orchestrator"),
		).toBe(true);
		expect(
			new Set(questions.map((question) => question.clarification?.delivery.id))
				.size,
		).toBe(1);
		const input = mutation(first.id, f.run.id);
		const responses: ClarificationResponse[] = questions.map(
			(question, index) => ({
				questionId: question.id,
				kind: index ? "custom" : "option",
				value: index ? "line one\n  exact line two" : "a",
			}),
		);
		f.block();
		for (const actionId of ["answer-question", "forward-question"])
			expect(() =>
				f.action(actionId, {
					groupId: first.groupId,
					...(actionId === "answer-question" ? { responses } : {}),
				}),
			).toThrow(/clarifications/);
		expect(() =>
			f.action("clarification.grounded", {
				...input,
				responses,
				receipt: "receipt",
				rationale: "Task specifies A",
				sources: [{ kind: "task", id: "task", digest: "forged" }],
			}),
		).toThrow("source identity");
		expect(() =>
			f.action("clarification.grounded", {
				...input,
				responses: responses.slice(0, 1),
				receipt: "receipt",
				rationale: "Task specifies A",
				sources: f.authority.sources,
			}),
		).toThrow("complete response");
		const accepted = f.action("clarification.grounded", {
			...input,
			responses,
			receipt: "receipt",
			rationale: "Task specifies A",
			sources: f.authority.sources,
		});
		expect(
			accepted.snapshot.developerDialogue.map(
				(question) => question.answer?.value,
			),
		).toEqual(["a", "line one\n  exact line two"]);
		expect(
			accepted.snapshot.developerDialogue.every(
				(question) =>
					question.clarification?.resolution?.origin ===
					"grounded-orchestrator",
			),
		).toBe(true);
		expect(
			accepted.view.runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
		expect(accepted.view.status).toBe("active");
		expect(() =>
			f.action("clarification.grounded", {
				...input,
				responses,
				receipt: "receipt",
				rationale: "Task specifies A",
				sources: f.authority.sources,
			}),
		).toThrow("no longer pending");
		expect(
			f.engine
				.status(f.repo, f.run.workflowId)
				.runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
		const reopened = new WorkflowEngine(registerBuiltins());
		expect(
			reopened
				.status(f.repo, f.run.workflowId)
				.developerDialogue?.map((question) => question.answer),
		).toEqual(
			accepted.view.developerDialogue?.map((question) => question.answer),
		);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test("exact native proposal and subsequent attributed human confirmation are mandatory; edits invalidate the old version", () => {
	const f = fixture();
	try {
		const created = f.ask();
		const question = created.snapshot.developerDialogue[0];
		if (!question) throw new Error("missing question");
		const input = mutation(question.id, f.run.id);
		const responses: ClarificationResponse[] = [
			{
				questionId: question.id,
				kind: "custom",
				value: "The agreed custom answer\n  preserved",
			},
		];
		const proposal = {
			hostId: attachment.hostId,
			conversationId: attachment.conversationId,
			messageId: "10",
			sequence: 10,
			role: "assistant" as const,
			text: renderClarificationProposal([question], responses, 1),
		};
		const trusted = { ...f.authority, messages: [proposal] };
		expect(() =>
			f.action(
				"clarification.stage",
				{
					...input,
					responses,
					version: 1,
					proposalMessageId: "10",
					clarificationAuthority: trusted,
				},
				null,
			),
		).toThrow("authenticated clarification context");
		expect(() =>
			f.action(
				"clarification.stage",
				{ ...input, responses, version: 1, proposalMessageId: "10" },
				{
					...trusted,
					messages: [{ ...proposal, text: "I choose something else" }],
				},
			),
		).toThrow("exact versioned");
		const staged = f.action(
			"clarification.stage",
			{ ...input, responses, version: 1, proposalMessageId: "10" },
			trusted,
		);
		expect(staged.snapshot.developerDialogue[0]?.status).toBe("pending");
		const confirm = {
			...input,
			version: 1,
			confirmationMessageId: "11",
			receipt: "confirmed-receipt",
		};
		for (const wrong of [
			{ role: "assistant" as const },
			{ conversationId: "other" },
			{ sequence: 9 },
		])
			expect(() =>
				f.action("clarification.confirm", confirm, {
					...trusted,
					messages: [
						proposal,
						{
							hostId: attachment.hostId,
							conversationId: attachment.conversationId,
							messageId: "11",
							sequence: 11,
							role: "developer",
							text: "Confirm",
							...wrong,
						},
					],
				}),
			).toThrow();
		const edited = [
			{
				...responses[0],
				questionId: question.id,
				kind: "custom" as const,
				value: "Edited exact answer",
			},
		];
		const second = {
			...proposal,
			messageId: "12",
			sequence: 12,
			text: renderClarificationProposal([question], edited, 2),
		};
		f.action(
			"clarification.stage",
			{ ...input, responses: edited, version: 2, proposalMessageId: "12" },
			{ ...trusted, messages: [second] },
		);
		const developer = {
			hostId: attachment.hostId,
			conversationId: attachment.conversationId,
			messageId: "13",
			sequence: 13,
			role: "developer" as const,
			text: "Yes, relay that edited proposal",
		};
		const evidence = { ...trusted, messages: [second, developer] };
		expect(() =>
			f.action(
				"clarification.confirm",
				{ ...confirm, confirmationMessageId: "13" },
				evidence,
			),
		).toThrow("stale");
		const accepted = f.action(
			"clarification.confirm",
			{ ...confirm, version: 2, confirmationMessageId: "13" },
			evidence,
		);
		expect(accepted.snapshot.developerDialogue[0]?.answer?.value).toBe(
			"Edited exact answer",
		);
		expect(
			accepted.snapshot.developerDialogue[0]?.clarification?.resolution?.origin,
		).toBe("confirmed-developer");
		const db = openReadStore(f.repo);
		try {
			const history = db
				.query<{ data_json: string }, [string]>(
					"SELECT data_json FROM workflow_events WHERE workflow_id=? AND type='clarification.staged' ORDER BY revision",
				)
				.all(f.run.workflowId)
				.map((row) => JSON.parse(row.data_json));
			expect(history).toHaveLength(2);
			expect(history[0]?.responses).toEqual(responses);
			expect(history[1]?.responses).toEqual(edited);
			expect(history[0]?.attachment).toEqual(attachment);
		} finally {
			db.close();
		}
		// A currently working run obtains its tool result without another launch.
		expect(accepted.view.runs).toHaveLength(1);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test("operator reattachment fences old custody and staged work; overdue state is retained rather than forwarded", () => {
	const f = fixture(false);
	try {
		const legacy = f.ask();
		const question = legacy.snapshot.developerDialogue[0];
		if (!question) throw new Error("missing question");
		const attach = {
			hostId: attachment.hostId,
			conversationId: attachment.conversationId,
			homeRunId: "home-run",
		};
		expect(() => f.action("clarification.attach", attach)).toThrow(
			"only the developer",
		);
		const attached = f.action(
			"clarification.attach",
			attach,
			f.authority,
			"operator",
		);
		expect(attached.snapshot.metadata.startedBy).not.toBe("orchestrator");
		const pending = attached.snapshot.developerDialogue[0];
		if (!pending?.timerNonce) throw new Error("timer missing");
		f.setTime(new Date(Date.parse(pending.expiresAt) + QUESTION_WAIT_MS));
		const overdue = f.engine.dispatch(f.repo, {
			type: "timer.question-expire",
			workflowId: f.run.workflowId,
			questionId: pending.id,
			timerNonce: pending.timerNonce,
		});
		expect(overdue.snapshot.developerDialogue[0]?.status).toBe("pending");
		expect(overdue.snapshot.developerDialogue[0]?.targetRole).toBe(
			"orchestrator",
		);
		const reattached = f.action(
			"clarification.attach",
			attach,
			f.authority,
			"operator",
		);
		expect(reattached.snapshot.metadata.clarificationAttachment?.epoch).toBe(2);
		expect(() =>
			f.action("clarification.cancel", mutation(question.id, f.run.id)),
		).toThrow("epoch changed");
		const current = { ...f.authority, attachment: { ...attachment, epoch: 2 } };
		const cancelled = f.action(
			"clarification.cancel",
			{ ...mutation(question.id, f.run.id), epoch: 2 },
			current,
		);
		expect(cancelled.snapshot.developerDialogue[0]?.status).toBe("cancelled");
		expect(cancelled.view.runs).toHaveLength(1);
	} finally {
		fs.rmSync(f.root, { recursive: true, force: true });
	}
});

test("answer-before-blocked-handoff resumes once only when the authenticated question tool returned pending", () => {
	for (const returnedPending of [false, true]) {
		const f = fixture();
		try {
			const created = f.ask();
			const question = created.snapshot.developerDialogue[0];
			if (!question) throw new Error("missing question");
			if (returnedPending) {
				expect(() =>
					f.engine.dispatch(f.repo, {
						type: "agent.question-wait",
						workflowId: f.run.workflowId,
						runId: f.run.id,
						stepId: f.run.stepId,
						role: f.run.role,
						token: "forged",
						questionId: question.id,
					}),
				).toThrow("capability");
				f.engine.dispatch(f.repo, {
					type: "agent.question-wait",
					workflowId: f.run.workflowId,
					runId: f.run.id,
					stepId: f.run.stepId,
					role: f.run.role,
					token: f.token,
					questionId: question.id,
				});
			}
			const answered = f.action("clarification.grounded", {
				...mutation(question.id, f.run.id),
				responses: [{ questionId: question.id, kind: "option", value: "a" }],
				receipt: "race-receipt",
				rationale: "Task specifies A",
				sources: f.authority.sources,
			});
			expect(answered.view.runs).toHaveLength(1);
			const handedOff = f.block();
			expect(
				handedOff.view.runs.filter((run) => run.status === "pending"),
			).toHaveLength(returnedPending ? 1 : 0);
			expect(handedOff.view.status).toBe(
				returnedPending ? "active" : "attention-required",
			);
			expect(() => f.block()).toThrow();
			expect(
				f.engine
					.status(f.repo, f.run.workflowId)
					.runs.filter((run) => run.status === "pending"),
			).toHaveLength(returnedPending ? 1 : 0);
		} finally {
			fs.rmSync(f.root, { recursive: true, force: true });
		}
	}
});

import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	clarificationDeliveries,
	deliverClarifications,
} from "../src/agent-host/clarification-delivery.ts";
import { clarificationSources } from "../src/server/clarification.ts";
import { createClarificationReconciler } from "../src/server/clarification-delivery.ts";
import {
	deriveWorkflowEvents,
	projectWorkflowEvents,
} from "../src/server/workflow-events.ts";
import { renderClarificationProposal } from "../src/workflow/runtime/clarification-actions.ts";
import { autoRemoveRepoFixtures } from "./support/git-fixture.ts";
import { nativeClarificationFixture } from "./support/native-clarification.ts";

autoRemoveRepoFixtures();
const text = (value: string) => [fauxAssistantMessage([fauxText(value)])];

test("group delivery rejects mismatched native receipts and cancellation leaves no transport or worker replacement", async () => {
	const f = await nativeClarificationFixture();
	try {
		const asked = f.ask(true);
		const view = f.view();
		const request = clarificationDeliveries(view)[0];
		if (!request) throw new Error("missing group delivery");
		expect(clarificationDeliveries(view)).toHaveLength(1);
		let acknowledgements = 0;
		const receipt = {
			type: "clarificationDelivery" as const,
			hostId: request.hostId,
			conversationId: request.conversationId,
			deliveryId: request.deliveryId,
			runId: f.home.runId,
		};
		for (const mismatch of [
			{ hostId: "foreign-host" },
			{ conversationId: "foreign-conversation" },
			{ deliveryId: "old-epoch-id" },
			{ runId: "" },
		]) {
			await expect(
				deliverClarifications(
					view,
					async () => ({ ...receipt, ...mismatch }),
					async () => {
						acknowledgements++;
					},
				),
			).rejects.toThrow("acknowledgement mismatch");
		}
		expect(acknowledgements).toBe(0);
		const first = asked.snapshot.developerDialogue[0];
		if (!first) throw new Error("missing question");
		f.engine().dispatch(f.repo, {
			type: "agent.question-wait",
			workflowId: f.run.workflowId,
			runId: f.run.id,
			stepId: f.run.stepId,
			role: f.run.role,
			token: f.token,
			questionId: first.id,
		});
		const before = projectWorkflowEvents(f.view());
		f.block();
		const parked = f.view();
		const projection = projectWorkflowEvents(parked);
		expect(projection.clarificationOnly).toBe(true);
		expect(
			deriveWorkflowEvents(before, projection, {
				repository: f.repo,
				workflowId: f.run.workflowId,
				at: new Date().toISOString(),
			}).find((event) => event.id === "workflow.failed"),
		).toMatchObject({ payload: { clarificationOnly: true } });
		expect(
			projectWorkflowEvents({
				...parked,
				runs: parked.runs?.map((run) => ({
					...run,
					status: "failed" as const,
				})),
			}).clarificationOnly,
		).toBeUndefined();
		const cancelled = await f.post("clarification.cancel", {
			epoch: 1,
			homeRunId: f.home.runId,
			questionId: first.id,
			askingRunId: first.runId,
		});
		expect(cancelled.status).toBe(200);
		expect(
			f.view().developerDialogue?.every((item) => item.status === "cancelled"),
		).toBe(true);
		expect(clarificationDeliveries(f.view())).toEqual([]);
		f.reopenEngine();
		expect(clarificationDeliveries(f.view())).toEqual([]);
		expect(f.view().runs).toHaveLength(1);
		const forgedAck = await f.post("clarification.ack", {
			epoch: 1,
			homeRunId: f.home.runId,
			questionId: first.id,
			askingRunId: first.runId,
			receipt: request.deliveryId,
		});
		expect(forgedAck.status).toBe(403);
		expect(await forgedAck.text()).toContain("server-receipt-required");
	} finally {
		await f.cleanup();
	}
}, 30_000);

test("two workflows share a Home without cross-delivery or reusing one human confirmation, including after host restart", async () => {
	const f = await nativeClarificationFixture();
	try {
		const first = f.ask().snapshot.developerDialogue[0];
		const second = await f.addWorkflow("concurrent");
		const asked = f.engine().dispatch(f.repo, {
			type: "agent.question",
			workflowId: second.run.workflowId,
			runId: second.run.id,
			stepId: second.run.stepId,
			role: second.run.role,
			token: second.token,
			description: "Another workflow's separate decision?",
			options: [{ title: "A", value: "a" }],
		});
		const other = asked.snapshot.developerDialogue[0];
		if (!first || !other) throw new Error("missing concurrent questions");
		f.faux.setResponses([
			...text("First pending question is in this Home."),
			...text("Second pending question is separate."),
		]);
		const retry = createClarificationReconciler(f.operations, f.root);
		await Promise.all([
			retry(f.repo, f.run.workflowId, true),
			retry(f.repo, second.run.workflowId, true),
		]);
		await f.settle(0);
		expect(await f.assistants()).toHaveLength(2);
		expect(
			f.view().developerDialogue?.[0]?.clarification?.delivery.status,
		).toBe("accepted");
		expect(
			f.engine().status(f.repo, second.run.workflowId).developerDialogue?.[0]
				?.clarification?.delivery.status,
		).toBe("accepted");
		for (const q of [first, other]) {
			const responses = [
				{ questionId: q.id, kind: "option" as const, value: "a" },
			];
			const proposal = renderClarificationProposal([q], responses, 1);
			await f.turn("Discuss the next specific proposal.", text(proposal), true);
			const message = (await f.messages()).find(
				(item) => item.text === proposal,
			);
			if (!message) throw new Error("missing proposal");
			await f.toolTurn(
				"clarification.stage",
				{
					epoch: 1,
					questionId: q.id,
					askingRunId: q.runId,
					version: 1,
					responses,
					proposalMessageId: message.messageId,
				},
				q.workflowId,
			);
		}
		await f.turn(
			"Yes, relay the exact first workflow's proposed answer.",
			text("Only the first workflow's proposal was confirmed."),
			true,
		);
		const confirmation = (await f.messages()).find(
			(item) =>
				item.role === "developer" &&
				item.text === "Yes, relay the exact first workflow's proposed answer.",
		);
		if (!confirmation) throw new Error("missing developer input");
		await f.toolTurn("clarification.confirm", {
			epoch: 1,
			questionId: first.id,
			askingRunId: first.runId,
			version: 1,
			receipt: "first-confirmation",
			confirmationMessageId: confirmation.messageId,
		});
		const attempt = () =>
			f.post(
				"clarification.confirm",
				{
					epoch: 1,
					homeRunId: f.home.runId,
					questionId: other.id,
					askingRunId: other.runId,
					version: 1,
					receipt: "second-confirmation",
					confirmationMessageId: confirmation.messageId,
				},
				false,
				other.workflowId,
			);
		let refused = await attempt();
		expect(await refused.text()).toContain(
			"already reserved for another candidate",
		);
		expect(refused.status).toBe(400);
		await f.reopenHost();
		f.reopenEngine();
		refused = await attempt();
		expect(await refused.text()).toContain(
			"already reserved for another candidate",
		);
		expect(refused.status).toBe(400);
		expect(
			f.engine().status(f.repo, other.workflowId).developerDialogue?.[0]
				?.status,
		).toBe("pending");
	} finally {
		await f.cleanup();
	}
}, 30_000);

// Native host acceptance, workflow receipt and process recovery are deliberately
// exercised separately: this catches the otherwise invisible acceptance/ACK gap.
test("addressed delivery survives lost ACK and host reopen, deduplicates natively and never picks the visible Home", async () => {
	const f = await nativeClarificationFixture();
	try {
		f.ask(true);
		const plans = clarificationDeliveries(f.view());
		expect(plans).toHaveLength(1);
		const plan = plans[0];
		if (!plan) throw new Error("missing delivery plan");
		await f.host().ensureRun({
			...f.home,
			runId: "another-home",
			name: "another-home",
			runEnvPath: f.home.runEnvPath,
		});
		f.faux.setResponses(text("Which second value should we discuss?"));
		await expect(
			deliverClarifications(
				f.view(),
				(request) => f.client.deliverClarification(request),
				async () => {
					throw new Error("simulated receipt crash");
				},
			),
		).rejects.toThrow("receipt crash");
		await f.settle(0);
		expect(
			f
				.view()
				.developerDialogue?.every(
					(question) => question.clarification?.delivery.status === "pending",
				),
		).toBe(true);
		expect(
			(await f.host().entriesForTest("another-home")).some((entry) =>
				JSON.stringify(entry).includes(plan.deliveryId),
			),
		).toBe(false);
		const before = await f.assistants();
		await f.reopenHost();
		f.reopenEngine();
		const retry = createClarificationReconciler(f.operations, f.root);
		await Promise.all([
			retry(f.repo, f.run.workflowId, true),
			retry(f.repo, f.run.workflowId, true),
		]);
		await Bun.sleep(50);
		expect(await f.assistants()).toEqual(before);
		expect(
			f
				.view()
				.developerDialogue?.every(
					(question) => question.clarification?.delivery.status === "accepted",
				),
		).toBe(true);
		const revision = f.view().revision;
		await retry(f.repo, f.run.workflowId, true);
		expect(f.view().revision).toBe(revision);
		expect(clarificationDeliveries(f.view())).toEqual([]);
		await expect(
			f.client.deliverClarification({ ...plan, hostId: "foreign-host" }),
		).rejects.toThrow("destination");
		await expect(
			f.client.deliverClarification({
				...plan,
				conversationId: "foreign-conversation",
			}),
		).rejects.toThrow("unavailable");
		const spoof = await f.post("clarification.ack", {
			questionId: f.view().developerDialogue?.[0]?.id,
			askingRunId: f.run.id,
			epoch: 1,
			homeRunId: f.home.runId,
			receipt: plan.deliveryId,
		});
		expect(spoof.status).toBe(403);
	} finally {
		await f.cleanup();
	}
}, 30_000);

for (const mode of ["off", "notify"] as const)
	test(`${mode} retains unavailable work without automatic wake; explicit opening reconciles the pinned Home`, async () => {
		const f = await nativeClarificationFixture();
		try {
			f.ask();
			const retry = createClarificationReconciler(
				f.operations,
				f.root,
				() => mode,
			);
			await retry(f.repo, f.run.workflowId);
			expect(await f.assistants()).toEqual([]);
			expect(clarificationDeliveries(f.view())).toHaveLength(1);
			await f.host().shutdown();
			await expect(retry(f.repo, f.run.workflowId, true)).rejects.toThrow();
			expect(clarificationDeliveries(f.view())).toHaveLength(1);
			await f.reopenHost();
			f.faux.setResponses(
				text("The pending clarification is here, without a popup."),
			);
			await retry(f.repo, f.run.workflowId, true);
			await f.settle(0);
			expect(clarificationDeliveries(f.view())).toHaveLength(0);
			expect(f.view().developerDialogue?.[0]?.status).toBe("pending");
		} finally {
			await f.cleanup();
		}
	}, 30_000);

test("fake native Home tool grounds an answer through authenticated server and persisted engine into one worker continuation", async () => {
	const f = await nativeClarificationFixture();
	try {
		const created = f.ask();
		const question = created.snapshot.developerDialogue[0];
		if (!question?.clarification) throw new Error("missing question");
		f.block();
		const task = clarificationSources(f.view()).find(
			(source) => source.kind === "task",
		);
		if (!task) throw new Error("missing task source");
		const input = {
			epoch: 1,
			questionId: question.id,
			askingRunId: f.run.id,
			homeRunId: f.home.runId,
			responses: [{ questionId: question.id, kind: "option", value: "a" }],
			rationale: "The agreed task explicitly specifies A.",
			receipt: "native-grounded-answer",
			sources: [{ kind: task.kind, id: task.id, digest: task.digest }],
		};
		await f.toolTurn("clarification.grounded", input);
		const accepted = f.view();
		expect(
			accepted.developerDialogue?.[0]?.clarification?.resolution?.origin,
		).toBe("grounded-orchestrator");
		expect(
			accepted.runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
		const receiptRevision = accepted.revision;
		const replay = await f.post("clarification.grounded", input);
		expect(replay.status).toBe(200);
		f.reopenEngine();
		expect(f.view().revision).toBe(receiptRevision);
		expect(
			f.view().runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
		// Acceptance may beat the delivery ACK/current-step transition. A delayed
		// receipt records transport fact only, without restarting the asker.
		const delayed = f.operations.action(
			{
				repo: f.repo,
				workflowId: f.run.workflowId,
				revision: f.view().revision,
				actionId: "clarification.ack",
				input: { ...input, receipt: question.clarification.delivery.id },
			},
			{
				principal: "orchestrator",
				clarificationAuthority: {
					attachment: question.clarification.attachment,
					messages: [],
					sources: [],
				},
			},
		);
		expect(delayed.developerDialogue?.[0]?.clarification?.delivery.status).toBe(
			"accepted",
		);
		expect(delayed.runs.filter((run) => run.status === "pending")).toHaveLength(
			1,
		);
		const entries = await f.host().entriesForTest(f.home.runId);
		expect(
			entries
				.filter(
					(entry) => (entry as { kind?: string }).kind === "pi.tool-result",
				)
				.every((entry) => !JSON.stringify(entry).includes('"isError":true')),
		).toBe(true);
	} finally {
		await f.cleanup();
	}
}, 30_000);

test("ordinary multi-turn discussion, unrelated chat and edited group proposals require a later attributed exact confirmation", async () => {
	const f = await nativeClarificationFixture();
	try {
		const created = f.ask(true);
		const questions = created.snapshot.developerDialogue;
		const first = questions[0];
		if (!first?.clarification) throw new Error("missing group");
		f.engine().dispatch(f.repo, {
			type: "agent.question-wait",
			workflowId: f.run.workflowId,
			runId: f.run.id,
			stepId: f.run.stepId,
			role: f.run.role,
			token: f.token,
			questionId: first.id,
		});
		const base = {
			receipt: "native-confirmed-answer",
			epoch: 1,
			questionId: first.id,
			askingRunId: f.run.id,
			homeRunId: f.home.runId,
		};
		await f.turn(
			"What is the weather?",
			text("That unrelated topic does not settle either workflow question."),
			true,
		);
		expect(
			f.view().developerDialogue?.every((item) => item.status === "pending"),
		).toBe(true);
		const responses = questions.map((question, index) => ({
			questionId: question.id,
			kind: index ? ("custom" as const) : ("option" as const),
			value: index ? "first idea" : "a",
		}));
		const proposal = renderClarificationProposal(questions, responses, 1);
		await f.turn(
			"A for the first; perhaps first idea for the second.",
			text(proposal),
			true,
		);
		const proposalMessage = (await f.messages()).find(
			(message) => message.role === "assistant" && message.text === proposal,
		);
		if (!proposalMessage) throw new Error("missing native proposal");
		await f.toolTurn("clarification.stage", {
			...base,
			version: 1,
			responses,
			proposalMessageId: proposalMessage.messageId,
		});
		expect(
			f.view().developerDialogue?.[0]?.clarification?.candidate?.version,
		).toBe(1);
		expect(
			f.view().developerDialogue?.every((item) => item.status === "pending"),
		).toBe(true);
		const edited = responses.map((response, index) =>
			index
				? { ...response, value: "line one\n  exact edited line two" }
				: response,
		);
		const revised = renderClarificationProposal(questions, edited, 2);
		await f.turn(
			"Change the second answer to the exact two-line text instead.",
			text(revised),
			true,
		);
		const revisedMessage = (await f.messages()).find(
			(message) => message.role === "assistant" && message.text === revised,
		);
		if (!revisedMessage) throw new Error("missing revised native proposal");
		await f.toolTurn("clarification.stage", {
			...base,
			version: 2,
			responses: edited,
			proposalMessageId: revisedMessage.messageId,
		});
		const before = f.view().revision;
		await f.turn(
			"Let us discuss another workflow now.",
			text("The revised proposal is still unconfirmed; I will not relay it."),
			true,
		);
		expect(f.view().revision).toBe(before);
		await f.turn(
			"Yes, relay this exact two-part proposed answer.",
			text(
				"I will relay only the revised proposal you just explicitly confirmed.",
			),
			true,
		);
		const confirmation = (await f.messages()).find(
			(message) =>
				message.role === "developer" &&
				message.text === "Yes, relay this exact two-part proposed answer.",
		);
		if (!confirmation)
			throw new Error("missing attributed native confirmation");
		await f.toolTurn("clarification.confirm", {
			...base,
			version: 2,
			confirmationMessageId: confirmation.messageId,
		});
		f.reopenEngine();
		expect(
			f.view().developerDialogue?.map((question) => question.answer?.value),
		).toEqual(["a", "line one\n  exact edited line two"]);
		expect(
			f.view().developerDialogue?.[0]?.clarification?.resolution?.origin,
		).toBe("confirmed-developer");
		expect(f.view().runs).toHaveLength(1);
		f.block();
		expect(
			f.view().runs.filter((run) => run.status === "pending"),
		).toHaveLength(1);
		const revision = f.view().revision;
		const replay = await f.post("clarification.confirm", {
			...base,
			version: 2,
			confirmationMessageId: confirmation.messageId,
		});
		expect(replay.status).toBe(200);
		expect(f.view().revision).toBe(revision);
	} finally {
		await f.cleanup();
	}
}, 30_000);

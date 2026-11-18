// A task is an agent like any other: it may spawn a sub-agent, and it is offered
// the same tools the orchestrator is. These are the two guarantees a review skill
// that fans out to specialised reviewers needs, and neither uses a poll or a timer.
import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

test("a task spawns a sub-agent, waits for it durably and answers with its result", async () => {
	const { app, fake, invocation } = await fixture(false, (config) =>
		config.profiles.push({
			id: "sub",
			provider: config.profiles[0].provider,
			modelId: "replacement",
			thinking: "off",
			description: "sub-agent",
		}),
	);
	// One script per model: a sub-agent may start while the parent is still
	// generating, so a single shared queue would hand each of them the other's reply.
	let parentTurns = 0;
	const replies: FauxResponseFactory = (_context, _options, _state, model) => {
		if (model.id === "replacement")
			return fauxAssistantMessage(fauxText("sub-agent finding"));
		parentTurns++;
		return parentTurns === 1
			? fauxAssistantMessage(
					fauxToolCall("start_task", {
						topicId: invocation.topicId,
						skill: "code",
						profile: "sub",
						repository: invocation.repository,
						workspace: "shared",
						inputs: "Review the change in your directory",
						requestId: "sub-1",
					}),
					{ stopReason: "toolUse" },
				)
			: fauxAssistantMessage(
					fauxText(parentTurns === 2 ? "spawned" : "aggregated answer"),
				);
	};
	// One queued factory per generation this scenario can need.
	fake.setResponses([replies, replies, replies, replies]);

	const id = await app.startTask(invocation);
	const parent = await app.harness.waitForTask(id as never, context);
	expect(parent.state.outcome).toMatchObject({
		status: "completed",
		result: "aggregated answer",
	});
	const tasks = (await app.snapshot()).tasks;
	const self = tasks.find((task) => task.id === id);
	const child = tasks.find((task) => task.parent === id);
	// The sub-agent is a task the parent owns, working in the parent's own
	// directory, and its report belongs to the parent's conversation.
	expect(child).toMatchObject({
		parent: id,
		workspaceMode: "shared",
		admittedBy: self?.conversationId,
	});
	expect(child?.workspace).toBe(self?.workspace);
	expect((await app.taskResult(child?.id ?? 0))?.state.outcome).toMatchObject({
		status: "completed",
		result: "sub-agent finding",
	});
	// The parent's last turn is the join: it is given what the sub-agent settled to
	// rather than guessing, which is why its own answer came after the child ended.
	const conversation = await app.harness.conversation(
		(self?.conversationId ?? 0) as never,
		context,
	);
	if (!conversation) throw new Error("Parent conversation is missing");
	const joined = JSON.stringify(await conversation.context(context));
	expect(joined).toContain("sub-agents you spawned have all finished");
	expect(joined).toContain("sub-agent finding");
});

test("an orchestrator and a task are offered the same tools", async () => {
	const { app, fake, invocation } = await fixture();
	fake.setResponses([fauxAssistantMessage(fauxText("done"))]);
	const id = await app.startTask(invocation);
	await app.harness.waitForTask(id as never, context);
	const self = (await app.snapshot()).tasks.find((task) => task.id === id);
	const conversation = await app.harness.conversation(
		(self?.conversationId ?? 0) as never,
		context,
	);
	if (!conversation) throw new Error("Task conversation is missing");
	const names = (tools: readonly { name: string }[]) =>
		tools.map((tool) => tool.name).sort();
	// The orchestrator's own conversation is the root the developer talks to.
	const orchestrator = await app.home.agent(context);
	expect(names((await conversation.agent(context)).tools)).toEqual(
		names(orchestrator.tools),
	);
	expect(names((await conversation.agent(context)).tools)).toEqual(
		expect.arrayContaining([
			"attach_evidence",
			"bash",
			"catalog",
			"edit",
			"environment_action",
			"pause_schedule",
			"read",
			"request_review",
			"schedule_skill",
			"start_task",
			"task_result",
			"write",
		]),
	);
	// Cancelling a task is the operator's, not a tool: no agent stops another
	// agent's work, and a parent's abort already cascades to what it spawned.
	expect(names((await conversation.agent(context)).tools)).not.toContain(
		"cancel_task",
	);
});

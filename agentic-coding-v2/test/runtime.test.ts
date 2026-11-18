import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { git } from "../src/git.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("native skill task completes in a separate worktree; admission is idempotent and content-bound", async () => {
	const { app, fake, invocation, config } = await fixture();
	const sentinel = path.join(config.stateDir, "git-program-executed");
	const hooks = path.join(config.stateDir, "hooks");
	fs.mkdirSync(hooks);
	const hook = path.join(hooks, "post-checkout");
	fs.writeFileSync(
		hook,
		`#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\n`,
		{ mode: 0o700 },
	);
	const filter = path.join(config.stateDir, "filter");
	fs.writeFileSync(
		filter,
		`#!/bin/sh\nprintf executed > ${JSON.stringify(sentinel)}\ncat\n`,
		{ mode: 0o700 },
	);
	await git(invocation.repository, ["config", "core.hooksPath", hooks]);
	await git(invocation.repository, ["config", "core.fsmonitor", hook]);
	await git(invocation.repository, ["config", "filter.unsafe.clean", filter]);
	await git(invocation.repository, ["config", "filter.unsafe.smudge", filter]);
	await git(invocation.repository, [
		"config",
		"filter.unsafe.required",
		"true",
	]);
	fs.writeFileSync(
		path.join(invocation.repository, ".gitattributes"),
		"*.fixture filter=unsafe\n",
	);
	fs.writeFileSync(
		path.join(invocation.repository, "sample.fixture"),
		"Raw source\n",
	);
	await git(invocation.repository, ["add", "."]);
	await git(invocation.repository, ["commit", "-m", "filter fixture"]);
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", {
				path: "implementation.txt",
				content: "Predecessor implementation",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("edit", {
				path: "implementation.txt",
				edits: [
					{
						oldText: "Predecessor implementation",
						newText: "Predecessor implementation\nRetained native edit",
					},
				],
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("read", {
				path: "implementation.txt",
				offset: 1,
				limit: 10,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Implemented and verified."),
		fauxAssistantMessage(fauxToolCall("read", { path: "implementation.txt" }), {
			stopReason: "toolUse",
		}),
		(transcript) => {
			expect(JSON.stringify(transcript.messages)).toContain(
				"Predecessor implementation",
			);
			return fauxAssistantMessage("Reviewed the predecessor implementation.");
		},
	]);
	const id = await app.startTask(invocation);
	expect(
		await app.startTask(
			Object.fromEntries(
				Object.entries(invocation).reverse(),
			) as typeof invocation,
		),
	).toBe(id);
	await expect(
		app.startTask({ ...invocation, inputs: "Different" }),
	).rejects.toThrow("different invocation");
	const settled = await app.harness.waitForTask(id as TaskId, context);
	expect(settled.state.outcome.status).toBe("completed");
	const view = await app.snapshot();
	expect(view.topics[0].id).toBe(invocation.topicId);
	expect(view.tasks[0].activity).toBe("idle");
	expect(view.tasks[0].status).toBe(settled.state.status);
	expect(view.tasks[0].workspace).not.toBe(invocation.repository);
	expect(view.tasks[0].detail).toBe("completed");
	const child = view.tasks[0].conversationId;
	if (child === undefined)
		throw new Error(
			"Completed skill did not retain its native conversation identity",
		);
	const host = serve(app),
		client = new ClientConnection(host.client);
	try {
		client.connect();
		await eventually(
			async () => client.state,
			(state) => state !== null,
		);
		expect(
			client.state?.sessions.find((session) => session.id === child),
		).toMatchObject({ task: id, writable: false });
		const details = await client.call("task.read", { id });
		expect(details.metadata).toMatchObject({
			id,
			conversationId: child,
			workspace: view.tasks[0].workspace,
		});
		expect(details.native).toMatchObject({
			status: "terminal",
			outcome: { status: "completed", result: "Implemented and verified." },
		});
		expect(details.reviews).toEqual([]);
		expect(details.attachments).toEqual([]);
		await expect(client.call("task.read", { id: 999999 })).rejects.toThrow();
		const transcript = await client.call("session.read", { id: child });
		expect(JSON.stringify(transcript)).toContain("Implemented and verified.");
		const messages = transcript.entries.flatMap((entry) =>
			Array.isArray(entry.model)
				? (entry.model as Record<string, unknown>[])
				: [],
		);
		const calls = messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) =>
				Array.isArray(message.content)
					? (message.content as Record<string, unknown>[])
					: [],
			)
			.filter((part) => part.type === "toolCall");
		const results = messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => result.toolName)).toEqual([
			"write",
			"edit",
			"read",
		]);
		for (const result of results)
			expect(calls.find((call) => call.id === result.toolCallId)?.name).toBe(
				result.toolName,
			);
		expect(
			results.find((result) => result.toolName === "edit")?.details,
		).toMatchObject({
			patch: expect.stringContaining("+Retained native edit"),
		});
		await expect(
			client.call("session.configure", { id: child, profile: "test" }),
		).rejects.toThrow();
	} finally {
		client.close();
		await host.stop();
	}
	const workspace = view.tasks[0].workspace;
	await git(workspace, ["add", "implementation.txt"]);
	await git(workspace, ["commit", "-m", "predecessor implementation"]);
	const baseCommit = (await git(workspace, ["rev-parse", "HEAD"])).trim();
	const baseRef = "continuation-base";
	await git(workspace, ["tag", baseRef]);
	const successor = await app.startTask({
		...invocation,
		requestId: "successor",
		relatedTo: id,
		baseRef,
		workspace: "worktree" as const,
	});
	await git(workspace, ["tag", "-f", baseRef, "HEAD~1"]);
	expect(
		(await app.harness.waitForTask(successor as TaskId, context)).state.outcome
			.status,
	).toBe("completed");
	const following = (await app.snapshot()).tasks.find(
		(task) => task.id === successor,
	);
	expect(following?.baseCommit).toBe(baseCommit);
	expect(following?.workspace).not.toBe(workspace);
	expect(
		fs.existsSync(path.join(invocation.repository, "implementation.txt")),
	).toBe(false);
	expect(fs.existsSync(sentinel)).toBe(false);
	config.profiles = [];
	config.repositories = [];
	expect(await app.startTask(invocation)).toBe(id);
});
test("unknown profiles, foreign repositories and related topics cannot be admitted", async () => {
	const { app, invocation } = await fixture();
	await expect(
		app.startTask({ ...invocation, profile: "missing" }),
	).rejects.toThrow("Unknown skill or profile");
	await expect(
		app.startTask({ ...invocation, repository: os.tmpdir() }),
	).rejects.toThrow("not authorized");
	await expect(
		app.startTask({ ...invocation, relatedTo: 999 }),
	).rejects.toThrow("Related task");
	await expect(
		app.startTask({ ...invocation, baseRef: "--not-a-ref" }),
	).rejects.toThrow();
	expect((await app.snapshot()).tasks).toHaveLength(0);
});

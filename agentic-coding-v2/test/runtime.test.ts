import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { digest } from "../src/config.ts";
import { git } from "../src/git.ts";
import { serve } from "../src/server/index.ts";
import { ClientConnection } from "../src/tui/client/connection.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
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
		expect(
			JSON.stringify(await client.call("session.read", { id: child })),
		).toContain("Implemented and verified.");
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
		policy: "read-only",
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
test("shell execution waits for human approval of its exact command", async () => {
	const { app, fake, invocation } = await fixture();
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", { command: "printf verified > approved.txt" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Review acknowledged."),
	]);
	const id = await app.startTask(invocation);
	const view = await eventually(
		() => app.snapshot(),
		(value) => value.reviews.length === 1,
	);
	const review = view.reviews[0];
	const proof = path.join(view.tasks[0].workspace, "approved.txt");
	expect(fs.existsSync(proof)).toBe(false);
	expect(view.tasks[0].detail).toBe("awaiting review");
	expect(view.tasks[0].activity).toBe("idle");
	await expect(
		app.decide(review.id, review.revision + 1, "approved", ""),
	).rejects.toThrow("stale");
	await app.decide(review.id, review.revision, "approved", "Looks good");
	expect(
		(await app.harness.waitForTask(id as TaskId, context)).state.outcome.status,
	).toBe("completed");
	expect(fs.readFileSync(proof, "utf8")).toBe("verified");
	await expect(
		app.decide(review.id, review.revision, "approved", ""),
	).rejects.toThrow("stale");
});
test("review and exact native task identity survive a host close/reopen", async () => {
	const { app, fake, invocation, open, config } = await fixture(true);
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("request_review", { path: ".", title: "Restart review" }),
			{ stopReason: "toolUse" },
		),
		(_transcript, _options, _state, model) => {
			expect(model.id).toBe("original");
			return fauxAssistantMessage("Recovered review.");
		},
		(_transcript, _options, _state, model) => {
			expect(model.id).toBe("replacement");
			return fauxAssistantMessage(
				"Restart uses the selected orchestrator profile.",
			);
		},
	]);
	const id = await app.startTask(invocation);
	const before = await eventually(
		() => app.snapshot(),
		(value) => value.reviews.length === 1,
	);
	await app.close();
	apps.splice(apps.indexOf(app), 1);
	config.profiles[0].modelId = "replacement";
	const reopened = await open();
	expect(await reopened.startTask(invocation)).toBe(id);
	const review = (await reopened.snapshot()).reviews[0];
	expect(review.id).toBe(before.reviews[0].id);
	await reopened.decide(
		review.id,
		review.revision,
		"changes-requested",
		"Revise it",
	);
	expect(
		(await reopened.harness.waitForTask(id as TaskId, context)).state.outcome
			.status,
	).toBe("completed");
	expect((await reopened.snapshot()).reviews).toHaveLength(1);
	await reopened.tick();
	await reopened.home.waitForIdle(context);
	expect(
		(await reopened.snapshot()).messages.some(
			(message) =>
				message.content === "Restart uses the selected orchestrator profile.",
		),
	).toBe(true);
});
test("cancellation reaches owned review and cannot be revived by a late approval", async () => {
	const { app, fake, invocation } = await fixture();
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("request_review", { path: ".", title: "Cancel me" }),
			{ stopReason: "toolUse" },
		),
	]);
	const id = await app.startTask(invocation);
	const view = await eventually(
		() => app.snapshot(),
		(value) => value.reviews.length === 1,
	);
	await app.cancel(id);
	expect(
		(await app.harness.waitForTask(id as TaskId, context)).state.outcome.status,
	).toBe("aborted");
	expect((await app.snapshot()).reviews[0].state).toBe("cancelled");
	await expect(
		app.decide(view.reviews[0].id, 1, "approved", ""),
	).rejects.toThrow("stale");
	fake.setResponses([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "429 Too Many Requests",
		}),
	]);
	const retrying = await app.startTask({
		...invocation,
		requestId: "retrying",
	});
	const sleeping = await eventually(
		() => app.snapshot(),
		(state) =>
			state.tasks.some(
				(task) =>
					task.id === retrying &&
					(task.detail.startsWith("sleeping") || task.result !== null),
			),
	);
	const backoff = sleeping.tasks.find((task) => task.id === retrying);
	expect(backoff?.detail).toStartWith("sleeping until");
	expect(backoff?.activity).toBe("idle");
	await app.cancel(retrying);
	expect(
		(await app.harness.waitForTask(retrying as TaskId, context)).state.outcome
			.status,
	).toBe("aborted");
});
test("completion is admitted to orchestrator chat once, even after repeated reconciliation", async () => {
	const { app, fake, invocation } = await fixture();
	fake.setResponses([
		fauxAssistantMessage("Task result"),
		fauxAssistantMessage("Here is the result."),
	]);
	const id = await app.startTask(invocation);
	await app.harness.waitForTask(id as TaskId, context);
	await app.tick();
	await app.tick();
	await app.home.waitForIdle(context);
	const view = await app.snapshot();
	expect(
		view.messages.filter((m) => m.content.startsWith("Task completion")),
	).toHaveLength(1);
	expect(view.messages.some((m) => m.content === "Here is the result.")).toBe(
		true,
	);
});

test("scheduled skills use the same task path, persist slots, avoid overlap and honor expiry", async () => {
	const { app, fake, invocation, open, config } = await fixture(true);
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("request_review", { path: ".", title: "Scheduled review" }),
			{ stopReason: "toolUse" },
		),
	]);
	const due = Date.now() + 5000;
	config.profiles.push({ ...config.profiles[0], id: "removed" });
	await app.scheduler.create(
		{ ...invocation, profile: "removed" },
		{ kind: "once", at: due },
		null,
		"invalid",
	);
	config.profiles.pop();
	await app.scheduler.create(
		invocation,
		{ kind: "interval", anchor: due, everyMs: 1000 },
		null,
		"daily",
	);
	await app.scheduler.create(
		invocation,
		{ kind: "once", at: due },
		100,
		"expires",
	);
	await app.tick(due + 200);
	const before = await eventually(
		() => app.snapshot(),
		(view) => view.reviews.length === 1,
	);
	expect(before.tasks).toHaveLength(1);
	expect(before.schedules.find((s) => s.id === "invalid")?.state).toBe(
		"paused",
	);
	expect(before.schedules.find((s) => s.id === "invalid")?.lastError).toContain(
		"profile",
	);
	expect(
		before.schedules.find((s) => s.id === "expires")?.history[0].result,
	).toBe("expired");
	await app.tick(due + 1000);
	expect(
		(await app.snapshot()).schedules.find((s) => s.id === "daily")?.history[1]
			.result,
	).toBe("skipped-overlap");
	await app.close();
	apps.splice(apps.indexOf(app), 1);
	const reopened = await open();
	await reopened.tick(due + 1000);
	expect((await reopened.snapshot()).tasks.map((task) => task.id)).toEqual(
		before.tasks.map((task) => task.id),
	);
	config.profiles = [];
	const replay = await reopened.scheduler.create(
		Object.fromEntries(
			Object.entries(invocation).reverse(),
		) as typeof invocation,
		{ at: due, kind: "once" },
		100,
		"expires",
	);
	expect(replay.nextDue).toBeNull();
	expect(replay.history).toEqual([{ due, task: null, result: "expired" }]);
	await expect(
		reopened.scheduler.create(
			{ ...invocation, inputs: "Different work" },
			{ kind: "once", at: due },
			100,
			"expires",
		),
	).rejects.toThrow("different request");
	expect((await reopened.snapshot()).schedules).toHaveLength(3);
});

test("screenshots reach chat and the authenticated HTTP surface renders images without enabling HTML", async () => {
	const { app, fake, invocation } = await fixture();
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==",
		"base64",
	);
	const image = `![Screenshot](/attachments/${digest(png)})`;
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("request_review", { path: ".", title: "Capture ready" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			fauxToolCall("attach_image", {
				path: "capture.png",
				caption: "Screenshot",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(image),
		fauxAssistantMessage(
			`${image}\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))`,
		),
	]);
	const id = await app.startTask(invocation);
	const waiting = await eventually(
		() => app.snapshot(),
		(view) => view.reviews.length === 1,
	);
	fs.writeFileSync(path.join(waiting.tasks[0].workspace, "capture.png"), png);
	const host = serve(app);
	try {
		const url = new URL(host.url);
		const origin = url.origin;
		const headers = {
			Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
			"Content-Type": "application/json",
		};
		expect((await fetch(`${origin}/api/state`)).status).toBe(401);
		const lifecycle = await fetch(`${origin}/environment-lifecycle.js`);
		expect(lifecycle.status).toBe(200);
		expect(lifecycle.headers.get("content-type")).toContain("text/javascript");
		expect(lifecycle.headers.get("x-content-type-options")).toBe("nosniff");
		const imageScript = await fetch(`${origin}/authenticated-message.js`);
		expect(imageScript.status).toBe(200);
		expect(imageScript.headers.get("x-content-type-options")).toBe("nosniff");
		const review = waiting.reviews[0];
		const body = JSON.stringify({
			revision: review.revision,
			decision: "approved",
			comments: "",
		});
		expect(
			(
				await fetch(`${origin}/api/reviews/${review.id}`, {
					method: "POST",
					headers: { ...headers, Origin: "https://untrusted.invalid" },
					body,
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(`${origin}/api/reviews/${review.id}`, {
					method: "POST",
					headers,
					body,
				})
			).status,
		).toBe(200);
		await app.harness.waitForTask(id as TaskId, context);
		await app.tick();
		await app.home.waitForIdle(context);
		const response = await fetch(`${origin}/api/state`, { headers });
		const state = (await response.json()) as { messages: { html: string }[] };
		const rendered = state.messages.at(-1)?.html ?? "";
		expect(rendered).toContain(
			`<img loading="lazy" src="/attachments/${digest(png)}"`,
		);
		expect(rendered).not.toContain("<script>");
		expect(rendered).not.toContain('href="javascript:');
		const login = await fetch(`${origin}/api/session`, {
			method: "POST",
			headers,
			body: "{}",
		});
		expect(login.status).toBe(200);
		expect(login.headers.get("set-cookie")).toBeNull();
		expect((await fetch(`${origin}/attachments/${digest(png)}`)).status).toBe(
			401,
		);
		expect(
			(
				await fetch(`${origin}/api/state`, {
					headers: { Cookie: `acv2_fixture=${headers.Authorization.slice(7)}` },
				})
			).status,
		).toBe(401);
		const attachment = await fetch(`${origin}/attachments/${digest(png)}`, {
			headers,
		});
		expect(attachment.headers.get("content-security-policy")).toContain(
			"img-src 'self' blob:",
		);
		expect(attachment.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await attachment.arrayBuffer())).toEqual(png);
	} finally {
		await host.stop();
	}
});

test("file tools cannot overwrite outside the task workspace", async () => {
	const { app, fake, invocation, config } = await fixture();
	const outside = path.join(config.stateDir, "outside.txt");
	fs.writeFileSync(outside, "preserved");
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: outside, content: "forbidden" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Cannot write outside the workspace."),
	]);
	const id = await app.startTask(invocation);
	await app.harness.waitForTask(id as TaskId, context);
	expect(fs.readFileSync(outside, "utf8")).toBe("preserved");
});

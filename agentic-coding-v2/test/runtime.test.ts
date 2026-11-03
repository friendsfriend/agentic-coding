import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { type Config, digest } from "../src/config.ts";
import { git } from "../src/git.ts";
import { Runtime } from "../src/runtime.ts";
import { serve } from "../src/server.ts";

const roots: string[] = [];
const apps: Runtime[] = [];
afterEach(async () => {
	for (const app of apps.splice(0)) await app.close();
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(persistent = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-v2-test-"));
	roots.push(root);
	const repo = path.join(root, "repo");
	fs.mkdirSync(repo);
	await git(repo, ["init", "-b", "main"]);
	await git(repo, ["config", "user.name", "Test"]);
	await git(repo, ["config", "user.email", "test@example.invalid"]);
	fs.writeFileSync(path.join(repo, "README.md"), "Initial\n");
	await git(repo, ["add", "README.md"]);
	await git(repo, ["commit", "-m", "initial"]);
	const fake = fauxProvider({
		models: [{ id: "original" }, { id: "replacement" }],
	});
	const models = createModels();
	models.setProvider(fake.provider);
	const model = fake.getModel();
	const stateDir = path.join(root, "state");
	fs.mkdirSync(stateDir);
	const config: Config = {
		profiles: [
			{
				id: "test",
				provider: model.provider,
				modelId: model.id,
				thinking: "off",
				description: "test",
			},
		],
		orchestratorProfile: "test",
		repositories: [fs.realpathSync(repo)],
		skills: [
			{
				id: "code",
				content: "Implement the task",
				description: "test skill",
				digest: digest("Implement the task"),
				readOnly: false,
			},
		],
		stateDir,
	};
	const open = async () => {
		const app = await Runtime.open(
			config,
			models,
			persistent
				? await openNodeJsonlStorage(path.join(stateDir, "native"), context, {
						fsync: true,
					})
				: new MemoryStorage(),
		);
		apps.push(app);
		return app;
	};
	const app = await open();
	const invocation = {
		policy: "workspace-write" as const,
		topicId: "Improve task execution",
		skill: "code",
		profile: "test",
		repository: config.repositories[0],
		inputs: "Explain the change",
		requestId: "task-1",
	};
	return { app, config, fake, open, invocation };
}
async function eventually<T>(
	read: () => Promise<T>,
	check: (value: T) => boolean,
): Promise<T> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const value = await read();
		if (check(value)) return value;
		await Bun.sleep(10);
	}
	throw new Error("Condition did not become true");
}
test("native skill task completes in a separate worktree; admission is idempotent and content-bound", async () => {
	const { app, fake, invocation, config } = await fixture();
	fake.setResponses([fauxAssistantMessage("Implemented and verified.")]);
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
		const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(login.headers.get("set-cookie")).toContain("HttpOnly");
		const attachment = await fetch(`${origin}/attachments/${digest(png)}`, {
			headers: { Cookie: cookie },
		});
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

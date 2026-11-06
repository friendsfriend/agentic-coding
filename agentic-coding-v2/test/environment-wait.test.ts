import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
async function application(persistent = false) {
	return fixture(persistent, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								readyText: "READY",
								command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("require('node:fs').appendFileSync(process.env.CONFIG_DIR+'/order',process.env.WORKSPACE+'\\n');console.log('READY');setInterval(()=>{},1000)")}`,
							},
						],
					},
				],
			}),
		);
	});
}
test("explicit retained waits preserve FIFO across bounded native calls and start nothing between continuations", async () => {
	const { app, fake, invocation, config } = await application();
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Holder" }),
	]);
	const holder = await app.startTask(invocation);
	await approve(app, holder);
	await pendingReview(app, holder, "Holder");
	let acquisition = "",
		queuedAt = 0,
		ordinal = 0,
		secondQueuedAt = 0;
	fake.setResponses([
		call("env_start", { apps: ["api"], retainQueue: true, timeoutSec: 1 }),
		(messages) => {
			for (const message of messages.messages)
				if (message.role === "toolResult" && message.toolName === "env_start")
					for (const part of message.content)
						if (part.type === "text") {
							const result = JSON.parse(part.text);
							acquisition = result.acquisition;
							queuedAt = result.queuedAt;
							ordinal = result.ordinal;
						}
			return call("request_review", { path: ".", title: "Between bounds" });
		},
	]);
	const first = await app.startTask({
		...invocation,
		requestId: "retained-first",
	});
	const review = await pendingReview(app, first);
	expect(review.snapshot).toContain('"retainQueue": true');
	await approve(app, first);
	await pendingReview(app, first, "Between bounds");
	expect(acquisition).toMatch(/^env-/);
	expect(queuedAt).toBeGreaterThan(0);
	fake.setResponses([call("env_start", { apps: ["api"], timeoutSec: 30 })]);
	const later = await app.startTask({
		...invocation,
		requestId: "later-waiter",
	});
	await approve(app, later);
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.waiters.some((waiter) => waiter.owner === later),
	);
	fake.setResponses([
		call("env_wait", { acquisition, timeoutSec: 1 }),
		(messages) => {
			for (const message of messages.messages)
				if (message.role === "toolResult" && message.toolName === "env_wait")
					for (const part of message.content)
						if (part.type === "text")
							secondQueuedAt = JSON.parse(part.text).queuedAt;
			return call("request_review", { path: ".", title: "After second bound" });
		},
	]);
	await approve(app, first, "Between bounds");
	await pendingReview(app, first, "After second bound");
	expect(secondQueuedAt).toBe(queuedAt);
	expect(
		(await app.environments.snapshot()).waits.find(
			(wait) => wait.batch === acquisition,
		),
	).toMatchObject({ state: "waiting", live: true, ordinal });
	await app.cancel(holder);
	await app.harness.waitForTask(holder as TaskId, context);
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toHaveLength(1);
	fake.setResponses([
		call("env_wait", { acquisition, timeoutSec: 30 }),
		call("request_review", { path: ".", title: "Acquired first" }),
	]);
	await approve(app, first, "After second bound");
	await pendingReview(app, first, "Acquired first");
	expect(
		(await app.environments.snapshot()).runs
			.filter((run) => run.state === "running")
			.map((run) => run.owner),
	).toEqual([first]);
	fake.setResponses([
		call("request_review", { path: ".", title: "Acquired later" }),
	]);
	await app.cancel(first);
	await app.harness.waitForTask(first as TaskId, context);
	await pendingReview(app, later, "Acquired later");
	const state = await app.environments.snapshot();
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toEqual(
		[holder, first, later].map(
			(owner) =>
				state.runs.find((run) => run.owner === owner)?.plan.workspace ?? "",
		),
	);
	await app.cancel(later);
	await app.harness.waitForTask(later as TaskId, context);
	expect((await app.environments.snapshot()).waiters).toHaveLength(0);
}, 20000);
test("foreign continuation and stopped retained queues cannot acquire or borrow the original approval", async () => {
	const { app, fake, invocation, config } = await application();
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Holder" }),
	]);
	const holder = await app.startTask(invocation);
	await approve(app, holder);
	await pendingReview(app, holder, "Holder");
	let acquisition = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], retainQueue: true, timeoutSec: 1 }),
		(messages) => {
			for (const message of messages.messages)
				if (message.role === "toolResult" && message.toolName === "env_start")
					for (const part of message.content)
						if (part.type === "text")
							acquisition = JSON.parse(part.text).acquisition;
			return call("request_review", { path: ".", title: "Queued" });
		},
	]);
	const queued = await app.startTask({
		...invocation,
		requestId: "queued-stop",
	});
	await approve(app, queued);
	await pendingReview(app, queued, "Queued");
	let refusal = "";
	fake.setResponses([
		call("env_wait", { acquisition, timeoutSec: 1 }),
		(messages) => {
			refusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_wait",
				),
			);
			return fauxAssistantMessage("No borrowed authority");
		},
	]);
	const foreign = await app.startTask({
		...invocation,
		requestId: "foreign-wait",
	});
	await app.harness.waitForTask(foreign as TaskId, context);
	expect(refusal).toContain("Only the original native owner");
	fake.setResponses([
		call("env_stop", { apps: ["api"] }),
		call("env_wait", { acquisition, timeoutSec: 1 }),
		(messages) => {
			refusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_wait",
				),
			);
			return call("request_review", { path: ".", title: "Stopped" });
		},
	]);
	await approve(app, queued, "Queued");
	await pendingReview(app, queued, "Stopped");
	expect(refusal).toContain("closing or cancelled");
	expect(
		(await app.environments.snapshot()).waits.find(
			(wait) => wait.batch === acquisition,
		),
	).toMatchObject({ state: "cancelled", live: false });
	await app.cancel(holder);
	await app.harness.waitForTask(holder as TaskId, context);
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toHaveLength(1);
	await app.cancel(queued);
}, 15000);
test("host reopen keeps retained queue history diagnostic and never restores approval as a live acquisition", async () => {
	const state = await application(true),
		{ app, fake, invocation, config } = state;
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Holder" }),
	]);
	const holder = await app.startTask(invocation);
	await approve(app, holder);
	await pendingReview(app, holder, "Holder");
	let acquisition = "",
		liveRefusal = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], retainQueue: true, timeoutSec: 1 }),
		(messages) => {
			for (const message of messages.messages)
				if (message.role === "toolResult" && message.toolName === "env_start")
					for (const part of message.content)
						if (part.type === "text")
							acquisition = JSON.parse(part.text).acquisition;
			return call("env_start", {
				apps: ["api"],
				recoverAcquisition: acquisition,
			});
		},
		(messages) => {
			liveRefusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_start",
				),
			);
			return call("request_review", {
				path: ".",
				title: "Queued before close",
			});
		},
	]);
	const queued = await app.startTask({
		...invocation,
		requestId: "queued-reopen",
	});
	await approve(app, queued);
	await pendingReview(app, queued, "Queued before close");
	expect(liveRefusal).toContain("interrupted retained wait");
	expect(
		(await app.environments.snapshot()).waits.find(
			(wait) => wait.batch === acquisition,
		),
	).toMatchObject({ state: "waiting", live: true });
	await app.close();
	let refusal = "";
	fake.setResponses([
		call("env_wait", { acquisition, timeoutSec: 1 }),
		(messages) => {
			refusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_wait",
				),
			);
			return call("request_review", { path: ".", title: "No adoption" });
		},
	]);
	const reopened = await state.open();
	expect(
		(await reopened.environments.snapshot()).waits.find(
			(wait) => wait.batch === acquisition,
		),
	).toMatchObject({ state: "interrupted", live: false });
	await approve(reopened, queued, "Queued before close");
	await pendingReview(reopened, queued, "No adoption");
	expect(refusal).toContain("saved receipts cannot restore queue authority");
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toHaveLength(1);
	let foreignRefusal = "",
		selectionRefusal = "";
	fake.setResponses([
		call("env_start", { apps: ["api"], recoverAcquisition: acquisition }),
		(messages) => {
			foreignRefusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_start",
				),
			);
			return call("request_review", {
				path: ".",
				title: "Foreign recovery refused",
			});
		},
	]);
	const foreign = await reopened.startTask({
		...invocation,
		requestId: "foreign-recovery",
	});
	await pendingReview(reopened, foreign, "Foreign recovery refused");
	expect(foreignRefusal).toContain("interrupted retained wait");
	await reopened.cancel(foreign);
	fake.setResponses([
		call("env_start", {
			apps: ["different-app"],
			recoverAcquisition: acquisition,
		}),
		(messages) => {
			selectionRefusal = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_start",
				),
			);
			return call("env_start", {
				apps: ["api"],
				recoverAcquisition: acquisition,
			});
		},
		call("request_review", {
			path: ".",
			title: "Recovered with fresh approval",
		}),
	]);
	await approve(reopened, queued, "No adoption");
	const freshReview = await pendingReview(reopened, queued);
	expect(selectionRefusal).toContain("original requested apps");
	expect(freshReview.snapshot).toContain(acquisition);
	expect(freshReview.snapshot).toContain("no restored position");
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toHaveLength(1);
	await approve(reopened, queued);
	await pendingReview(reopened, queued, "Recovered with fresh approval");
	expect(
		fs
			.readFileSync(path.join(config.configDir, "order"), "utf8")
			.trim()
			.split("\n"),
	).toHaveLength(2);
	expect(
		(await reopened.environments.snapshot()).waits.find(
			(wait) => wait.batch === acquisition,
		),
	).toMatchObject({ state: "interrupted", live: false });
	await reopened.cancel(queued);
	await reopened.cancel(holder);
}, 15000);

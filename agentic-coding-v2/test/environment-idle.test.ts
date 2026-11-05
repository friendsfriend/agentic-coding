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

test("agent activity renews every approved root; second acquisitions are refused and idle cleanup preserves operator runs", async () => {
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "config.json"),
			JSON.stringify({ environment: { instances: { idle_ttl_minutes: 1 } } }),
		);
		const target = {
			id: "serve",
			action: "run",
			runtime: "shell",
			readyText: "READY",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('READY');setInterval(()=>{},1000)")}`,
		};
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						requires: ["cache"],
						targets: [target],
					},
					{
						id: "cache",
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [target],
					},
					{
						id: "editor",
						kind: "app",
						repository: config.repositories[0],
						targets: [target],
					},
					{
						id: "console",
						kind: "app",
						repository: config.repositories[0],
						targets: [target],
					},
				],
			}),
		);
	});
	let secondAcquisition = "";
	fake.setResponses([
		call("env_start", { apps: ["api", "editor"] }),
		call("request_review", { path: ".", title: "Before renewal" }),
		call("env_status", { app: "api" }),
		call("request_review", { path: ".", title: "After renewal" }),
		call("env_start", { apps: ["api"] }),
		call("env_start", { apps: ["console"], retainQueue: true, timeoutSec: 1 }),
		(messages) => {
			for (const message of messages.messages)
				if (message.role === "toolResult" && message.toolName === "env_start")
					for (const part of message.content)
						if (part.type === "text") secondAcquisition = part.text;
			return call("request_review", {
				path: ".",
				title: "Reacquired after idle cleanup",
			});
		},
	]);
	const agent = await app.startTask(invocation);
	const start = await pendingReview(app, agent);
	expect(start.snapshot).toContain("idleScope");
	expect(start.snapshot).toContain("including unrelated apps");
	await approve(app, agent);
	await pendingReview(app, agent, "Before renewal");
	const initial = (await app.environments.snapshot("api")).runs[0];
	const before = initial?.idle.lastActivityAt;
	if (!initial || before === null || before === undefined)
		throw new Error("No native agent activity");
	expect(initial.idle.ttlMs).toBe(60_000);
	expect(initial.idle.protection).toBeNull();
	expect(initial.idle).toMatchObject({
		ownerHeldRuns: 3,
		ownerBatches: 1,
		dependencyScope: "exclusive-coupled-batch",
		activityScope: "all-held-runs-of-native-owner",
	});
	await app.tick(before);
	const operator = await app.startEnvironmentAction({
		apps: ["console"],
		action: "run",
		requestId: "protected-operator",
	});
	await approve(app, operator);
	const owned = await eventually(
		() => app.environments.snapshot("console"),
		(state) => state.runs.some((run) => run.state === "running"),
	);
	expect(owned.runs[0]?.idle.protection).toBe("operator-owner");
	expect(owned.runs[0]?.idle.ttlMs).toBeNull();
	// The public operator observation must not keep an otherwise idle agent alive.
	await app.environments.selectedLogs("api", undefined, {});
	expect(
		(await app.environments.snapshot("api")).runs[0]?.idle.lastActivityAt,
	).toBe(before);
	await approve(app, agent, "Before renewal");
	await pendingReview(app, agent, "After renewal");
	const renewed = (await app.environments.snapshot("api")).runs[0]?.idle
		.lastActivityAt;
	if (renewed === null || renewed === undefined)
		throw new Error("Missing renewed activity");
	expect(renewed).toBeGreaterThan(before);
	expect(
		(await app.environments.snapshot("editor")).runs[0]?.idle.lastActivityAt,
	).toBe(renewed);
	await app.tick(before + 60_000);
	expect(
		(await app.environments.snapshot()).runs.filter(
			(run) => run.state === "running",
		),
	).toHaveLength(4);
	await app.tick(before + 120_000);
	const stopped = await app.environments.snapshot();
	const expired = stopped.runs.filter((run) => run.owner === agent);
	expect(expired).toHaveLength(3);
	expect(
		expired.every(
			(run) =>
				run.state === "exited" && run.idleReap?.lastActivityAt === renewed,
		),
	).toBe(true);
	expect(stopped.runs.find((run) => run.owner === operator)?.state).toBe(
		"running",
	);
	expect(
		(await app.harness.getTask(agent as TaskId, context))?.state.status,
	).not.toBe("terminal");
	expect((await pendingReview(app, agent, "After renewal")).state).toBe(
		"pending",
	);
	await approve(app, agent, "After renewal");
	await approve(app, agent);
	await approve(app, agent); // Attempt a retained second acquisition while already holding api/cache.
	await pendingReview(app, agent, "Reacquired after idle cleanup");
	expect(secondAcquisition).toContain(
		"Release your existing app batch before acquiring another",
	);
	expect(
		(await app.environments.snapshot()).waits
			.filter((wait) => wait.owner === agent)
			.every((wait) => wait.state !== "waiting"),
	).toBe(true);
	const reacquired = (await app.environments.snapshot()).runs.filter(
		(run) => run.owner === agent && run.state === "running",
	);
	expect(reacquired).toHaveLength(2);
	expect(
		reacquired.every((run) => run.id !== initial.id && !run.idleReap),
	).toBe(true);
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ environment: { instances: { idle_ttl_minutes: 0 } } }),
	);
	await app.tick(before + 180_000);
	const fallback = (await app.environments.snapshot("api")).runs.find(
		(run) => run.state === "running",
	);
	expect(fallback?.idle.ttlMs).toBe(30 * 60_000);
	expect(fallback?.idle.policySource).toBe(
		"default-missing-or-unusable-policy",
	);
	fs.writeFileSync(
		path.join(config.configDir, "config.json"),
		JSON.stringify({ environment: { instances: { idle_ttl_minutes: 1 } } }),
	);
	await app.tick(before + 240_000);
	expect(
		(await app.environments.snapshot()).runs
			.filter((run) => run.owner === agent)
			.every((run) => run.state === "exited"),
	).toBe(true);
	expect((await app.environments.snapshot("console")).runs[0]?.state).toBe(
		"running",
	);
	await app.cancel(agent);
	await app.cancel(operator);
	await app.harness.waitForTask(agent as TaskId, context);
	await app.harness.waitForTask(operator as TaskId, context);
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
}, 15_000);

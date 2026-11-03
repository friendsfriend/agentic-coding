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

test("agent batch activity renews idle expiry; normal reaping cleans dependencies, preserves operator runs and permits the coding task to reacquire", async () => {
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
						id: "console",
						kind: "app",
						repository: config.repositories[0],
						targets: [target],
					},
				],
			}),
		);
	});
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Before renewal" }),
		call("env_status", { app: "api" }),
		call("request_review", { path: ".", title: "After renewal" }),
		call("env_start", { apps: ["api"] }),
		call("request_review", {
			path: ".",
			title: "Reacquired after idle cleanup",
		}),
	]);
	const agent = await app.startTask(invocation);
	const start = await pendingReview(app, agent);
	expect(start.snapshot).toContain("idleScope");
	await approve(app, agent);
	await pendingReview(app, agent, "Before renewal");
	const initial = (await app.environments.snapshot("api")).runs[0];
	const before = initial?.idle.lastActivityAt;
	if (!initial || before === null || before === undefined)
		throw new Error("No native agent activity");
	expect(initial.idle.ttlMs).toBe(60_000);
	expect(initial.idle.protection).toBeNull();
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
	await app.tick(before + 60_000);
	expect(
		(await app.environments.snapshot()).runs.filter(
			(run) => run.state === "running",
		),
	).toHaveLength(3);
	await app.tick(before + 120_000);
	const stopped = await app.environments.snapshot();
	const expired = stopped.runs.filter((run) => run.owner === agent);
	expect(expired).toHaveLength(2);
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
	await pendingReview(app, agent, "Reacquired after idle cleanup");
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

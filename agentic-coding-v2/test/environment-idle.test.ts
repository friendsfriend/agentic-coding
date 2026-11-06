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

test("explicit standalone roots expire independently without revoking a sibling endpoint; graph requests and additional acquisitions remain refused", async () => {
	const probe = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(""),
	});
	const port = probe.port;
	probe.stop(true);
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
		const requests = path.join(config.configDir, "requests");
		const source = `const fs=require('node:fs');Bun.serve({hostname:'127.0.0.1',port:${port},async fetch(r){fs.appendFileSync(${JSON.stringify(requests)},new URL(r.url).pathname+'\\n');await new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(config.configDir, "release-http"))})){clearInterval(t);resolve()}},5)});return new Response('independent-ok')}});console.log('READY')`;
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
								...target,
								command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
								endpoints: { web: `http://127.0.0.1:${port}` },
							},
						],
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
					{
						id: "dependent",
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
				],
			}),
		);
	});
	let graphRefusal = "",
		httpResult = "",
		afterResult = "",
		extraRefusal = "",
		legacyRefusal = "";
	const resultText = (messages: {
		messages: { role: string; content: unknown }[];
	}) =>
		JSON.stringify(
			messages.messages
				.filter((message) => message.role === "toolResult")
				.at(-1)?.content ?? [],
		);
	fake.setResponses([
		call("env_start", {
			apps: ["dependent"],
			lifetime: "independent-roots-v1",
		}),
		(messages) => {
			graphRefusal = resultText(messages);
			return call("env_start", {
				apps: ["api", "editor", "console"],
				lifetime: "independent-roots-v1",
			});
		},
		call("env_stop", { apps: ["console"] }),
		call("request_review", { path: ".", title: "Independent before renewal" }),
		call("env_status", { app: "api" }),
		call("env_http_get", { app: "api", endpoint: "web", path: "/health" }),
		(messages) => {
			httpResult = resultText(messages);
			return call("request_review", {
				path: ".",
				title: "Independent after HTTP",
			});
		},
		call("env_http_get", {
			app: "api",
			endpoint: "web",
			path: "/after-expiry",
		}),
		(messages) => {
			afterResult = resultText(messages);
			return call("env_start", {
				apps: ["editor"],
				lifetime: "independent-roots-v1",
			});
		},
		(messages) => {
			extraRefusal = resultText(messages);
			return call("env_start", { apps: ["api"] });
		},
		(messages) => {
			legacyRefusal = resultText(messages);
			return call("env_stop", { apps: ["api"] });
		},
		call("request_review", { path: ".", title: "Independent done" }),
	]);
	const agent = await app.startTask(invocation);
	const review = await pendingReview(app, agent);
	expect(graphRefusal).toContain(
		"standalone app roots without declared dependencies",
	);
	expect(JSON.parse(review.snapshot)).toHaveProperty(
		"plans.0.lifetime",
		"independent-roots-v1",
	);
	expect(review.snapshot).toContain("expired-sibling reacquisition");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await approve(app, agent);
	await pendingReview(app, agent, "Independent before renewal");
	const initial = await app.environments.snapshot();
	const before = initial.runs.find((run) => run.plan.app === "editor")?.idle
		.lastActivityAt;
	if (before === null || before === undefined)
		throw new Error("Missing independent clock");
	expect(initial.runs).toHaveLength(3);
	expect(initial.runs.find((run) => run.plan.app === "console")?.state).toBe(
		"exited",
	);
	expect(initial.runs.filter((run) => run.state === "running")).toHaveLength(2);
	expect(
		initial.runs.every(
			(run) =>
				run.idle.scope === "independent-native-root" &&
				run.idle.ownerHeldRuns === 2,
		),
	).toBe(true);
	await app.tick(before);
	await app.environments.selectedLogs("editor", undefined, {});
	expect(
		(await app.environments.snapshot("editor")).runs[0]?.idle.lastActivityAt,
	).toBe(before);
	await approve(app, agent, "Independent before renewal");
	await pendingReview(app, agent, "Endpoint GET: api/web");
	const renewed = (await app.environments.snapshot("api")).runs[0]?.idle
		.lastActivityAt;
	if (renewed === null || renewed === undefined)
		throw new Error("Missing root renewal");
	expect(renewed).toBeGreaterThan(before);
	expect(
		(await app.environments.snapshot("editor")).runs[0]?.idle.lastActivityAt,
	).toBe(before);
	await approve(app, agent, "Endpoint GET: api/web");
	const inFlight = await eventually(
		() => app.environments.snapshot(),
		(state) =>
			state.runs.some(
				(run) =>
					run.plan.app === "api" &&
					run.idle.protection === "operation-in-flight",
			) && fs.existsSync(path.join(config.configDir, "requests")),
	);
	expect(
		inFlight.runs.find((run) => run.plan.app === "editor")?.idle.protection,
	).toBeNull();
	// Both clocks are now past TTL: only the root with an actual live exchange is protected.
	await app.tick(before + 120_000);
	const expired = await app.environments.snapshot();
	expect(expired.runs.find((run) => run.plan.app === "editor")).toMatchObject({
		state: "exited",
		idleReap: { lastActivityAt: before },
	});
	expect(expired.runs.find((run) => run.plan.app === "api")).toMatchObject({
		state: "running",
		endpoints: { web: `http://127.0.0.1:${port}/` },
	});
	expect(
		(await app.harness.getTask(agent as TaskId, context))?.state.status,
	).not.toBe("terminal");
	fs.writeFileSync(
		path.join(config.configDir, "release-http"),
		"release disposable response",
	);
	await pendingReview(app, agent, "Independent after HTTP");
	await approve(app, agent, "Independent after HTTP");
	await approve(app, agent, "Endpoint GET: api/web"); // New operation after root B cleanup.
	await approve(app, agent); // Expired sibling cannot be reacquired while api is held.
	await approve(app, agent); // Legacy-mode plan cannot reuse an independent-mode receipt.
	await pendingReview(app, agent, "Independent done");
	expect(httpResult).toContain("independent-ok");
	expect(afterResult).toContain("independent-ok");
	expect(fs.readFileSync(path.join(config.configDir, "requests"), "utf8")).toBe(
		"/health\n/after-expiry\n",
	);
	expect(extraRefusal).toContain(
		"Release your existing app batch before acquiring another",
	);
	expect(legacyRefusal).toContain(
		"Release your existing app batch before acquiring another",
	);
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	await app.cancel(agent);
	await app.harness.waitForTask(agent as TaskId, context);
}, 15_000);

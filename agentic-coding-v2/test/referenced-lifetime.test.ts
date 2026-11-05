import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Config } from "../src/config.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
/** Two app roots sharing a two-level shell prerequisite chain. */
function referenced(config: Config, port?: number) {
	fs.mkdirSync(config.configDir);
	const node = (source: string) =>
		`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
	const project = (
		id: string,
		kind: "app" | "infrastructure",
		requires?: string[],
		port?: number,
	) => ({
		id,
		kind,
		repository: config.repositories[0],
		...(requires ? { requires } : {}),
		targets: [
			{
				id: "serve",
				action: "run",
				runtime: "shell",
				timeoutMs: 10000,
				readyText: "READY",
				...(port
					? {
							telemetry: { protocol: "otlp-http-json", listen: "127.0.0.1:0" },
							endpoints: { web: `http://127.0.0.1:${port}` },
						}
					: {}),
				command: node(
					`const fs=require('node:fs');fs.appendFileSync(process.env.STARTS,${JSON.stringify(`${id}\n`)});process.on('SIGTERM',()=>{fs.appendFileSync(process.env.STOPS,${JSON.stringify(`${id}\n`)});process.exit(0)})${port ? `;Bun.serve({hostname:'127.0.0.1',port:${port},fetch(){fs.appendFileSync(process.env.REQUESTS,${JSON.stringify(`${id}\n`)});return new Response('referenced-ok')}})` : ""};console.log('READY');setInterval(()=>{},1000)`,
				),
				environment: {
					STARTS: path.join(config.configDir, `${id}-starts`),
					STOPS: path.join(config.configDir, "stops"),
					REQUESTS: path.join(config.configDir, "requests"),
				},
			},
		],
	});
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify({
			version: 1,
			projects: [
				project("api", "app", ["cache"], port),
				project("worker", "app", ["cache"]),
				project("cache", "infrastructure", ["base"]),
				project("base", "infrastructure"),
			],
		}),
	);
	return config.configDir;
}
test("referenced roots are stopped one at a time and prerequisites are released only with the last reference", async () => {
	const { app, config, fake, invocation } = await fixture(false, referenced);
	fake.setResponses([
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "referenced-roots-v1",
		}),
		call("request_review", { path: ".", title: "Hold referenced roots" }),
	]);
	const owner = await app.startTask(invocation);
	const review = await pendingReview(app, owner);
	expect(review.snapshot).toContain("referenced-roots-v1");
	expect(review.snapshot).toContain(
		"keeps this one acquisition but not the coupled per-member stop",
	);
	expect(review.snapshot).toContain(
		"Direct stop of a still-referenced prerequisite is refused",
	);
	await approve(app, owner);
	await pendingReview(app, owner, "Hold referenced roots");
	const held = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.filter((run) => run.state === "running").length === 4,
	);
	const byApp = (app: string) =>
		held.runs.find((run) => run.plan.app === app && run.state === "running");
	// One atomic acquisition: every member started once, in dependency order.
	expect(
		held.runs.filter((run) => run.batch === held.runs[0]?.batch),
	).toHaveLength(4);
	const cache = byApp("cache"),
		base = byApp("base");
	expect(cache?.idle.dependencyScope).toBe("referenced-prerequisite-closure");
	expect(cache?.idle.protection).toBe("referenced-prerequisite");
	expect(base?.idle.protection).toBe("referenced-prerequisite");
	expect(byApp("api")?.idle.scope).toBe("referenced-native-root");
	expect(byApp("api")?.idle.protection).toBeNull();

	const api = await app.environments.stopOnce("stop-referenced-api", owner, [
		"api",
	]);
	expect(api).toHaveLength(1);
	const afterApi = await eventually(
		() => app.environments.snapshot(),
		(state) =>
			state.runs.find((run) => run.id === api[0])?.state === "exited" &&
			state.runs.filter((run) => run.state === "running").length === 3,
	);
	// The remaining root keeps its whole prerequisite closure live.
	expect(
		afterApi.runs
			.filter((run) => run.state === "running")
			.map((run) => run.plan.app)
			.sort(),
	).toEqual(["base", "cache", "worker"]);

	await expect(
		app.environments.stopOnce("stop-referenced-cache", owner, ["cache"]),
	).rejects.toThrow(
		"Referenced prerequisites cannot be stopped while a declared root still references them",
	);

	const worker = await app.environments.stopOnce(
		"stop-referenced-worker",
		owner,
		["worker"],
	);
	expect(worker).toHaveLength(1);
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	// Last reference releases dependent-first, through original live handles.
	const stops = fs
		.readFileSync(path.join(config.configDir, "stops"), "utf8")
		.trim()
		.split("\n");
	expect(stops).toEqual(["api", "worker", "cache", "base"]);
	await expect(
		app.environments.stopOnce("stop-referenced-api", owner, ["api"]),
	).resolves.toEqual(api);
});
test("losing a live prerequisite releases every root that declared it, dependent-first", async () => {
	const { app, config, fake, invocation } = await fixture(false, referenced);
	fake.setResponses([
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "referenced-roots-v1",
		}),
		call("request_review", { path: ".", title: "Hold referenced roots" }),
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	await pendingReview(app, owner, "Hold referenced roots");
	const held = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.filter((run) => run.state === "running").length === 4,
	);
	const cache = held.runs.find((run) => run.plan.app === "cache");
	expect(cache).toBeDefined();
	// An external engine loss of the shared prerequisite, not a native stop.
	process.kill(-(cache?.pid ?? 0), "SIGTERM");
	const released = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(released.runs.map((run) => run.plan.app).sort()).toEqual([
		"api",
		"base",
		"cache",
		"worker",
	]);
	// Both referencing roots were released before the surviving prerequisite.
	const stops = fs
		.readFileSync(path.join(config.configDir, "stops"), "utf8")
		.trim()
		.split("\n");
	expect(stops[0]).toBe("cache");
	expect(stops.slice(1, 3).sort()).toEqual(["api", "worker"]);
	expect(stops[3]).toBe("base");
});

test("referenced diagnostics name their exact root generation and prerequisite closure", async () => {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response("unused"),
	});
	const port = probe.port;
	probe.stop(true);
	const { app, config, fake, invocation } = await fixture(false, (config) =>
		referenced(config, port),
	);
	let receipts: string[] = [];
	fake.setResponses([
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "referenced-roots-v1",
		}),
		call("env_http_request", { app: "api", endpoint: "web" }),
		call("otel_query", { app: "api", mode: "traces" }),
		call("env_stop", { apps: ["api"] }),
		call("env_http_request", { app: "api", endpoint: "web" }),
		(messages) => {
			receipts = messages.messages
				.filter(
					(message) =>
						message.role === "toolResult" &&
						["env_http_request", "otel_query"].includes(message.toolName ?? ""),
				)
				.map((message) =>
					(
						message as unknown as {
							content: Array<{ type: string; text?: string }>;
						}
					).content
						.map((block) => block.text ?? "")
						.join(""),
				);
			return fauxAssistantMessage("Referenced diagnostics finished", {
				stopReason: "stop",
			});
		},
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	const held = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.filter((run) => run.state === "running").length === 4,
	);
	const id = (name: string) =>
		held.runs.find((run) => run.plan.app === name)?.id ?? "";
	const api = id("api"),
		resources = [id("base"), id("cache")].sort();
	// The approved operation discloses the exact generation closure it binds.
	const boundary = await pendingReview(app, owner, "Endpoint GET: api/web");
	expect(boundary.snapshot).toContain('"root"');
	for (const generation of [api, ...resources])
		expect(boundary.snapshot).toContain(generation);
	await approve(app, owner, "Endpoint GET: api/web");
	await eventually(
		async () => receipts.length,
		(count) => count === 3,
	);
	// The endpoint answered only for this root generation, never a sibling.
	expect(
		fs.readFileSync(path.join(config.configDir, "requests"), "utf8").trim(),
	).toBe("api");
	const answer = JSON.parse(receipts[0] ?? "{}") as {
		body: string;
		run: string;
		root: { run: string; resources: string[] };
	};
	expect(answer.body).toBe("referenced-ok");
	expect(answer.run).toBe(api);
	expect(answer.root).toEqual({ run: api, resources });
	const telemetry = JSON.parse(receipts[1] ?? "{}") as {
		source: string;
		root: { run: string; resources: string[] };
	};
	expect(telemetry.source).toBe("native-run-otlp-http-json");
	expect(telemetry.root).toEqual({ run: api, resources });
	// A stopped root admits no diagnostic and no substitute generation.
	expect(receipts[2]).toContain(
		"Endpoint requires this task's live ready shell app",
	);
}, 20000);

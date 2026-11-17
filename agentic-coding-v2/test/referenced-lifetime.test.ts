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
function referenced(config: Config, port?: number, release?: string) {
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
					`const fs=require('node:fs');fs.appendFileSync(process.env.STARTS,${JSON.stringify(`${id}\n`)});process.on('SIGTERM',()=>{fs.appendFileSync(process.env.STOPS,${JSON.stringify(`${id}\n`)});process.exit(0)})${port ? `;Bun.serve({hostname:'127.0.0.1',port:${port},async fetch(){fs.appendFileSync(process.env.REQUESTS,${JSON.stringify(`${id}\n`)});${release ? `await new Promise(done=>{const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);done()}},5)});` : ""}return new Response('referenced-ok')}})` : ""};console.log('READY');setInterval(()=>{},1000)`,
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
				project("edge", "app", ["cache"]),
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
	// A retained prerequisite is disclosed as a generation without its own clock.
	expect(cache?.idle.scope).toBe("referenced-prerequisite-generation");
	expect(cache?.idle.activityScope).toBe("no-own-activity-clock");
	expect(cache?.idle.lastActivityAt).toBeNull();
	expect(byApp("api")?.idle.scope).toBe("referenced-native-root");
	expect(byApp("api")?.idle.activityScope).toBe("selected-native-root");
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
test("a shared lifetime refuses a duplicate live root and an unrelated held lifetime", async () => {
	let duplicate: string[] = [],
		mixed: string[] = [];
	const first = await fixture(false, referenced);
	first.fake.setResponses([
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		call("env_start", {
			apps: ["api", "worker"],
			lifetime: "shared-prerequisites-v1",
		}),
		async (context) => {
			duplicate = context.messages
				.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_start",
				)
				.map((message) =>
					(message as unknown as { content: { text?: string }[] }).content
						.map((block) => block.text ?? "")
						.join(""),
				);
			return fauxAssistantMessage("Duplicate refused", { stopReason: "stop" });
		},
	]);
	const owner = await first.app.startTask(first.invocation);
	await approve(first.app, owner);
	await approve(first.app, owner, "Environment run: api, worker");
	await eventually(
		() => first.app.environments.snapshot(),
		(state) => state.runs.filter((run) => run.state === "running").length === 3,
	);
	await eventually(
		async () => duplicate.length,
		(count) => count === 2,
	);
	// The held root is not started again, and no second copy of it appears.
	expect(duplicate[1]).toContain(
		"A live root generation of api is already held",
	);

	const second = await fixture(false, referenced);
	second.fake.setResponses([
		call("env_start", { apps: ["worker"] }),
		call("env_start", { apps: ["api"], lifetime: "shared-prerequisites-v1" }),
		async (context) => {
			mixed = context.messages
				.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "env_start",
				)
				.map((message) =>
					(
						message as unknown as {
							content: Array<{ text?: string }>;
						}
					).content
						.map((block) => block.text ?? "")
						.join(""),
				);
			return fauxAssistantMessage("Mixed refused", { stopReason: "stop" });
		},
	]);
	const other = await second.app.startTask(second.invocation);
	await approve(second.app, other);
	await approve(second.app, other, "Environment run: api");
	await eventually(
		async () => mixed.length,
		(count) => count === 2,
	);
	expect(mixed[1]).toContain("lifetimes are not combined across acquisitions");
}, 30000);

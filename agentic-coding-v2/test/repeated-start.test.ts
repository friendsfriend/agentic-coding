import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
async function application() {
	return fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		const target = (id: string) => ({
			id,
			action: "run",
			runtime: "shell",
			readyText: "READY",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:fs').appendFileSync(process.env.WORKSPACE+'/${id}-starts','start\\n');console.log('READY');setInterval(()=>{},1000)`)}`,
		});
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						targets: [target("serve"), target("other")],
						defaults: { run: "serve" },
					},
				],
			}),
		);
	});
}
test("repeated identical approved starts return a durable same-holder receipt without another command or lease", async () => {
	const { app, fake, invocation } = await application();
	const outputs: Array<
		Array<{
			id: string;
			batch: string;
			requestBatch?: string;
			acquisition?: string;
		}>
	> = [];
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("env_start", { apps: ["api"] }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_start")
					continue;
				for (const part of message.content)
					if (part.type === "text") outputs.push(JSON.parse(part.text));
			}
			return call("env_stop", { apps: ["api"] });
		},
		call("request_review", { path: ".", title: "Hold repeated start" }),
	]);
	const task = await app.startTask(invocation);
	const first = await pendingReview(app, task);
	expect(first.snapshot).toContain("already-held receipt");
	await approve(app, task);
	const second = await pendingReview(app, task);
	expect(second.id).not.toBe(first.id);
	await approve(app, task);
	await pendingReview(app, task, "Hold repeated start");
	const state = await app.environments.snapshot();
	expect(state.runs).toHaveLength(1);
	const run = state.runs[0];
	if (!run) throw new Error("Missing public run receipt");
	expect(run.state).toBe("exited");
	expect(
		fs.readFileSync(path.join(run.plan.workspace, "serve-starts"), "utf8"),
	).toBe("start\n");
	expect(outputs).toHaveLength(2);
	expect(outputs[1]?.[0]).toMatchObject({
		id: outputs[0]?.[0]?.id,
		batch: outputs[0]?.[0]?.batch,
		acquisition: "already-held",
	});
	expect(outputs[1]?.[0]?.requestBatch).not.toBe(outputs[1]?.[0]?.batch);
	await app.cancel(task);
}, 15000);
test("an approved changed plan cannot reuse or replace the task's held app", async () => {
	const { app, fake, invocation } = await application();
	let refusal = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("env_start", { apps: ["api"], target: "other" }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_start")
					continue;
				for (const part of message.content)
					if (part.type === "text") refusal += part.text;
			}
			return call("request_review", { path: ".", title: "Hold changed start" });
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await approve(app, task);
	await pendingReview(app, task, "Hold changed start");
	const state = await app.environments.snapshot();
	expect(state.runs).toHaveLength(1);
	const run = state.runs[0];
	if (!run) throw new Error("Missing public run receipt");
	expect(run.state).toBe("running");
	expect(refusal).toContain("Release your existing app batch");
	expect(fs.existsSync(path.join(run.plan.workspace, "other-starts"))).toBe(
		false,
	);
	await app.cancel(task);
}, 15000);

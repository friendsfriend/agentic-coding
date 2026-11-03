import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
async function dependencies(
	appBehavior = "console.log('APP_READY');setInterval(()=>{},1000)",
) {
	return fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		const node = (source: string) =>
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
		const preamble =
			"const fs=require('node:fs'),path=require('node:path'),root=process.env.WORKSPACE;const marker=path.join(root,'infra-running');";
		const infrastructure =
			preamble +
			"fs.writeFileSync(marker,'ready');process.on('exit',()=>fs.rmSync(marker,{force:true}));process.on('SIGTERM',()=>process.exit(0));console.log('STORE_READY');setInterval(()=>{if(fs.existsSync(path.join(root,'terminate-store')))process.exit(0)},10)";
		const application =
			preamble +
			"if(!fs.existsSync(marker))throw new Error('dependency was not ready');process.on('SIGTERM',()=>{fs.writeFileSync(path.join(root,'app-cleanup'),fs.existsSync(marker)?'dependency-live':'missing');process.exit(0)});" +
			appBehavior;
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						repository: config.repositories[0],
						requires: ["store"],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								command: node(application),
								readyText: "APP_READY",
							},
						],
					},
					{
						id: "store",
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								command: node(infrastructure),
								readyText: "STORE_READY",
							},
						],
					},
				],
			}),
		);
	});
}
test("declared infrastructure is approved and ready before its app; selecting one member stops the coupled batch dependent-first", async () => {
	const { app, fake, invocation } = await dependencies();
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold dependencies" }),
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect(review.snapshot).toContain("stopping ANY member");
	expect(review.snapshot).toContain('"app": "store"');
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await approve(app, task);
	await pendingReview(app, task, "Hold dependencies");
	const running = await app.environments.snapshot();
	expect(running.runs).toHaveLength(2);
	expect(running.runs.every((run) => run.state === "running")).toBe(true);
	const workspace = running.runs[0]?.plan.workspace;
	if (!workspace) throw new Error("Missing public workspace receipt");
	fake.setResponses([
		call("env_stop", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold stopped dependencies" }),
	]);
	await approve(app, task, "Hold dependencies");
	await pendingReview(app, task, "Hold stopped dependencies");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	expect(fs.readFileSync(path.join(workspace, "app-cleanup"), "utf8")).toBe(
		"dependency-live",
	);
	expect(fs.existsSync(path.join(workspace, "infra-running"))).toBe(false);
	await app.cancel(task);
}, 15000);
test("dependency loss cleans up its running app without owner cancellation or receipt-based restart", async () => {
	const { app, fake, invocation } = await dependencies();
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold dependency loss" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold dependency loss");
	const running = await app.environments.snapshot();
	const workspace = running.runs[0]?.plan.workspace;
	if (!workspace) throw new Error("Missing public workspace receipt");
	fs.writeFileSync(path.join(workspace, "terminate-store"), "exit");
	const stopped = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(stopped.runs).toHaveLength(2);
	expect(fs.readFileSync(path.join(workspace, "app-cleanup"), "utf8")).toBe(
		"missing",
	);
	expect(fs.existsSync(path.join(workspace, "infra-running"))).toBe(false);
	await pendingReview(app, task, "Hold dependency loss");
	await app.cancel(task);
}, 15000);
test("cyclic infrastructure declarations are rejected at host admission before native execution", async () => {
	await expect(
		fixture(false, (config) => {
			fs.mkdirSync(config.configDir);
			fs.writeFileSync(
				path.join(config.configDir, "environments.json"),
				JSON.stringify({
					version: 1,
					projects: [
						{ id: "first", requires: ["second"] },
						{ id: "second", requires: ["first"] },
					].map((project) => ({
						...project,
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								command: "exit 1",
							},
						],
					})),
				}),
			);
		}),
	).rejects.toThrow("Cyclic infrastructure dependencies");
});
test("oversized dependency expansion fails before approval, reservation or commands", async () => {
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		const requires = Array.from({ length: 16 }, (_, index) => `infra-${index}`);
		const target = {
			id: "serve",
			action: "run",
			runtime: "shell",
			command: "exit 1",
		};
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{
						id: "api",
						kind: "app",
						requires,
						repository: config.repositories[0],
						targets: [target],
					},
					...requires.map((id) => ({
						id,
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [target],
					})),
				],
			}),
		);
	});
	let failure = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_start")
					continue;
				for (const part of message.content)
					if (part.type === "text") failure += part.text;
			}
			return call("request_review", {
				path: ".",
				title: "Oversized dependency refusal",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Oversized dependency refusal");
	expect(failure).toContain("Expanded environment batch exceeds 16 projects");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await app.cancel(task);
}, 15000);
test("failed dependent startup settles the atomic acquisition and cleans up its already-started infrastructure", async () => {
	const { app, fake, invocation } = await dependencies("process.exit(2)");
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold failed dependencies" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold failed dependencies");
	const stopped = await app.environments.snapshot();
	expect(stopped.runs).toHaveLength(2);
	expect(stopped.runs.every((run) => run.state === "exited")).toBe(true);
	const workspace = stopped.runs[0]?.plan.workspace;
	if (!workspace) throw new Error("Missing public workspace receipt");
	expect(fs.existsSync(path.join(workspace, "infra-running"))).toBe(false);
	await app.cancel(task);
}, 15000);

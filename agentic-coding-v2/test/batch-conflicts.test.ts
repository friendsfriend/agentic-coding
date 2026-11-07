import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const shell = (marker: string) =>
	`${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log(${JSON.stringify(marker)});setInterval(()=>{},1000)`)}`;

function definition(projects: unknown[]) {
	return JSON.stringify({ version: 1, projects });
}

test("two apps binding the same loopback endpoint port fail before approval, reservation or commands", async () => {
	const port = 38917;
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			`${config.configDir}/environments.json`,
			definition(
				["first", "second"].map((id) => ({
					id,
					kind: "app",
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: shell("READY"),
							readyText: "READY",
							endpoints: { api: `http://127.0.0.1:${port}` },
						},
					],
				})),
			),
		);
	});
	let failure = "";
	fake.setResponses([
		call("env_start", { apps: ["first", "second"] }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_start")
					continue;
				for (const part of message.content)
					if (part.type === "text") failure += part.text;
			}
			return call("request_review", {
				path: ".",
				title: "Endpoint conflict refusal",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Endpoint conflict refusal");
	expect(failure).toContain("binds the same host port twice");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await app.cancel(task);
}, 15000);

test("two infrastructure targets listening on one query port fail before approval, reservation or commands", async () => {
	const port = 38941;
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			`${config.configDir}/environments.json`,
			definition(
				["store-a", "store-b"].map((id) => ({
					id,
					kind: "infrastructure",
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: shell("STORE_READY"),
							readyText: "STORE_READY",
							secretRefs: {
								PGUSER: "DISPOSABLE_SQL_USER",
								PGPASSWORD: "DISPOSABLE_SQL_PASSWORD",
							},
							queryConnection: {
								protocol: "postgres",
								host: "127.0.0.1",
								port,
								database: "template1",
								usernameRef: "PGUSER",
								passwordRef: "PGPASSWORD",
							},
						},
					],
				})),
			),
		);
	});
	let failure = "";
	fake.setResponses([
		call("env_start", { apps: ["store-a", "store-b"] }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_start")
					continue;
				for (const part of message.content)
					if (part.type === "text") failure += part.text;
			}
			return call("request_review", {
				path: ".",
				title: "Query conflict refusal",
			});
		},
	]);
	const task = await app.startTask(invocation);
	await pendingReview(app, task, "Query conflict refusal");
	expect(failure).toContain("binds the same host port twice");
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await app.cancel(task);
}, 15000);

test("one app aliasing one URL under two endpoint names is admitted and starts", async () => {
	const port = 38929;
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			`${config.configDir}/environments.json`,
			definition([
				{
					id: "only",
					kind: "app",
					repository: config.repositories[0],
					targets: [
						{
							id: "serve",
							action: "run",
							runtime: "shell",
							command: shell("ALIAS_READY"),
							readyText: "ALIAS_READY",
							endpoints: {
								primary: `http://127.0.0.1:${port}`,
								alias: `http://127.0.0.1:${port}`,
							},
						},
					],
				},
			]),
		);
	});
	fake.setResponses([
		call("env_start", { apps: ["only"] }),
		call("request_review", { path: ".", title: "Hold aliased endpoint" }),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Hold aliased endpoint");
	const running = await app.environments.snapshot();
	expect(running.runs).toHaveLength(1);
	expect(running.runs.every((run) => run.state === "running")).toBe(true);
	await app.cancel(task);
}, 15000);

import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("explicit owned infrastructure shares atomic approval and cleanup with apps, with kind-scoped redacted native log reads", async () => {
	const token = "disposable-infrastructure-token";
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			`DB_TOKEN=${token}\n`,
			{ mode: 0o600 },
		);
		const target = (kind: string) => ({
			id: "serve",
			action: "run",
			runtime: "shell",
			readyText: "READY",
			secretRefs: { TOKEN: "DB_TOKEN" },
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log('READY');console.log('${kind}-owned '+process.env.TOKEN);setInterval(()=>{},1000)`)}`,
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
						targets: [target("app")],
					},
					{
						id: "store",
						kind: "infrastructure",
						repository: config.repositories[0],
						targets: [target("db")],
					},
				],
			}),
		);
	});
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	const outputs: Array<{
		projectKind: string;
		runs: Array<{ projectKind: string; output: string }>;
	}> = [];
	fake.setResponses([
		call("env_start", { apps: ["store", "api"] }),
		call("env_logs", { infra: "store", grep: "db-owned" }),
		call("env_logs", { infra: "api" }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_logs")
					continue;
				for (const part of message.content)
					if (part.type === "text") outputs.push(JSON.parse(part.text));
			}
			return call("request_review", {
				path: ".",
				title: "Hold owned infrastructure",
			});
		},
	]);
	const task = await app.startTask(invocation);
	const review = await pendingReview(app, task);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	expect(review.snapshot).toContain("Exclusive task-owned run resources only");
	expect(review.snapshot).not.toContain(token);
	await approve(app, task);
	await pendingReview(app, task, "Hold owned infrastructure");
	const state = await app.environments.snapshot();
	expect(state.runs).toHaveLength(2);
	expect(state.projects.find((project) => project.id === "store")?.kind).toBe(
		"infrastructure",
	);
	expect(state.runs.every((run) => run.state === "running")).toBe(true);
	expect(outputs[0]).toMatchObject({
		projectKind: "infrastructure",
		runs: [{ projectKind: "infrastructure", output: "db-owned [REDACTED]\n" }],
	});
	expect(outputs[1]?.runs).toHaveLength(0);
	expect(JSON.stringify(outputs)).not.toContain(token);
	await app.cancel(task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
}, 15000);

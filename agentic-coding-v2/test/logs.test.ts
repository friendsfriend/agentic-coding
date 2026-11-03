import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
test("native log reads filter redacted lines literally, tail matching lines, preserve owner fences and omit whole over-budget lines", async () => {
	const secret = "disposable-log-secret",
		command = (source: string) =>
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
	const { app, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir, { recursive: true });
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			`LOG_TOKEN=${secret}\n`,
			{ mode: 0o600 },
		);
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
								id: "build",
								action: "build",
								runtime: "shell",
								command: command("console.log('foreign [x]')"),
							},
							{
								id: "serve",
								action: "run",
								runtime: "shell",
								readyText: "LOG READY",
								secretRefs: { TOKEN: "LOG_TOKEN" },
								command: command(
									"console.log(['earliest [x]','first [x] '+process.env.TOKEN,'must-not-match x','last [x]','large '+ '中'.repeat(6000),'LOG READY'].join('\\n'));setInterval(()=>{},1000)",
								),
							},
						],
					},
				],
			}),
		);
	});
	const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
		fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
	fake.setResponses([
		call("env_build", { app: "api" }),
		fauxAssistantMessage("Done"),
	]);
	const foreign = await app.startTask(invocation);
	await approve(app, foreign);
	await app.harness.waitForTask(foreign as TaskId, context);
	const observations: Array<{
		outputBudgetBytes: number;
		runs: Array<{
			output: string;
			selection: {
				matchedRetainedLines: number;
				returnedLines: number;
				omittedForBudget: number;
			};
		}>;
	}> = [];
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		() => call("env_logs", { app: "api", grep: "[x]", tail: 2 }),
		() => call("env_logs", { app: "api", grep: "large", tail: 1 }),
		() => call("env_logs", { app: "api", service: "worker" }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_logs")
					continue;
				for (const part of message.content)
					if (part.type === "text") observations.push(JSON.parse(part.text));
			}
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask({
		...invocation,
		requestId: "filtered-log-owner",
	});
	await approve(app, task);
	await app.harness.waitForTask(task as TaskId, context);
	expect(observations).toHaveLength(3);
	expect(observations[0]?.runs).toHaveLength(1);
	expect(observations[0]?.runs[0]?.output).toBe(
		"first [x] [REDACTED]\nlast [x]\n",
	);
	expect(observations[0]?.runs[0]?.selection.matchedRetainedLines).toBe(3);
	expect(observations[1]?.outputBudgetBytes).toBe(12288);
	expect(observations[1]?.runs[0]?.output).toBe("");
	expect(observations[1]?.runs[0]?.selection).toMatchObject({
		matchedRetainedLines: 1,
		returnedLines: 0,
		omittedForBudget: 1,
	});
	expect(observations[2]?.runs[0]).toMatchObject({
		sourceAvailability: "unsupported-runtime",
		output: "",
	});
	expect(JSON.stringify(observations)).not.toContain(secret);
}, 15000);

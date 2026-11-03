import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serve } from "../src/server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
test("native since uses host receipt times rather than spoofable app dates and survives normal owned cleanup", async () => {
	const secret = "disposable-timed-log-secret";
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			`LOG_TOKEN=${secret}\n`,
		);
		const source =
			"const fs=require('node:fs');console.log(Array(2100).fill('warmup [x]').join('\\n'));console.log('9999-12-31T23:59:59Z early [x]');console.log('EARLY_READY');let sent=false;setInterval(()=>{if(!sent&&fs.existsSync(process.env.CONFIG_DIR+'/emit-late')){sent=true;console.log('1900-01-01T00:00:00Z late [x] '+process.env.TOKEN);console.log('LATE_READY')}},10)";
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
								id: "serve",
								action: "run",
								runtime: "shell",
								readyText: "EARLY_READY",
								secretRefs: { TOKEN: "LOG_TOKEN" },
								command:
									JSON.stringify(process.execPath) +
									" -e " +
									JSON.stringify(source),
							},
						],
					},
				],
			}),
		);
	});
	let since = "",
		failure = "";
	const observations: unknown[] = [];
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Read recent logs" }),
		() => call("env_logs", { app: "api", since, grep: "[x]", tail: 2 }),
		call("env_stop", { apps: ["api"] }),
		() => call("env_logs", { app: "api", since, grep: "[x]", tail: 2 }),
		call("env_logs", { app: "api", since: "9999-12-31T23:59:59Z" }),
		call("env_logs", { app: "api", since: "yesterday" }),
		(messages) => {
			for (const message of messages.messages) {
				if (message.role !== "toolResult" || message.toolName !== "env_logs")
					continue;
				for (const part of message.content)
					if (part.type === "text") {
						if (message.isError) failure = part.text;
						else observations.push(JSON.parse(part.text));
					}
			}
			return fauxAssistantMessage("Dated logs checked");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Read recent logs");
	since = new Date().toISOString();
	fs.writeFileSync(path.join(config.configDir, "emit-late"), "go");
	await eventually(
		async () =>
			(await app.environments.logs("api", task)).some((run) =>
				run.output?.includes("LATE_READY"),
			),
		Boolean,
	);
	await approve(app, task, "Read recent logs");
	await app.harness.waitForTask(task as TaskId, context);
	expect(observations).toHaveLength(3);
	for (const index of [0, 1])
		expect(observations[index]).toMatchObject({
			since: expect.any(String),
			runs: [
				{
					output: "1900-01-01T00:00:00Z late [x] [REDACTED]\n",
					timeSelection: {
						basis: "host-receipt-completed-lines",
						availability: "available",
						untimedRetainedLines: 56,
						timingWindowTruncated: true,
						excludedOlderLines: 2046,
					},
					selection: { matchedRetainedLines: 1, returnedLines: 1 },
				},
			],
		});
	expect(observations[2]).toMatchObject({
		runs: [
			{
				output: "",
				timeSelection: { availability: "available", excludedOlderLines: 2048 },
			},
		],
	});
	expect(failure).toContain("explicit ISO 8601 instant");
	expect(JSON.stringify(observations)).not.toContain(secret);
	const host = serve(app);
	try {
		const address = new URL(host.url);
		const token = new URLSearchParams(address.hash.slice(1)).get("token");
		if (!token) throw new Error("Disposable host omitted its private token");
		const headers = { Authorization: `Bearer ${token}` };
		const query = new URL("/api/environments/logs", address);
		query.search = new URLSearchParams({
			app: "api",
			since,
			grep: "[x]",
			tail: "2",
		}).toString();
		const response = await fetch(query, { headers });
		expect(response.status).toBe(200);
		const selected = await response.json();
		expect(selected).toMatchObject([
			{
				output: "1900-01-01T00:00:00Z late [x] [REDACTED]\n",
				timeSelection: {
					basis: "host-receipt-completed-lines",
					availability: "available",
				},
				selection: { returnedLines: 1 },
			},
		]);
		expect(JSON.stringify(selected)).not.toContain(secret);
		query.searchParams.delete("since");
		query.searchParams.set("sincee", since);
		const refused = await fetch(query, { headers });
		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			error: "Unknown or repeated environment log query parameter",
		});
	} finally {
		await host.stop();
	}
}, 15000);

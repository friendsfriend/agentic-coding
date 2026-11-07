import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("authenticated revision-fenced developer release revokes all task environments, survives reopen and never cancels the coding task", async () => {
	const { app, open, fake, invocation } = await fixture(true, (config) => {
		const target = {
			id: "serve",
			action: "run",
			runtime: "shell",
			readyText: "READY",
			command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log("READY");setInterval(()=>{},1000)')}`,
		};
		fs.mkdirSync(config.configDir);
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
						id: "worker",
						kind: "app",
						repository: config.repositories[0],
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
	fake.setResponses([
		call("env_start", { apps: ["api", "worker"] }),
		call("request_review", { title: "Coding task continues", path: "." }),
		call("env_start", { apps: ["api"] }),
		fauxAssistantMessage(
			"The coding task continued, but its environments remain revoked.",
		),
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	await pendingReview(app, owner, "Coding task continues");
	const runs = (await app.environments.snapshot()).runs.filter(
			(run) => run.owner === owner,
		),
		run = runs.find((run) => run.plan.app === "api");
	if (!run) throw new Error("Missing fixture run");
	expect(runs).toHaveLength(3);
	expect(runs.every((run) => run.state === "running" && run.canRevoke)).toBe(
		true,
	);
	const host = serve(app),
		url = new URL(host.url),
		token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
	const input = {
		runId: run.id,
		revision: run.revision,
		requestId: "developer-release",
		reason: "Free fixture environments while coding continues",
	};
	const post = (body: object, auth = true) =>
		fetch(`${url.origin}/api/environments/revoke`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(auth ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(body),
		});
	try {
		expect((await post(input, false)).status).toBe(401);
		expect((await post({ ...input, revision: run.revision + 1 })).status).toBe(
			400,
		);
		expect(
			(await app.environments.snapshot()).runs.filter(
				(run) => run.owner === owner && run.state === "running",
			),
		).toHaveLength(3);
		const [first, retry] = await Promise.all([post(input), post(input)]);
		expect(first.status).toBe(200);
		expect(retry.status).toBe(200);
		expect(await first.json()).toMatchObject({
			owner,
			state: "completed",
			inspectionRequired: false,
		});
		expect(await retry.json()).toMatchObject({
			owner,
			state: "completed",
			inspectionRequired: false,
		});
		expect((await post({ ...input, reason: "Changed request" })).status).toBe(
			400,
		);
		const state = await app.environments.snapshot();
		expect(
			state.runs.every((run) => run.state === "exited" && !run.canRevoke),
		).toBe(true);
		for (const run of runs)
			expect(() => process.kill(run.pid ?? 0, 0)).toThrow();
		expect((await app.taskResult(owner))?.abortRequested).toBe(false);
		expect((await app.taskResult(owner))?.state.status).not.toBe("terminal");
	} finally {
		host.stop();
	}
	await app.close();
	const reopened = await open();
	expect(await reopened.environments.operator.revoke(input)).toMatchObject({
		owner,
		state: "completed",
		inspectionRequired: false,
	});
	await approve(reopened, owner, "Coding task continues");
	await approve(reopened, owner);
	expect(
		(await reopened.harness.waitForTask(owner as TaskId, context)).state.outcome
			.status,
	).toBe("completed");
	const final = await reopened.environments.snapshot();
	expect(final.runs).toHaveLength(3);
	expect(final.runs.every((run) => run.state === "exited")).toBe(true);
	expect(final.revocations).toHaveLength(1);
});

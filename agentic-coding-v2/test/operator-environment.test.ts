import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { git } from "../src/git.ts";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);

function definitions(repository: string) {
	const source =
		"require('node:fs').appendFileSync(process.env.CONFIG_DIR+'/executions.txt','run\\n'); console.log('OPERATOR READY'); setInterval(()=>{},1000)";
	return {
		version: 1,
		projects: [
			{
				id: "api",
				kind: "app",
				repository,
				requires: ["cache"],
				targets: [
					{
						id: "serve",
						action: "run",
						runtime: "shell",
						readyText: "OPERATOR READY",
						command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
					},
					{
						id: "build",
						action: "build",
						runtime: "shell",
						profile: "fast",
						command: "printf 'original build\\n'",
					},
					{
						id: "test",
						action: "test",
						runtime: "shell",
						command: "printf 'test failed\\n'; exit 7",
					},
				],
			},
			{
				id: "cache",
				kind: "infrastructure",
				repository,
				targets: [
					{
						id: "serve",
						action: "run",
						runtime: "shell",
						readyText: "CACHE READY",
						command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('CACHE READY'); setInterval(()=>{},1000)")}`,
					},
				],
			},
		],
	};
}

test("authenticated direct controls need no model profile, review an isolated captured plan, deduplicate admission and stop their held native batch", async () => {
	const { app, config } = await fixture(false, (config) => {
		config.profiles = [];
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(definitions(config.repositories[0] ?? "")),
		);
	});
	fs.writeFileSync(
		path.join(config.repositories[0] ?? "", "README.md"),
		"Uncommitted checkout edits\n",
	);
	const host = serve(app),
		url = new URL(host.url),
		token = new URLSearchParams(url.hash.slice(1)).get("token") ?? "";
	const call = (route: string, data: unknown, authenticated = true) =>
		fetch(new URL(route, url), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(authenticated ? { authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify(data),
		});
	try {
		const request = {
			apps: ["api"],
			action: "run",
			target: "serve",
			workspaceMode: "worktree",
			requestId: "direct-run",
		};
		expect(
			(await call("/api/environments/actions", request, false)).status,
		).toBe(401);
		const response = await call("/api/environments/actions", request);
		expect(response.status).toBe(200);
		const { taskId } = (await response.json()) as { taskId: number };
		expect(
			await (await call("/api/environments/actions", request)).json(),
		).toEqual({ taskId });
		expect(
			(await call("/api/environments/actions", { ...request, target: "build" }))
				.status,
		).toBe(400);
		const review = await pendingReview(app, taskId);
		expect(fs.readFileSync(path.join(review.path, "README.md"), "utf8")).toBe(
			"Initial\n",
		);
		expect(review.snapshot).toContain("no model or agent is invoked");
		expect((await app.snapshot()).environments.runs).toHaveLength(0);
		expect(fs.existsSync(path.join(config.configDir, "executions.txt"))).toBe(
			false,
		);
		await approve(app, taskId);
		const state = await eventually(
			() => app.snapshot(),
			(state) =>
				state.environments.runs.some(
					(run) =>
						run.owner === taskId &&
						run.plan.app === "api" &&
						run.state === "running",
				),
		);
		expect(
			state.environments.runs.filter((run) => run.owner === taskId),
		).toHaveLength(2);
		expect(state.tasks.find((task) => task.id === taskId)?.kind).toBe(
			"operator-environment",
		);
		expect(
			fs.readFileSync(path.join(config.configDir, "executions.txt"), "utf8"),
		).toBe("run\n");
		await app.tick();
		expect((await app.snapshot()).messages).toHaveLength(0);
		expect((await call(`/api/tasks/${taskId}/cancel`, {})).status).toBe(200);
		await app.harness.waitForTask(taskId as TaskId, context);
		const ended = await eventually(
			() => app.snapshot(),
			(state) => state.environments.runs.every((run) => run.state === "exited"),
		);
		expect(ended.environments.runs[0]?.state).toBe("exited");
		expect(
			(await app.environments.selectedLogs("api", undefined, {})).runs[0]
				?.output,
		).toContain("OPERATOR READY");
		expect(
			(
				await call(`/api/reviews/${review.id}`, {
					revision: review.revision,
					decision: "approved",
				})
			).status,
		).toBe(400);
	} finally {
		host.stop();
	}
});

test("operator review survives restart without substituting a changed target; cancellation before approval executes nothing", async () => {
	const { app, config, open } = await fixture(true, (config) => {
		config.profiles = [];
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(definitions(config.repositories[0] ?? "")),
		);
	});
	const cancelled = await app.startEnvironmentAction({
		apps: ["api"],
		action: "run",
		target: "serve",
		requestId: "cancel-before-review",
	});
	const abandoned = await pendingReview(app, cancelled);
	await app.cancel(cancelled);
	await app.harness.waitForTask(cancelled as TaskId, context);
	expect(
		(await app.snapshot()).reviews.find((review) => review.id === abandoned.id)
			?.state,
	).toBe("cancelled");
	expect(fs.existsSync(path.join(config.configDir, "executions.txt"))).toBe(
		false,
	);
	const id = await app.startEnvironmentAction({
		apps: ["api"],
		action: "build",
		target: "build",
		profile: "fast",
		requestId: "build-across-reopen",
	});
	const review = await pendingReview(app, id);
	await app.close();
	const changed = definitions(config.repositories[0] ?? "");
	const target = changed.projects[0]?.targets.find(
		(target) => target.id === "build",
	);
	if (!target) throw new Error("Missing disposable build target");
	target.command = "printf 'substituted build\\n'";
	fs.writeFileSync(
		path.join(config.configDir, "environments.json"),
		JSON.stringify(changed),
	);
	const reopened = await open();
	expect((await pendingReview(reopened, id)).snapshot).toBe(review.snapshot);
	await approve(reopened, id);
	const result = await reopened.harness.waitForTask(id as TaskId, context);
	expect(result.state.outcome.status).toBe("completed");
	const state = await reopened.snapshot();
	expect(
		(await reopened.environments.selectedLogs("api", undefined, {})).runs.find(
			(run) => run.owner === id,
		)?.output,
	).toBe("original build\n");
	expect(state.environments.runs.find((run) => run.owner === id)?.state).toBe(
		"exited",
	);
	const failed = await reopened.startEnvironmentAction({
		apps: ["api"],
		action: "test",
		target: "test",
		requestId: "failing-test",
	});
	await approve(reopened, failed);
	expect(
		(await reopened.harness.waitForTask(failed as TaskId, context)).state
			.outcome.status,
	).toBe("failed");
	expect(
		(await reopened.snapshot()).environments.runs.find(
			(run) => run.owner === failed,
		)?.exitCode,
	).toBe(7);
	const stale = await reopened.startEnvironmentAction({
		apps: ["api"],
		action: "build",
		target: "build",
		requestId: "checkout-head-fence",
	});
	await pendingReview(reopened, stale);
	const repo = config.repositories[0] ?? "";
	fs.writeFileSync(path.join(repo, "README.md"), "New checkout head\n");
	await git(repo, ["add", "README.md"]);
	await git(repo, ["commit", "-m", "disposable checkout change"]);
	await approve(reopened, stale);
	expect(
		(await reopened.harness.waitForTask(stale as TaskId, context)).state.outcome
			.status,
	).toBe("failed");
	expect(
		(await reopened.snapshot()).environments.runs.some(
			(run) => run.owner === stale,
		),
	).toBe(false);
});

test("the orchestrator retains direct environment target/profile/runtime choices without starting a skill agent", async () => {
	const { app, fake } = await fixture(false, (config) => {
		fs.mkdirSync(config.configDir);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(definitions(config.repositories[0] ?? "")),
		);
	});
	fake.setResponses([
		fauxAssistantMessage(
			fauxToolCall("environment_action", {
				apps: ["api"],
				action: "build",
				target: "build",
				profile: "fast",
				runtime: "shell",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			"Prepared the exact environment action for human review.",
		),
	]);
	await app.chat(
		"Prepare the configured fast shell build, without a skill agent",
		"direct-environment-chat",
	);
	const state = await eventually(
		() => app.snapshot(),
		(state) => state.reviews.some((review) => review.state === "pending"),
	);
	const task = state.tasks.find((task) => task.kind === "operator-environment");
	if (!task) throw new Error("Missing native environment action");
	expect(state.reviews[0]?.path).toBe(task.repository);
	expect(state.reviews[0]?.snapshot).toContain(
		"including its uncommitted files",
	);
	expect(state.tasks).toHaveLength(1);
	expect(state.environments.runs).toHaveLength(0);
	await approve(app, task.id);
	expect(
		(await app.harness.waitForTask(task.id as TaskId, context)).state.outcome
			.status,
	).toBe("completed");
	expect(
		(await app.environments.selectedLogs("api", undefined, {})).runs[0]?.output,
	).toBe("original build\n");
});

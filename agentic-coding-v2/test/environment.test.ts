import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import {
	type EnvironmentRun,
	EnvironmentState,
} from "../src/environment/state.ts";
import { serve } from "../src/server/index.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
const secret = "only-for-environment-fixture";
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
function configure(config: Config) {
	fs.mkdirSync(config.configDir);
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		`FIXTURE_SECRET=${secret}\nINVALID_SECRET=fixture-secret-before\0fixture-secret-after\n`,
		{ mode: 0o600 },
	);
	const command = (source: string) =>
		`${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
	const run = {
		id: "serve",
		action: "run",
		runtime: "shell",
		timeoutMs: 2000,
		readyText: "ENV_READY",
		secretRefs: { SERVICE_TOKEN: "FIXTURE_SECRET" },
		command: command(
			"console.log('ENV_READY');process.stdout.write(process.env.SERVICE_TOKEN.slice(0,10));setTimeout(()=>console.log(process.env.SERVICE_TOKEN.slice(10)),5);setInterval(()=>{},1000)",
		),
	};
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
						run,
						{ ...run, id: "timeout", readyText: "NEVER_READY", timeoutMs: 100 },
						{
							id: "build",
							action: "build",
							runtime: "shell",
							secretRefs: run.secretRefs,
							command: command(
								"await Bun.write('built.txt',process.cwd());console.log(process.env.SERVICE_TOKEN);console.log(process.env.AC_ENV_AMBIENT_FIXTURE ?? 'no-ambient-secret')",
							),
						},
						{
							id: "test",
							action: "test",
							runtime: "shell",
							secretRefs: run.secretRefs,
							command: command(
								"console.error(process.env.SERVICE_TOKEN);process.exit(9)",
							),
						},
					],
				},
				{
					id: "worker",
					kind: "app",
					repository: config.repositories[0],
					targets: [run],
				},
				{
					id: "independent",
					kind: "app",
					repository: config.repositories[0],
					targets: [run],
				},
				{
					id: "invalid-secret",
					kind: "library",
					repository: config.repositories[0],
					targets: [
						{
							id: "build",
							action: "build",
							runtime: "shell",
							secretRefs: { TOKEN: "INVALID_SECRET" },
							command: command(
								"await Bun.write('invalid.txt','must never execute')",
							),
						},
					],
				},
			],
		}),
	);
}
test("environment batches wait for human approval, acquire atomically, fence foreign stops and clean up before handoff", async () => {
	const { app, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_start", { apps: ["api"], target: "serve" }),
		call("request_review", { path: ".", title: "Hold first app" }),
	]);
	const first = await app.startTask(invocation);
	await pendingReview(app, first);
	expect((await app.environments.snapshot()).runs).toHaveLength(0);
	await approve(app, first);
	await pendingReview(app, first, "Hold first app");
	const firstRun = (await app.environments.snapshot()).runs[0];
	if (!firstRun?.pid) throw new Error("No live fixture process");
	await eventually(
		() => app.environments.logs("api", first),
		(logs) => JSON.stringify(logs).includes("[REDACTED]"),
	);
	expect(
		JSON.stringify(await app.environments.logs("api", first)),
	).not.toContain(secret);
	fake.setResponses([
		call("env_stop", { apps: ["api"] }),
		call("env_start", { apps: ["api", "worker"], target: "serve" }),
	]);
	const cancelled = await app.startTask({
		...invocation,
		requestId: "cancel-waiter",
	});
	await approve(app, cancelled);
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.waiters.some((waiter) => waiter.owner === cancelled),
	);
	expect(
		(await app.environments.snapshot()).runs.some(
			(run) => run.plan.app === "worker",
		),
	).toBe(false);
	// FIFO applies to conflicting batches, not unrelated apps behind a blocked waiter.
	fake.setResponses([
		call("env_start", { apps: ["independent"] }),
		call("request_review", { path: ".", title: "Hold independent app" }),
	]);
	const independent = await app.startTask({
		...invocation,
		requestId: "independent-waiter",
	});
	await approve(app, independent);
	await pendingReview(app, independent, "Hold independent app");
	expect(
		(await app.environments.snapshot()).waiters.some(
			(waiter) => waiter.owner === cancelled,
		),
	).toBe(true);
	await app.cancel(independent);
	await app.harness.waitForTask(independent as TaskId, context);
	await app.cancel(cancelled);
	await app.harness.waitForTask(cancelled as TaskId, context);
	expect((await app.environments.snapshot()).waiters).toHaveLength(0);
	expect(() => process.kill(firstRun.pid ?? 0, 0)).not.toThrow();
	fake.setResponses([
		call("env_start", { apps: ["api", "worker"], target: "serve" }),
		call("request_review", { path: ".", title: "Hold acquired batch" }),
	]);
	const successor = await app.startTask({
		...invocation,
		requestId: "acquire-batch",
	});
	await approve(app, successor);
	await eventually(
		() => app.environments.snapshot(),
		(state) => state.waiters.some((waiter) => waiter.owner === successor),
	);
	await app.cancel(first);
	await app.harness.waitForTask(first as TaskId, context);
	await pendingReview(app, successor, "Hold acquired batch");
	expect(() => process.kill(firstRun.pid ?? 0, 0)).toThrow();
	const held = (await app.environments.snapshot()).runs.filter(
		(run) => run.owner === successor && run.state === "running",
	);
	expect(held.map((run) => run.plan.app).sort()).toEqual(["api", "worker"]);
	fake.setResponses([fauxAssistantMessage("Environment work complete.")]);
	await approve(app, successor, "Hold acquired batch");
	await app.harness.waitForTask(successor as TaskId, context);
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "exited",
		),
	).toBe(true);
	for (const run of held) expect(() => process.kill(run.pid ?? 0, 0)).toThrow();
	expect(
		JSON.stringify(await app.harness.snapshot(EnvironmentState, context)),
	).not.toContain(secret);
});

test("configured build/test targets preserve workspace policy, rejection, exit codes, secret redaction and timeout cleanup", async () => {
	const { app, fake, invocation } = await fixture(false, configure);
	fake.setResponses([
		call("env_build", { app: "api" }),
		fauxAssistantMessage("Read-only policy blocks execution."),
	]);
	const readonly = await app.startTask({
		...invocation,
		policy: "read-only",
		requestId: "readonly",
	});
	await app.harness.waitForTask(readonly as TaskId, context);
	expect((await app.snapshot()).reviews).toHaveLength(0);
	const before = process.env.AC_ENV_AMBIENT_FIXTURE;
	process.env.AC_ENV_AMBIENT_FIXTURE = "must-not-be-inherited";
	try {
		fake.setResponses([
			call("env_build", { app: "api" }),
			call("env_test", { app: "api" }),
			call("env_build", { app: "api" }),
			call("env_start", { apps: ["api"], target: "timeout" }),
			call("env_build", { app: "invalid-secret" }),
			(transcript) => {
				const messages = JSON.stringify(transcript.messages);
				expect(messages).toContain("[REDACTED]");
				expect(messages).not.toContain(secret);
				expect(messages).toContain("no-ambient-secret");
				expect(messages).toContain("Invalid environment secret reference");
				expect(messages).not.toContain("fixture-secret-before");
				return fauxAssistantMessage(
					"Build succeeded; tests returned 9; readiness timed out and was cleaned up.",
				);
			},
		]);
		const id = await app.startTask(invocation);
		const rejection = await pendingReview(app, id);
		await app.decide(
			rejection.id,
			rejection.revision,
			"rejected",
			"Do not execute this build",
		);
		await pendingReview(app, id, "Environment test: api");
		expect((await app.environments.snapshot()).runs).toHaveLength(0);
		await approve(app, id, "Environment test: api");
		await approve(app, id, "Environment build: api");
		await approve(app, id, "Environment run: api");
		await approve(app, id, "Environment build: invalid-secret");
		await app.harness.waitForTask(id as TaskId, context);
		const state = await app.snapshot(),
			runs = state.environments.runs;
		const workspace = state.tasks.find((task) => task.id === id)?.workspace;
		if (!workspace) throw new Error("Workspace missing");
		expect(fs.existsSync(path.join(workspace, "invalid.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(workspace, "built.txt"), "utf8")).toBe(
			workspace,
		);
		expect(fs.existsSync(path.join(invocation.repository, "built.txt"))).toBe(
			false,
		);
		expect(runs.find((run) => run.plan.action === "test")?.exitCode).toBe(9);
		expect(runs.find((run) => run.plan.action === "build")?.exitCode).toBe(0);
		expect(runs.find((run) => run.plan.id === "timeout")?.error).toContain(
			"startup failed",
		);
		expect(runs.every((run) => run.state === "exited")).toBe(true);
		expect(
			JSON.stringify(await app.environments.logs("api", id)),
		).not.toContain(secret);
	} finally {
		if (before === undefined) delete process.env.AC_ENV_AMBIENT_FIXTURE;
		else process.env.AC_ENV_AMBIENT_FIXTURE = before;
	}
});

test("a killed host quarantines ambiguous processes; only authenticated revision-bound inspection releases them", async () => {
	const fixtureState = await fixture(true, configure);
	await fixtureState.app.close();
	apps.splice(apps.indexOf(fixtureState.app), 1);
	const inputFile = path.join(
			fixtureState.config.stateDir,
			"fixture-input.json",
		),
		readyFile = path.join(fixtureState.config.stateDir, "fixture-ready.json");
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: fixtureState.config,
			invocation: fixtureState.invocation,
			readyFile,
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: fixtureState.invocation.repository,
			env: { PATH: process.env.PATH, HOME: fixtureState.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	let run: EnvironmentRun | null = null;
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
			id: number;
			run: EnvironmentRun;
		};
		run = ready.run;
		host.kill("SIGKILL");
		await host.exited;
		const app = await fixtureState.open();
		const quarantined = (await app.environments.snapshot()).runs[0];
		if (!quarantined?.pid) throw new Error("No quarantine receipt");
		expect(quarantined.state).toBe("interrupted");
		expect(() => process.kill(quarantined.pid ?? 0, 0)).not.toThrow();
		expect(
			(await app.environments.receipt(run.batch, ready.id, run.request))?.[0]
				?.state,
		).toBe("interrupted");
		await expect(
			app.environments.stopOnce("fixture-stop", ready.id, ["api"]),
		).rejects.toThrow("saved PID");
		await app.cancel(ready.id);
		const cancelled = await app.harness.waitForTask(
			ready.id as TaskId,
			context,
		);
		expect(cancelled.state.outcome).toMatchObject({
			status: "aborted",
			reason: expect.stringContaining("Resources remain quarantined"),
		});
		expect(() => process.kill(quarantined.pid ?? 0, 0)).not.toThrow();
		const server = serve(app);
		try {
			const url = new URL(server.url),
				endpoint = `${url.origin}/api/environments/release`;
			const headers = {
				Authorization: `Bearer ${new URLSearchParams(url.hash.slice(1)).get("token")}`,
				"Content-Type": "application/json",
			};
			const body = JSON.stringify({
				id: quarantined.id,
				revision: quarantined.revision,
				inspectionConfirmed: true,
			});
			expect((await fetch(endpoint, { method: "POST", body })).status).toBe(
				401,
			);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers: { ...headers, Origin: "https://untrusted.invalid" },
						body,
					})
				).status,
			).toBe(403);
			expect(
				(
					await fetch(endpoint, {
						method: "POST",
						headers,
						body: JSON.stringify({
							id: quarantined.id,
							revision: quarantined.revision,
						}),
					})
				).status,
			).toBe(400);
			// The test operator cleans up only the process group its own crash fixture created.
			process.kill(-quarantined.pid, "SIGKILL");
			run = null;
			expect(
				(await fetch(endpoint, { method: "POST", headers, body })).status,
			).toBe(200);
			expect(
				(await fetch(endpoint, { method: "POST", headers, body })).status,
			).toBe(400);
			const released = (await app.environments.snapshot()).runs[0];
			expect(released).toMatchObject({
				state: "exited",
				exitCode: null,
				inspection: { revision: quarantined.revision },
			});
			expect(released?.inspection?.confirmedAt).toBeGreaterThan(0);
		} finally {
			await server.stop();
		}
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
		if (run?.pid) {
			try {
				process.kill(-run.pid, "SIGKILL");
			} catch {
				/* Fixture may already have exited. */
			}
		}
	}
}, 15000);

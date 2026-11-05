import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { approve, pendingReview } from "./fixtures/environment.ts";
import { disposablePort, installPostgres } from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("SQL total deadline closes its borrowed connection and publishes no success", async () => {
	const port = disposablePort(),
		{ app, fake, invocation } = await fixture(false, (config) =>
			installPostgres(config, port),
		);
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("db_query", {
			infra: "store",
			sql: "SELECT pg_sleep(20) /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			transcript = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Timed out safely");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Query store");
	const started = Date.now();
	await approve(app, task, "Query store");
	await app.harness.waitForTask(task as TaskId, context);
	expect(Date.now() - started).toBeLessThan(15000);
	expect(transcript).toContain('"isError":true');
	expect(transcript).toContain("10 second deadline");
	expect(transcript).not.toContain("rollback");
	const state = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(state.queryOperations[0]?.state).toBe("issued");
}, 20000);

test("cancelling an issued SQL task drains diagnostics before releasing its coupled infrastructure", async () => {
	const port = disposablePort(),
		{ app, config, fake, invocation } = await fixture(false, (config) =>
			installPostgres(config, port),
		);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("db_query", {
			infra: "store",
			sql: "SELECT pg_sleep(20) /* NATIVE_SQL_PROBE */",
		}),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Query store");
	await approve(app, task, "Query store");
	await eventually(
		async () => fs.existsSync(path.join(config.configDir, "sql-probes")),
		Boolean,
	);
	const started = Date.now();
	await app.cancel(task);
	expect(Date.now() - started).toBeLessThan(5000);
	const state = await app.environments.snapshot();
	expect(state.runs.every((run) => run.state === "exited")).toBe(true);
	expect(state.queryOperations[0]?.state).toBe("issued");
	expect(
		fs.readFileSync(path.join(config.configDir, "sql-probes"), "utf8").trim(),
	).toBe("query");
}, 15000);

test("SIGKILL preserves uncertain SQL issuance and reopen never replays it or adopts database authority", async () => {
	const port = disposablePort(),
		state = await fixture(true, (config) => installPostgres(config, port));
	await state.app.close();
	apps.splice(apps.indexOf(state.app), 1);
	const readyFile = path.join(state.config.stateDir, "sql-ready.json"),
		inputFile = path.join(state.config.stateDir, "sql-host.json"),
		probes = path.join(state.config.configDir, "sql-probes");
	fs.writeFileSync(
		inputFile,
		JSON.stringify({
			config: state.config,
			invocation: state.invocation,
			readyFile,
			sql: { startedFile: probes },
		}),
	);
	const host = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/environment-host.ts"),
			inputFile,
		],
		{
			cwd: state.invocation.repository,
			env: { PATH: process.env.PATH, HOME: state.config.stateDir },
			stdout: "ignore",
			stderr: "inherit",
		},
	);
	try {
		await eventually(async () => fs.existsSync(readyFile), Boolean);
		const ready = JSON.parse(fs.readFileSync(readyFile, "utf8")) as {
			id: number;
		};
		host.kill("SIGKILL");
		await host.exited;
		await eventually(
			async () =>
				["api", "store"].every((name) =>
					fs.existsSync(path.join(state.config.configDir, `${name}-reaped`)),
				),
			Boolean,
		);
		let transcript = "";
		state.fake.setResponses([
			(messages) => {
				transcript = JSON.stringify(
					messages.messages.filter(
						(message) =>
							message.role === "toolResult" && message.toolName === "db_query",
					),
				);
				return fauxAssistantMessage("SQL was not resent");
			},
		]);
		const restored = await state.open();
		await restored.harness.waitForTask(ready.id as TaskId, context);
		const snapshot = await restored.environments.snapshot();
		expect(snapshot.queryOperations).toHaveLength(1);
		expect(snapshot.queryOperations[0]).toMatchObject({
			state: "issued",
			owner: ready.id,
			infra: "store",
		});
		expect(snapshot.runs.every((run) => run.state === "interrupted")).toBe(
			true,
		);
		expect(snapshot.referenceGraphs).toHaveLength(1);
		expect(snapshot.referenceGraphs[0]).toMatchObject({
			control: "coupled-observation-only",
			observation: "interrupted-observed",
			resources: [
				{
					applicationRequirements: 1,
					unsettledRequirements: 1,
					interruptedRequirements: 1,
				},
			],
		});
		expect(transcript).toContain("native replay cannot resend");
		expect(fs.readFileSync(probes, "utf8").trim()).toBe("query");
		await expect(
			restored.environments.stopOnce("refuse-sql-adoption", ready.id, ["api"]),
		).rejects.toThrow();
		// These two disposable wrappers already reported their own reaping above.
		// Trusted operator inspection records observations, never a saved-ID stop.
		const infrastructure = snapshot.runs.find(
			(run) => run.plan.app === "store",
		);
		if (!infrastructure)
			throw new Error("Missing quarantined SQL infrastructure");
		await expect(
			restored.environments.acknowledge(
				infrastructure.id,
				infrastructure.revision,
			),
		).rejects.toThrow("Dependent generations");
		for (const run of [...snapshot.runs].reverse())
			await restored.environments.acknowledge(run.id, run.revision);
		const settled = (await restored.environments.snapshot()).referenceGraphs[0];
		expect(settled?.observation).toBe("settled-observed");
		expect(settled?.resources[0]?.unsettledRequirements).toBe(0);
		expect(fs.readFileSync(probes, "utf8").trim()).toBe("query");
	} finally {
		if (host.exitCode === null) {
			host.kill("SIGTERM");
			await host.exited;
		}
	}
}, 20000);

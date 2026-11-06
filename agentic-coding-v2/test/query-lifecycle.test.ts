import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serveContainerFixture } from "./fixtures/container-server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	disposablePassword,
	disposablePort,
	installPostgres,
} from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup, apps } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("container query handles keep frozen credentials and redaction after reference rotation", async () => {
	const port = disposablePort();
	let engine: ReturnType<typeof serveContainerFixture> | undefined;
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installPostgres(config, port);
		const file = path.join(config.configDir, "environments.json");
		const document = JSON.parse(fs.readFileSync(file, "utf8"));
		// The real disposable protocol server is fixture-owned, not an application
		// lease. The fake engine supplies container ownership/health observations.
		fs.writeFileSync(
			path.join(config.configDir, "database-command"),
			document.projects[1].targets[0].command,
		);
		const bin = path.join(config.configDir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(
			path.join(bin, "docker"),
			`#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`,
			{ mode: 0o700 },
		);
		const engineFile = path.join(config.configDir, "engine.json");
		fs.writeFileSync(
			engineFile,
			JSON.stringify({ next: 1, containers: {}, history: [] }),
		);
		engine = serveContainerFixture(engineFile);
		const target = document.projects[1].targets[0];
		delete target.command;
		delete target.readyText;
		target.runtime = "docker";
		target.container = {
			socket: engine?.socket,
			image: "fixture:latest",
			command: ["serve"],
			readiness: "healthy",
			ports: [{ host: port, container: 5432, address: "127.0.0.1" }],
		};
		target.environment = {
			PATH: `${path.join(config.configDir, "bin")}:${process.env.PATH ?? ""}`,
			FIXTURE_ENGINE_SOCKET: engine?.socket,
		};
		fs.writeFileSync(file, JSON.stringify(document));
	});
	const server = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			fs.readFileSync(path.join(config.configDir, "database-command"), "utf8"),
		],
		{
			env: {
				...process.env,
				CONFIG_DIR: config.configDir,
				PORT: String(port),
				PGPASSWORD: disposablePassword,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const reader = server.stdout.getReader();
		let output = "";
		while (!output.includes("STORE_READY")) {
			const part = await reader.read();
			if (part.done)
				throw new Error("Disposable database fixture exited before readiness");
			output += new TextDecoder().decode(part.value);
		}
		reader.releaseLock();
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("db_query", {
				infra: "store",
				sql: "SELECT value FROM fixture_secrets",
			}),
			(messages) => {
				transcript = JSON.stringify(
					messages.messages.filter(
						(message) =>
							message.role === "toolResult" && message.toolName === "db_query",
					),
				);
				return fauxAssistantMessage("Container query completed");
			},
		]);
		const task = await app.startTask(invocation);
		await approve(app, task);
		await pendingReview(app, task, "Query store");
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"DISPOSABLE_SQL_USER=changed\nDISPOSABLE_SQL_PASSWORD=rotated\n",
		);
		await approve(app, task, "Query store");
		await app.harness.waitForTask(task as TaskId, context);
		expect(transcript).not.toContain(disposablePassword);
		expect(transcript).toContain("[REDACTED]");
		expect((await app.environments.snapshot()).queryOperations[0]?.state).toBe(
			"completed",
		);
	} finally {
		server.kill();
		await server.exited;
		await app.close();
		apps.splice(apps.indexOf(app), 1);
		await engine?.stop(true);
	}
}, 20000);

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

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
	installDatabase,
	postgresServer,
} from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const engines: ReturnType<typeof serveContainerFixture>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		await Promise.all(engines.splice(0).map((server) => server.stop(true)));
	}
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

test("container SQL executes read-only with frozen credentials and redaction against a disposable database", async () => {
	const port = disposablePort();
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installDatabase(config);
		const bin = path.join(config.configDir, "bin");
		fs.mkdirSync(bin);
		const source = `#!${process.execPath}\n${fs.readFileSync(path.join(import.meta.dir, "fixtures/container-engine.ts"), "utf8")}`;
		for (const name of ["docker", "podman"])
			fs.writeFileSync(path.join(bin, name), source, { mode: 0o700 });
		const engineFile = path.join(config.configDir, "engine.json");
		fs.writeFileSync(
			engineFile,
			JSON.stringify({ next: 1, containers: {}, history: [] }),
		);
		const server = serveContainerFixture(engineFile);
		engines.push(server);
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
								command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('APP_READY');setInterval(()=>{},1000)")}`,
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
								runtime: "docker",
								timeoutMs: 15000,
								environment: {
									PATH: `${bin}:${process.env.PATH ?? ""}`,
									FIXTURE_ENGINE_SOCKET: server.socket,
								},
								secretRefs: {
									PGUSER: "DISPOSABLE_SQL_USER",
									PGPASSWORD: "DISPOSABLE_SQL_PASSWORD",
								},
								container: {
									socket: server.socket,
									image: "fixture:latest",
									readiness: "healthy",
									ports: [
										{
											host: port,
											container: 5432,
											address: "127.0.0.1",
										},
									],
								},
								queryConnection: {
									protocol: "postgres",
									host: "127.0.0.1",
									port,
									database: "template1",
									usernameRef: "PGUSER",
									passwordRef: "PGPASSWORD",
									caRef: "database.pem",
								},
							},
						],
					},
				],
			}),
		);
	});
	const debugLog = path.join(config.configDir, "database-debug.log");
	const debugFile = fs.openSync(debugLog, "w");
	const database = Bun.spawn([process.execPath, "-e", postgresServer()], {
		env: {
			...process.env,
			CONFIG_DIR: config.configDir,
			PORT: String(port),
			PGPASSWORD: disposablePassword,
		},
		stdout: debugFile,
		stderr: debugFile,
	});
	try {
		await eventually(
			async () => {
				if (database.exitCode !== null) return "exited";
				try {
					return fs.readFileSync(debugLog, "utf8").includes("STORE_READY");
				} catch {
					return false;
				}
			},
			(value) => value === true,
		);
		if (database.exitCode !== null)
			throw new Error("Disposable database exited before listening");
		const payloads: string[] = [];
		let transcript = "";
		fake.setResponses([
			call("env_start", { apps: ["api"] }),
			call("db_query", {
				infra: "store",
				sql: "SELECT current_setting('transaction_read_only') AS mode, (SELECT value FROM fixture_secrets) AS secret, count(*) OVER () AS count FROM items LIMIT 2 /* NATIVE_SQL_PROBE */",
				limit: 5,
			}),
			call("db_query", {
				infra: "store",
				sql: "SELECT fixture_write() /* NATIVE_SQL_PROBE */",
			}),
			(messages) => {
				const results = messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				);
				transcript = JSON.stringify(results);
				for (const message of results)
					if (message.role === "toolResult")
						for (const part of message.content)
							if (part.type === "text") payloads.push(part.text);
				return fauxAssistantMessage("Done");
			},
		]);
		const task = await app.startTask(invocation),
			probes = path.join(config.configDir, "sql-probes");
		await approve(app, task);
		const review = await pendingReview(app, task, "Query store");
		expect(review.snapshot).toContain("read-only transaction");
		expect(review.snapshot).not.toContain(disposablePassword);
		expect(fs.existsSync(probes)).toBe(false);
		fs.writeFileSync(
			path.join(config.configDir, ".env"),
			"DISPOSABLE_SQL_USER=rotated-user\nDISPOSABLE_SQL_PASSWORD=rotated-password\n",
		);
		await approve(app, task, "Query store");
		await approve(app, task, "Query store");
		await app.harness.waitForTask(task as TaskId, context);
		expect(payloads).toHaveLength(2);
		const first = JSON.parse(payloads[0] ?? "{}");
		expect(first).toMatchObject({
			readOnly: true,
			rollback: "confirmed",
			returnedRows: 2,
		});
		expect(first.rows[0]).toEqual({
			mode: "on",
			secret: "[REDACTED]",
			count: "5",
		});

		expect(transcript.match(/"isError":true/g)).toHaveLength(1);
		expect(transcript).not.toContain(disposablePassword);
		expect(transcript).not.toContain(disposablePassword.slice(0, 8));
		expect(fs.readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(2);
		await app.cancel(task);
	} finally {
		database.kill("SIGKILL");
		await database.exited;
	}
}, 60000);

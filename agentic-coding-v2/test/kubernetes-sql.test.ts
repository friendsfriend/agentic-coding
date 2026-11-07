// Owned-pod SQL admission: a pod query connection exists only through the one
// declared loopback port forward the run starts, and every call re-observes the
// owned pod plus that forward. The fixture cluster and PGlite server prove the
// fences and the happy protocol path, not real cluster networking or production
// PostgreSQL authentication.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Config } from "../src/config.ts";
import { validateProjects } from "../src/environment/catalog.ts";
import { configureLocalCluster, podClient } from "./fixtures/cluster.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	disposablePassword,
	disposablePort,
	installDatabase,
	postgresServer,
} from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
const servers: ReturnType<typeof Bun.serve>[] = [];
const databases: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	try {
		await cleanup();
	} finally {
		for (const database of databases.splice(0)) database.kill();
		for (const server of servers.splice(0)) server.stop(true);
	}
});
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

/** Starts the disposable TLS PostgreSQL server the pod's forward reaches. */
async function startDatabase(config: Config, port: number) {
	const database = Bun.spawn([process.execPath, "-e", postgresServer()], {
		env: {
			...process.env,
			CONFIG_DIR: config.configDir,
			PORT: String(port),
			PGUSER: "postgres",
			PGPASSWORD: disposablePassword,
		},
		stdout: "pipe",
		stderr: "inherit",
	});
	databases.push(database);
	const reader = database.stdout.getReader(),
		decoder = new TextDecoder(),
		deadline = Date.now() + 15000;
	let text = "";
	for (;;) {
		const read = await reader.read();
		if (read.done)
			throw new Error("Disposable database ended before readiness");
		text += decoder.decode(read.value);
		if (text.includes("STORE_READY")) break;
		if (Date.now() > deadline)
			throw new Error("Disposable database did not become ready");
	}
	reader.releaseLock();
	return database;
}
/** The infrastructure pod target whose one forward carries the query port. */
function storeTarget(
	sqlPort: number,
	forwards: { local: number; remote: number }[],
) {
	return {
		id: "store",
		action: "run",
		runtime: "kubernetes",
		timeoutMs: 15000,
		kubernetes: {
			cluster: "local",
			namespace: "fixtures",
			image: "fixture/store:latest",
			replicas: 1,
			...(forwards.length ? { portForwards: forwards } : {}),
		},
		secretRefs: {
			PGUSER: "DISPOSABLE_SQL_USER",
			PGPASSWORD: "DISPOSABLE_SQL_PASSWORD",
		},
		queryConnection: {
			protocol: "postgres",
			host: "127.0.0.1",
			port: sqlPort,
			database: "template1",
			usernameRef: "PGUSER",
			passwordRef: "PGPASSWORD",
			caRef: "database.pem",
		},
	};
}
/** One app pod plus the infrastructure pod that publishes the query forward. */
function document(
	config: Config,
	sqlPort: number,
	store = storeTarget(sqlPort, [{ local: sqlPort, remote: 5432 }]),
) {
	return {
		version: 1,
		projects: [
			{
				id: "api",
				kind: "app",
				repository: config.repositories[0],
				requires: ["store"],
				targets: [
					{
						id: "api",
						action: "run",
						runtime: "kubernetes",
						timeoutMs: 8000,
						kubernetes: {
							cluster: "local",
							namespace: "fixtures",
							image: "fixture/api:latest",
							replicas: 1,
						},
					},
				],
			},
			{
				id: "store",
				kind: "infrastructure",
				repository: config.repositories[0],
				targets: [store],
			},
		],
	};
}
const forwardRefusal =
	"Kubernetes query connections require exactly one declared loopback port forward on the query port";

test("an owned pod query connection requires its declared forward and stays read-only and redacted", async () => {
	const sqlPort = disposablePort(),
		databasePort = disposablePort();
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installDatabase(config);
		configureLocalCluster(config, podClient, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_FORWARD_PORT: String(databasePort),
		});
		expect(validateProjects(config, document(config, sqlPort))).toHaveLength(2);
		// A query connection without the forward on its own port, or with a
		// forward on another port, is never a SQL binding.
		expect(() =>
			validateProjects(
				config,
				document(config, sqlPort, storeTarget(sqlPort, [])),
			),
		).toThrow(forwardRefusal);
		expect(() =>
			validateProjects(
				config,
				document(
					config,
					sqlPort,
					storeTarget(sqlPort, [{ local: disposablePort(), remote: 5432 }]),
				),
			),
		).toThrow(forwardRefusal);
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, sqlPort)),
		);
	});
	await startDatabase(config, databasePort);
	let payload = "";
	fake.setResponses([
		call("env_start", { apps: ["api", "store"], runtime: "kubernetes" }),
		call("db_query", {
			infra: "store",
			sql: "SELECT current_setting('transaction_read_only') AS mode, (SELECT value FROM fixture_secrets) AS secret /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			payload = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	const review = await pendingReview(app, task, "Query store");
	expect(review.snapshot).toContain("read-only transaction");
	expect(review.snapshot).not.toContain(disposablePassword);
	await approve(app, task, "Query store");
	await app.harness.waitForTask(task as TaskId, context);
	const result = JSON.parse(payload) as {
		isError?: boolean;
		content: { type: string; text: string }[];
	}[];
	expect(result[0]?.isError).toBeFalsy();
	const body = JSON.parse(result[0]?.content[0]?.text ?? "{}");
	expect(body).toMatchObject({ readOnly: true, rollback: "confirmed" });
	expect(body.rows).toEqual([{ mode: "on", secret: "[REDACTED]" }]);
	expect(payload).not.toContain(disposablePassword);
	expect(
		fs.readFileSync(path.join(config.configDir, "sql-probes"), "utf8"),
	).toBe("query\n");
	const state = await app.environments.snapshot();
	expect(
		state.queryOperations.filter((query) => query.state === "completed"),
	).toHaveLength(1);
}, 30000);

test("a pod whose declared forward has exited grants no SQL authority", async () => {
	const sqlPort = disposablePort(),
		databasePort = disposablePort();
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installDatabase(config);
		configureLocalCluster(config, podClient, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_FORWARD_PORT: String(databasePort),
			FIXTURE_FORWARD_EXIT_MS: "400",
		});
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, sqlPort)),
		);
	});
	await startDatabase(config, databasePort);
	let refused = "";
	fake.setResponses([
		call("env_start", { apps: ["api", "store"], runtime: "kubernetes" }),
		call("db_query", {
			infra: "store",
			sql: "SELECT 1 AS empty /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			refused = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	// The declaration is admissible, so preparation reaches approval; the forward
	// has exited before the approved call is dispatched.
	await pendingReview(app, task, "Query store");
	await Bun.sleep(700);
	await approve(app, task, "Query store");
	await app.harness.waitForTask(task as TaskId, context);
	expect(refused).toContain(
		"SQL requires the exact live ready owned pod and its declared loopback forward on the query port",
	);
	expect(refused).toContain('"isError":true');
	expect(fs.existsSync(path.join(config.configDir, "sql-probes"))).toBe(false);
	const state = await app.environments.snapshot();
	expect(
		state.queryOperations.filter((query) => query.state === "completed"),
	).toHaveLength(0);
}, 30000);

test("a rotated configuration still queries through frozen startup pod credentials with redacted output", async () => {
	const sqlPort = disposablePort(),
		databasePort = disposablePort();
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installDatabase(config);
		configureLocalCluster(config, podClient, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_FORWARD_PORT: String(databasePort),
		});
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, sqlPort)),
		);
	});
	await startDatabase(config, databasePort);
	let payload = "";
	fake.setResponses([
		call("env_start", { apps: ["api", "store"], runtime: "kubernetes" }),
		call("db_query", {
			infra: "store",
			sql: "SELECT value FROM fixture_secrets /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			payload = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Query store");
	// Rotation after preparation must not change the frozen startup credentials
	// the approved pod query authenticates with.
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		"DISPOSABLE_SQL_USER=changed\nDISPOSABLE_SQL_PASSWORD=rotated\n",
	);
	await approve(app, task, "Query store");
	await app.harness.waitForTask(task as TaskId, context);
	const result = JSON.parse(payload) as {
		isError?: boolean;
		content: { type: string; text: string }[];
	}[];
	expect(result[0]?.isError).toBeFalsy();
	const body = JSON.parse(result[0]?.content[0]?.text ?? "{}");
	expect(body.rows).toEqual([{ value: "[REDACTED]" }]);
	expect(payload).not.toContain(disposablePassword);
	const state = await app.environments.snapshot();
	expect(
		state.queryOperations.filter((query) => query.state === "completed"),
	).toHaveLength(1);
}, 30000);

test("cancelling an issued pod query drains diagnostics without publishing success", async () => {
	const sqlPort = disposablePort(),
		databasePort = disposablePort();
	const { app, config, fake, invocation } = await fixture(false, (config) => {
		installDatabase(config);
		configureLocalCluster(config, podClient, {
			FIXTURE_STATE: path.join(config.configDir, "pods.json"),
			FIXTURE_FORWARD_PORT: String(databasePort),
		});
		fs.writeFileSync(
			path.join(config.configDir, "environments.json"),
			JSON.stringify(document(config, sqlPort)),
		);
	});
	await startDatabase(config, databasePort);
	fake.setResponses([
		call("env_start", { apps: ["api", "store"], runtime: "kubernetes" }),
		call("db_query", {
			infra: "store",
			sql: "SELECT pg_sleep(20) /* NATIVE_SQL_PROBE */",
		}),
		() => fauxAssistantMessage("Done"),
	]);
	const task = await app.startTask(invocation);
	await approve(app, task);
	await pendingReview(app, task, "Query store");
	await approve(app, task, "Query store");
	await eventually(async () => {
		const state = await app.environments.snapshot();
		return (
			state.queryOperations[0]?.state === "issued" &&
			fs.existsSync(path.join(config.configDir, "sql-probes"))
		);
	}, Boolean);
	const before = await app.environments.snapshot();
	expect(before.queryOperations[0]?.state).toBe("issued");
	expect(before.runs.every((run) => run.state === "running")).toBe(true);
	const started = Date.now();
	await app.cancel(task);
	expect(Date.now() - started).toBeLessThan(10000);
	const after = await app.environments.snapshot();
	expect(after.queryOperations[0]?.state).toBe("issued");
	expect(after.runs.every((run) => run.state === "exited")).toBe(true);
	expect(
		fs.readFileSync(path.join(config.configDir, "sql-probes"), "utf8").trim(),
	).toBe("query");
}, 30000);

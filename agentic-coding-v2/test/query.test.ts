import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { TaskId } from "@earendil-works/pi-durable";
import { serve } from "../src/server.ts";
import { approve, pendingReview } from "./fixtures/environment.ts";
import {
	disposablePassword,
	disposablePort,
	installPostgres,
} from "./fixtures/postgres.ts";
import { createFixtures, eventually } from "./fixtures/runtime.ts";

const { fixture, cleanup } = createFixtures();
afterEach(cleanup);
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
	fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
test("approved held SQL is read-only, precise, bounded and frozen-secret redacted; a function write fails without changing data", async () => {
	const port = disposablePort(),
		{ app, config, fake, invocation } = await fixture(false, (config) =>
			installPostgres(config, port),
		);
	const payloads: string[] = [];
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("db_query", {
			infra: "store",
			sql: "SELECT n::bigint+9007199254740992 AS exact, current_setting('transaction_read_only') AS mode, (SELECT value FROM fixture_secrets) AS secret FROM generate_series(1,5) AS g(n) /* NATIVE_SQL_PROBE */",
			limit: 3,
		}),
		call("db_query", {
			infra: "store",
			sql: "SELECT repeat('x',1000) || value || repeat('y',5000) AS oversized FROM fixture_secrets /* NATIVE_SQL_PROBE */",
		}),
		call("db_query", {
			infra: "store",
			sql: "SELECT fixture_write() /* NATIVE_SQL_PROBE */",
		}),
		call("db_query", {
			infra: "store",
			sql: "SELECT 1) AS _ac_rows; COMMIT; INSERT INTO public.items VALUES(77); SELECT (1 /* NATIVE_SQL_PROBE */",
		}),
		call("db_query", {
			infra: "store",
			schema: "public",
			sql: "SELECT count(*) AS count FROM items /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			const results = messages.messages.filter(
				(message) =>
					message.role === "toolResult" && message.toolName === "db_query",
			);
			transcript = JSON.stringify(results);
			for (const result of results)
				if (result.role === "toolResult")
					for (const part of result.content)
						if (part.type === "text") payloads.push(part.text);
			return fauxAssistantMessage("Done");
		},
	]);
	const task = await app.startTask(invocation),
		probes = path.join(config.configDir, "sql-probes");
	await approve(app, task);
	const review = await pendingReview(app, task, "Query store");
	expect(review.snapshot).toContain("read-only transaction");
	expect(JSON.parse(review.snapshot).request).not.toHaveProperty("root");
	expect(JSON.parse(review.snapshot).request.input).not.toHaveProperty("app");
	expect(review.snapshot).not.toContain(disposablePassword);
	expect(fs.existsSync(probes)).toBe(false);
	fs.writeFileSync(
		path.join(config.configDir, ".env"),
		"DISPOSABLE_SQL_USER=rotated-user\nDISPOSABLE_SQL_PASSWORD=rotated-password\n",
	);
	for (let i = 0; i < 5; i++) {
		await approve(app, task, "Query store");
		if (i < 4) await pendingReview(app, task, "Query store");
	}
	await app.harness.waitForTask(task as TaskId, context);
	expect(payloads).toHaveLength(5);
	const first = JSON.parse(payloads[0] ?? "{}"),
		large = JSON.parse(payloads[1] ?? "{}"),
		last = JSON.parse(payloads[4] ?? "{}");
	expect(first).toMatchObject({
		readOnly: true,
		rollback: "confirmed",
		more: true,
		returnedRows: 3,
		numericFormat: "strings",
	});
	expect(first.rows[0]).toEqual({
		exact: "9007199254740993",
		mode: "on",
		secret: "[REDACTED]",
	});
	expect(large).toMatchObject({
		truncatedRows: 1,
		returnedRows: 0,
		omittedWithinLimit: 1,
		rows: [],
	});
	expect(last.rows).toEqual([{ count: "5" }]);
	expect(transcript.match(/"isError":true/g)).toHaveLength(2);
	expect(transcript).not.toContain(disposablePassword);
	expect(transcript).not.toContain(disposablePassword.slice(0, 8));
	expect(transcript).not.toContain("BEGIN CERTIFICATE");
	expect(fs.readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(5);
	const state = await eventually(
		() => app.environments.snapshot(),
		(state) => state.runs.every((run) => run.state === "exited"),
	);
	expect(
		state.queryOperations.filter((query) => query.state === "completed"),
	).toHaveLength(3);
	expect(
		state.queryOperations.filter((query) => query.state === "issued"),
	).toHaveLength(2);
	expect(JSON.stringify(state.queryOperations)).not.toContain(
		"fixture_secrets",
	);
	const run = state.runs.find((run) => run.plan.app === "store"),
		host = serve(app);
	if (!run) throw new Error("Disposable SQL infrastructure run missing");
	try {
		const base = new URL(host.url),
			token = new URLSearchParams(base.hash.slice(1)).get("token"),
			headers = { Authorization: `Bearer ${token}` },
			route = new URL(
				`/api/environments/database-history?run=${encodeURIComponent(run.id)}`,
				base,
			),
			get = (url: URL) => fetch(url, { headers });
		expect((await fetch(route)).status).toBe(401);
		expect((await get(new URL(`${route}&run=${run.id}`))).status).toBe(400);
		expect((await get(new URL(`${route}&sql=SELECT+1`))).status).toBe(400);
		expect(
			(
				await get(
					new URL("/api/environments/database-history?run=unknown", base),
				)
			).status,
		).toBe(400);
		const window = await (await get(route)).json(),
			history = window.records;
		expect(window).toMatchObject({
			total: history.length,
			returned: history.length,
			omitted: 0,
			limit: 200,
			scope: "exact-run",
			order: "newest-issuance-first",
		});
		expect(history).toHaveLength(5);
		expect(history[0].observedAt).toBe(last.observedAt);
		expect(JSON.stringify(history)).not.toContain("fixture_secrets");
		const detail = new URL(route);
		detail.searchParams.set("operation", history.at(-1).id);
		const record = await (await get(detail)).json();
		expect(record.result).toMatchObject({
			rows: first.rows,
			rollback: "confirmed",
			readOnly: true,
		});
		expect(JSON.stringify(record)).not.toContain(disposablePassword);
		expect(JSON.stringify(record)).not.toContain("DISPOSABLE_SQL_PASSWORD");
		detail.searchParams.set(
			"operation",
			history.find((entry: { state: string }) => entry.state === "issued").id,
		);
		expect(await (await get(detail)).json()).toMatchObject({
			state: "issued",
			result: null,
		});
		detail.searchParams.set("operation", "query-unknown");
		expect((await get(detail)).status).toBe(400);
		// App-run IDs cannot substitute for the recorded infrastructure run.
		const appRun = state.runs.find((run) => run.plan.app === "api");
		if (!appRun) throw new Error("Disposable SQL application run missing");
		detail.searchParams.set("run", appRun.id);
		expect((await get(detail)).status).toBe(400);
		expect(fs.readFileSync(probes, "utf8").trim().split("\n")).toHaveLength(5);
	} finally {
		host.stop();
	}
}, 30000);

test("SQL refuses certificate-IP mismatch, TLS downgrade and changed approved CA before dispatch", async () => {
	const port = disposablePort(),
		{ app, config, fake, invocation } = await fixture(false, (config) =>
			installPostgres(config, port, true),
		);
	let transcript = "";
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("db_query", {
			infra: "store",
			sql: "SELECT 1 /* NATIVE_SQL_PROBE */",
		}),
		call("db_query", {
			infra: "store",
			sql: "SELECT 2 /* NATIVE_SQL_PROBE */",
		}),
		call("db_query", {
			infra: "store",
			sql: "SELECT 3 /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			transcript = JSON.stringify(
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
	await approve(app, task, "Query store");
	await pendingReview(app, task, "Query store");
	fs.writeFileSync(path.join(config.configDir, "refuse-tls"), "reject TLS");
	await approve(app, task, "Query store");
	await pendingReview(app, task, "Query store");
	fs.appendFileSync(path.join(config.configDir, "database.pem"), "\n");
	await approve(app, task, "Query store");
	await app.harness.waitForTask(task as TaskId, context);
	expect(transcript.match(/"isError":true/g)).toHaveLength(3);
	expect(transcript).toContain("CA source changed");
	expect(fs.existsSync(path.join(config.configDir, "sql-probes"))).toBe(false);
	const state = await app.environments.snapshot();
	expect(state.queryOperations).toHaveLength(2);
	expect(state.queryOperations[0]?.state).toBe("issued");
	expect(transcript).not.toContain("PRIVATE KEY");
}, 20000);

test("foreign tasks and stopped dependency receipts never grant SQL authority", async () => {
	const port = disposablePort(),
		{ app, config, fake, invocation } = await fixture(false, (config) =>
			installPostgres(config, port),
		);
	fake.setResponses([
		call("env_start", { apps: ["api"] }),
		call("request_review", { path: ".", title: "Hold SQL owner" }),
	]);
	const owner = await app.startTask(invocation);
	await approve(app, owner);
	await pendingReview(app, owner, "Hold SQL owner");
	let foreignResult = "",
		stoppedResult = "";
	fake.setResponses([
		call("db_query", {
			infra: "store",
			sql: "SELECT 1 /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			foreignResult = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Foreign refused");
		},
	]);
	const foreign = await app.startTask({
		...invocation,
		requestId: "foreign-sql",
	});
	await app.harness.waitForTask(foreign as TaskId, context);
	expect(foreignResult).toContain("receipts grant no authority");
	expect(
		(await app.environments.snapshot()).runs.every(
			(run) => run.state === "running",
		),
	).toBe(true);
	fake.setResponses([
		call("env_stop", { apps: ["api"] }),
		call("db_query", {
			infra: "store",
			sql: "SELECT 1 /* NATIVE_SQL_PROBE */",
		}),
		(messages) => {
			stoppedResult = JSON.stringify(
				messages.messages.filter(
					(message) =>
						message.role === "toolResult" && message.toolName === "db_query",
				),
			);
			return fauxAssistantMessage("Stopped refused");
		},
	]);
	await approve(app, owner, "Hold SQL owner");
	await app.harness.waitForTask(owner as TaskId, context);
	expect(stoppedResult).toContain("receipts grant no authority");
	expect(fs.existsSync(path.join(config.configDir, "sql-probes"))).toBe(false);
	expect((await app.environments.snapshot()).queryOperations).toHaveLength(0);
}, 20000);

test("explicit SQL app selection binds its live transitive prerequisite generations without fallback or weakening coupled cleanup", async () => {
	const port = disposablePort(),
		{ app, config, fake, invocation } = await fixture(false, (config) => {
			installPostgres(config, port);
			const file = path.join(config.configDir, "environments.json"),
				definition = JSON.parse(fs.readFileSync(file, "utf8"));
			const api = definition.projects.find(
				(project: { id: string }) => project.id === "api",
			);
			if (!api) throw new Error("Missing disposable SQL app");
			definition.projects.push(
				{ ...api, id: "relay", kind: "infrastructure", requires: ["store"] },
				{ ...api, id: "editor", requires: ["relay", "store"] },
				{ ...api, id: "console", requires: [] },
			);
			fs.writeFileSync(file, JSON.stringify(definition));
		});
	let results: string[] = [];
	const query = (app: string) =>
		call("db_query", {
			infra: "store",
			app,
			sql: "SELECT count(*) AS count FROM items /* NATIVE_SQL_PROBE */",
		});
	fake.setResponses([
		call("env_start", { apps: ["api", "editor", "console"] }),
		query("console"),
		query("missing"),
		query("editor"),
		call("request_review", { path: ".", title: "Selected SQL completed" }),
		query("api"),
		(messages) => {
			results = messages.messages.flatMap((message) =>
				message.role === "toolResult" && message.toolName === "db_query"
					? message.content.flatMap((part) =>
							part.type === "text" ? [part.text] : [],
						)
					: [],
			);
			return fauxAssistantMessage("Stopped root was not substituted");
		},
	]);
	const owner = await app.startTask(invocation),
		probes = path.join(config.configDir, "sql-probes");
	await approve(app, owner);
	// The two invalid selectors must fail before any query review or issuance.
	const review = await pendingReview(app, owner, "Query store"),
		approved = JSON.parse(review.snapshot).request;
	const running = await app.environments.snapshot(),
		editor = running.runs.find((run) => run.plan.app === "editor");
	if (!editor) throw new Error("Missing selected disposable root");
	expect(fs.existsSync(probes)).toBe(false);
	expect(running.queryOperations).toHaveLength(0);
	expect(approved.input.app).toBe("editor");
	expect(approved.app).toBe("editor");
	expect(approved.root.run).toBe(editor.id);
	expect(new Set(approved.root.resources)).toEqual(
		new Set(
			running.runs
				.filter((run) => ["relay", "store"].includes(run.plan.app))
				.map((run) => run.id),
		),
	);
	expect(approved.root.resources).toHaveLength(2); // Diamond store requirement is unique.
	expect(review.snapshot).not.toContain(disposablePassword);
	await approve(app, owner, "Query store");
	await pendingReview(app, owner, "Selected SQL completed");
	expect(fs.readFileSync(probes, "utf8").trim()).toBe("query");
	const issued = await app.environments.snapshot(),
		store = issued.runs.find((run) => run.plan.app === "store");
	if (!store) throw new Error("Missing disposable infrastructure");
	const host = serve(app);
	try {
		const base = new URL(host.url),
			token = new URLSearchParams(base.hash.slice(1)).get("token"),
			response = await fetch(
				new URL(
					`/api/environments/database-history?run=${encodeURIComponent(store.id)}`,
					base,
				),
				{ headers: { Authorization: `Bearer ${token}` } },
			);
		expect(response.status).toBe(200);
		const history = await response.json();
		expect(history.records[0]).toMatchObject({
			app: "editor",
			rootRun: editor.id,
			state: "completed",
		});
	} finally {
		host.stop();
	}
	await approve(app, owner, "Selected SQL completed");
	const second = await pendingReview(app, owner, "Query store"),
		secondApproval = JSON.parse(second.snapshot).request;
	expect(secondApproval.input.app).toBe("api");
	expect(secondApproval.root.run).not.toBe(approved.root.run);
	expect(secondApproval.root.resources).toEqual([store.id]);
	// Existing coupled semantics remain: selecting any member stops this whole batch.
	await app.environments.stopOnce("stop-reviewed-sql-root", owner, ["api"]);
	await approve(app, owner, "Query store");
	await app.harness.waitForTask(owner as TaskId, context);
	expect(results).toHaveLength(4);
	expect(results[0]).toContain("no fallback");
	expect(results[1]).toContain("no fallback");
	expect(JSON.parse(results[2] ?? "{}")).toMatchObject({
		app: "editor",
		root: approved.root,
		rows: [{ count: "5" }],
		rollback: "confirmed",
	});
	expect(results[3]).toContain("receipts grant no authority");
	const final = await app.environments.snapshot();
	expect(final.runs.every((run) => run.state === "exited")).toBe(true);
	expect(final.queryOperations).toHaveLength(1);
	expect(fs.readFileSync(probes, "utf8").trim()).toBe("query");
}, 30000);

// The agent debug routes (`add-agent-debug-tools`, tasks 1.3-2.3).
//
// The trace index, the read-only data path and the endpoint call are exercised
// through their real handler, with the SQL port, the transport, the run-target
// discovery and the app slots injected: attribution by `ac.owner`/`ac.run`, the
// read-only transaction that always rolls back, and the `app-not-held` refusal
// are all checked end to end.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LogData, SpanData } from "../src/contracts/telemetry.ts";
import {
	type DbQueryConnection,
	MAX_VALUE_CHARS,
	runReadOnlyQuery,
	type SqlPort,
	type SqlSession,
} from "../src/server/debug/db-query.ts";
import {
	type DebugRouteDeps,
	handleDebugRoute,
} from "../src/server/debug/routes.ts";
import {
	AC_OWNER_ATTRIBUTE,
	LogIndex,
	MAX_ATTRIBUTE_CHARS,
	MAX_INDEXED_TRACES,
	MAX_LOG_BODY_CHARS,
	TraceIndex,
} from "../src/server/debug/trace-index.ts";
import type { App, InfraService } from "../src/server/environment/config.ts";
import type { EnvironmentManager } from "../src/server/environment/manager.ts";
import {
	AGENT_DB_QUERY_PATH,
	AGENT_HTTP_REQUEST_PATH,
	AGENT_LIST_PATH,
	AGENT_OTEL_QUERY_PATH,
} from "../src/server/protocol.ts";
import type { EnvironmentInstanceController } from "../src/server/runtime/instances.ts";

const WORKFLOW_ID = "wf-debug";
const OWNER = `workflow:${WORKFLOW_ID}`;

function nanosAt(ms: number): string {
	return (BigInt(ms) * 1_000_000n).toString();
}

function span(input: {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	owner?: string;
	app?: string;
	run?: string;
	startMs: number;
	durationMs?: number;
	status?: "error" | "ok" | "unset";
	attributes?: Array<{ key: string; value: string | number | boolean }>;
	events?: SpanData["events"];
	/** The OTLP kind; `2` (server) unless a test builds background traffic. */
	kind?: number;
}): SpanData {
	const start = input.startMs;
	const end = start + (input.durationMs ?? 5);
	const resource = [
		...(input.owner === undefined
			? []
			: [{ key: "ac.owner", value: input.owner }]),
		...(input.app === undefined ? [] : [{ key: "ac.app", value: input.app }]),
		...(input.run === undefined ? [] : [{ key: "ac.run", value: input.run }]),
	];
	return {
		traceId: input.traceId,
		spanId: input.spanId,
		parentSpanId: input.parentSpanId ?? "",
		name: input.name,
		startTimeUnixNano: nanosAt(start),
		endTimeUnixNano: nanosAt(end),
		status: {
			code: input.status === "error" ? 2 : input.status === "ok" ? 1 : 0,
		},
		attributes: input.attributes ?? [],
		resource: { attributes: resource, droppedAttributesCount: 0 },
		scope: { name: "test", version: "1" },
		serviceName: input.app ?? "shop",
		kind: input.kind ?? 2,
		...(input.events === undefined ? {} : { events: input.events }),
	};
}

/** A trace of one run: a request span, a database child, and one error. */
function requestTrace(input: {
	traceId: string;
	owner: string;
	app?: string;
	run?: string;
	startMs?: number;
	status?: "error" | "ok";
}): SpanData[] {
	const start = input.startMs ?? Date.parse("2026-01-01T00:00:00.000Z");
	const app = input.app ?? "shop";
	return [
		span({
			traceId: input.traceId,
			spanId: `${input.traceId}-root`,
			name: "GET /orders",
			owner: input.owner,
			app,
			run: input.run,
			startMs: start,
			durationMs: 120,
			status: input.status ?? "ok",
			attributes: [
				{ key: "http.method", value: "GET" },
				{ key: "http.status_code", value: 200 },
				{ key: "unrelated.attribute", value: "dropped" },
			],
		}),
		span({
			traceId: input.traceId,
			spanId: `${input.traceId}-db`,
			parentSpanId: `${input.traceId}-root`,
			name: "SELECT orders",
			owner: input.owner,
			app,
			run: input.run,
			startMs: start + 10,
			durationMs: 20,
			status: input.status ?? "ok",
			attributes: [{ key: "db.statement", value: "SELECT * FROM orders" }],
			events: [
				{
					name: "exception",
					timeUnixNano: nanosAt(start + 25),
					attributes: [{ key: "exception.message", value: "boom" }],
				},
			],
		}),
	];
}

function urlFor(pathname: string): URL {
	return new URL(`http://127.0.0.1${pathname}`);
}

async function post(
	deps: DebugRouteDeps,
	pathname: string,
	body: unknown,
	owner = OWNER,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const response = await handleDebugRoute(
		deps,
		new Request(`http://127.0.0.1${pathname}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		urlFor(pathname),
		owner,
	);
	if (!response) throw new Error(`${pathname} is not a debug route`);
	return {
		status: response.status,
		json: (await response.json()) as Record<string, unknown>,
	};
}

function errorOf(json: Record<string, unknown>): {
	code?: string;
	message?: string;
} {
	return (json.error ?? {}) as { code?: string; message?: string };
}

function valueIn(json: Record<string, unknown>): Record<string, unknown> {
	return (json.value ?? {}) as Record<string, unknown>;
}

/** One log record of a run, attributed by the same resource attributes. */
function logRecord(input: {
	owner?: string;
	app?: string;
	run?: string;
	body: string;
	severity?: string;
	traceId?: string;
	spanId?: string;
	timeMs?: number;
	attributes?: Array<{ key: string; value: string | number | boolean }>;
}): LogData {
	return {
		resource: {
			attributes: [
				...(input.owner === undefined
					? []
					: [{ key: "ac.owner", value: input.owner }]),
				...(input.app === undefined
					? []
					: [{ key: "ac.app", value: input.app }]),
				...(input.run === undefined
					? []
					: [{ key: "ac.run", value: input.run }]),
			],
		},
		scope: { name: "test", version: "1" },
		timeUnixNano: nanosAt(
			input.timeMs ?? Date.parse("2026-01-01T00:00:00.000Z"),
		),
		severity: input.severity ?? "INFO",
		body: input.body,
		attributes: (input.attributes ?? []).map((attribute) => ({
			key: attribute.key,
			value: String(attribute.value),
		})),
		...(input.traceId === undefined ? {} : { traceId: input.traceId }),
		...(input.spanId === undefined ? {} : { spanId: input.spanId }),
		serviceName: input.app ?? "shop",
	};
}

describe("otel_query", () => {
	test("answers with this workflow's runs and never a previous holder's", async () => {
		const index = new TraceIndex();
		// workflow:a held shop, exported a trace, and released it. The next holder
		// runs the same app on the same static address.
		index.push(
			requestTrace({
				traceId: "aaa1",
				owner: "workflow:a",
				run: "grant-a",
				startMs: Date.parse("2026-01-01T00:00:00.000Z"),
			}),
		);
		index.push(
			requestTrace({
				traceId: "bbb1",
				owner: OWNER,
				run: "grant-b",
				startMs: Date.parse("2026-01-01T00:00:05.000Z"),
			}),
		);
		// A span that names no owner is nobody's: it is not indexed at all.
		index.push([
			span({
				traceId: "ccc1",
				spanId: "ccc1-root",
				name: "workflow telemetry",
				startMs: Date.parse("2026-01-01T00:00:06.000Z"),
			}),
		]);
		const { status, json } = await post(
			{ traceIndex: index },
			AGENT_OTEL_QUERY_PATH,
			{},
		);
		expect(status).toBe(200);
		const value = valueIn(json);
		expect(value.mode).toBe("list");
		expect(value.owner).toBe(OWNER);
		const traces = value.traces as Array<Record<string, unknown>>;
		expect(traces.map((trace) => trace.traceId)).toEqual(["bbb1"]);
		expect(traces[0]).toMatchObject({
			root: "GET /orders",
			status: "ok",
			errorCount: 0,
			app: "shop",
			run: "grant-b",
			spanCount: 2,
		});
		expect(index.size("workflow:a")).toBe(1);
	});

	test("a background poller is ranked after the request trace, and reported", async () => {
		const index = new TraceIndex();
		// The shape the end-to-end run hit: a poller exporting one SELECT span
		// twice a second, newer than the one request that mattered.
		const poller = ["p1", "p2", "p3"].map((traceId, position) =>
			span({
				traceId,
				spanId: `${traceId}-root`,
				name: "SELECT 1",
				owner: OWNER,
				app: "shop",
				startMs: Date.parse("2026-01-01T00:01:00.000Z") + position,
				kind: 3,
			}),
		);
		index.push([
			...poller,
			...requestTrace({
				traceId: "req-1",
				owner: OWNER,
				app: "shop",
				startMs: Date.parse("2026-01-01T00:00:00.000Z"),
			}),
		]);
		// A limit of one still answers the request trace, not the newest poller.
		const listed = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			limit: 1,
		});
		const value = valueIn(listed.json);
		expect(
			(value.traces as Array<Record<string, unknown>>).map((t) => t.traceId),
		).toEqual(["req-1"]);
		expect(value.noiseDropped).toBe(3);
		expect(String(value.notice)).toContain("includeNoise");

		// Asking for them, or narrowing by hand, removes the default ordering.
		const noise = valueIn(
			(
				await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
					limit: 1,
					includeNoise: true,
				})
			).json,
		);
		expect(
			(noise.traces as Array<Record<string, unknown>>).map((t) => t.traceId),
		).toEqual(["p3"]);
		expect(noise.noiseDropped).toBe(0);
		const narrowed = valueIn(
			(
				await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
					minSpans: 2,
				})
			).json,
		);
		expect(
			(narrowed.traces as Array<Record<string, unknown>>).map((t) => t.traceId),
		).toEqual(["req-1"]);
		expect(narrowed.noiseDropped).toBe(0);
		const excluded = valueIn(
			(
				await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
					excludeNames: "SELECT",
				})
			).json,
		);
		expect(
			(excluded.traces as Array<Record<string, unknown>>).map((t) => t.traceId),
		).toEqual(["req-1"]);
	});

	test("the root kind and an HTTP route narrow the list", async () => {
		const index = new TraceIndex();
		index.push([
			...requestTrace({ traceId: "req-1", owner: OWNER, app: "shop" }),
			...requestTrace({
				traceId: "req-2",
				owner: OWNER,
				app: "shop",
				startMs: Date.parse("2026-01-01T00:00:10.000Z"),
			}),
		]);
		const value = valueIn(
			(
				await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
					rootKind: "server",
					http: "/orders",
				})
			).json,
		);
		expect(
			(value.traces as Array<Record<string, unknown>>).map((t) => t.traceId),
		).toEqual(["req-2", "req-1"]);
		expect((value.traces as Array<Record<string, unknown>>)[0]?.rootKind).toBe(
			"server",
		);
		const none = valueIn(
			(
				await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
					rootKind: "consumer",
				})
			).json,
		);
		expect(none.traces).toEqual([]);
	});

	test("the log records of one request are answerable by trace id", async () => {
		const traceIndex = new TraceIndex();
		const logIndex = new LogIndex();
		logIndex.push([
			logRecord({
				owner: OWNER,
				app: "shop",
				run: "grant-b",
				body: "handling GET /orders",
				traceId: "req-1",
				spanId: "req-1-root",
				timeMs: Date.parse("2026-01-01T00:00:00.000Z"),
			}),
			logRecord({
				owner: OWNER,
				app: "shop",
				run: "grant-b",
				body: "order lookup failed",
				severity: "ERROR",
				traceId: "req-1",
				spanId: "req-1-db",
				timeMs: Date.parse("2026-01-01T00:00:00.500Z"),
				attributes: [{ key: "db.statement", value: "SELECT * FROM orders" }],
			}),
			// Another workflow's record is never returned, even though its app and
			// grant are the same shape.
			logRecord({
				owner: "workflow:a",
				app: "shop",
				body: "somebody else's line",
				traceId: "req-1",
			}),
			// A record that names no owner is nobody's: it is not indexed at all.
			logRecord({ body: "workflow telemetry", traceId: "req-1" }),
		]);
		expect(logIndex.size(OWNER)).toBe(2);
		expect(logIndex.size("workflow:a")).toBe(1);

		const byTrace = valueIn(
			(
				await post({ traceIndex, logIndex }, AGENT_OTEL_QUERY_PATH, {
					mode: "logs",
					traceId: "req-1",
				})
			).json,
		);
		expect(byTrace.mode).toBe("logs");
		expect(byTrace.owner).toBe(OWNER);
		const lines = byTrace.logs as Array<Record<string, unknown>>;
		// Newest first, and only this workflow's records.
		expect(lines.map((line) => line.body)).toEqual([
			"order lookup failed",
			"handling GET /orders",
		]);
		expect(lines[0]).toMatchObject({
			severity: "ERROR",
			service: "shop",
			traceId: "req-1",
			spanId: "req-1-db",
			attributes: { "db.statement": "SELECT * FROM orders" },
		});

		const errors = valueIn(
			(
				await post({ traceIndex, logIndex }, AGENT_OTEL_QUERY_PATH, {
					mode: "logs",
					severity: "error",
				})
			).json,
		);
		expect((errors.logs as Array<Record<string, unknown>>).length).toBe(1);
		// A filter alone selects the logs mode, so a caller need not know to ask.
		const text = valueIn(
			(
				await post({ traceIndex, logIndex }, AGENT_OTEL_QUERY_PATH, {
					text: "lookup failed",
				})
			).json,
		);
		expect(text.mode).toBe("logs");
		expect((text.logs as Array<Record<string, unknown>>).length).toBe(1);
		const limited = valueIn(
			(
				await post({ traceIndex, logIndex }, AGENT_OTEL_QUERY_PATH, {
					mode: "logs",
					limit: 1,
				})
			).json,
		);
		expect(limited.matched).toBe(2);
		expect(limited.truncated).toBe(true);
	});

	test("a log body is bounded and a server without a log index says so", async () => {
		const traceIndex = new TraceIndex();
		const logIndex = new LogIndex();
		logIndex.push([
			logRecord({ owner: OWNER, body: "x".repeat(MAX_LOG_BODY_CHARS + 100) }),
			logRecord({
				owner: OWNER,
				body: "ok",
				attributes: [
					{ key: "long", value: "y".repeat(MAX_ATTRIBUTE_CHARS + 100) },
				],
			}),
		]);
		const value = valueIn(
			(
				await post({ traceIndex, logIndex }, AGENT_OTEL_QUERY_PATH, {
					mode: "logs",
				})
			).json,
		);
		const lines = value.logs as Array<Record<string, unknown>>;
		// Both records carry the same instant, so they keep their insertion order.
		expect(String(lines[0]?.body)).toHaveLength(MAX_LOG_BODY_CHARS + 1);
		expect(
			((lines[1]?.attributes ?? {}) as Record<string, string>).long,
		).toHaveLength(MAX_ATTRIBUTE_CHARS + 1);

		const missing = await post({ traceIndex }, AGENT_OTEL_QUERY_PATH, {
			mode: "logs",
		});
		expect(missing.status).toBe(503);
		expect(errorOf(missing.json).code).toBe("log-index-unavailable");
	});

	test("filters by app, name, status and since, and bounds the list", async () => {
		const index = new TraceIndex();
		index.push([
			...requestTrace({
				traceId: "t1",
				owner: OWNER,
				app: "shop",
				startMs: Date.parse("2026-01-01T00:00:00.000Z"),
			}),
			...requestTrace({
				traceId: "t2",
				owner: OWNER,
				app: "admin",
				startMs: Date.parse("2026-01-02T00:00:00.000Z"),
				status: "error",
			}),
		]);
		const errors = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			status: "error",
		});
		expect(
			(valueIn(errors.json).traces as Array<Record<string, unknown>>).map(
				(trace) => trace.traceId,
			),
		).toEqual(["t2"]);
		const apps = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			app: "shop",
		});
		expect(
			(valueIn(apps.json).traces as Array<Record<string, unknown>>).map(
				(trace) => trace.traceId,
			),
		).toEqual(["t1"]);
		const names = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			name: "select orders",
		});
		expect((valueIn(names.json).traces as unknown[]).length).toBe(2);
		const since = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			since: "2026-01-01T12:00:00.000Z",
		});
		expect(
			(valueIn(since.json).traces as Array<Record<string, unknown>>).map(
				(trace) => trace.traceId,
			),
		).toEqual(["t2"]);
		const limited = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			limit: 1,
		});
		expect(valueIn(limited.json)).toMatchObject({
			matched: 2,
			truncated: true,
		});
		const bad = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			since: "yesterday",
		});
		expect(bad.status).toBe(400);
		expect(errorOf(bad.json).code).toBe("invalid-since");
	});

	test("keeps the newest traces and says when it dropped older ones", async () => {
		const index = new TraceIndex();
		index.push(
			Array.from({ length: MAX_INDEXED_TRACES + 1 }, (_unused, at) =>
				span({
					traceId: `trace-${at}`,
					spanId: `span-${at}`,
					name: "request",
					owner: OWNER,
					app: "shop",
					startMs: Date.parse("2026-01-01T00:00:00.000Z") + at,
				}),
			),
		);
		expect(index.size(OWNER)).toBe(MAX_INDEXED_TRACES);
		const { json } = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			limit: 100,
		});
		expect(valueIn(json)).toMatchObject({
			matched: MAX_INDEXED_TRACES,
			indexTruncated: true,
		});
	});

	test("returns one trace's span tree with key attributes and events", async () => {
		const index = new TraceIndex();
		index.push(requestTrace({ traceId: "t1", owner: OWNER, run: "grant-1" }));
		const { status, json } = await post(
			{ traceIndex: index },
			AGENT_OTEL_QUERY_PATH,
			{ traceId: "t1" },
		);
		expect(status).toBe(200);
		const value = valueIn(json);
		expect(value).toMatchObject({ mode: "tree", app: "shop", run: "grant-1" });
		const tree = value.spans as Array<Record<string, unknown>>;
		expect(tree).toHaveLength(1);
		expect(tree[0]).toMatchObject({ name: "GET /orders", status: "ok" });
		// Only the key attributes travel; everything else stays in the receiver.
		expect(tree[0]?.attributes).toEqual({
			"http.method": "GET",
			"http.status_code": "200",
		});
		const children = tree[0]?.children as Array<Record<string, unknown>>;
		expect(children[0]).toMatchObject({
			name: "SELECT orders",
			parentSpanId: "t1-root",
		});
		expect(children[0]?.attributes).toEqual({
			"db.statement": "SELECT * FROM orders",
		});
		expect(children[0]?.events).toEqual([
			{
				name: "exception",
				time: "2026-01-01T00:00:00.025Z",
				attributes: { "exception.message": "boom" },
			},
		]);
	});

	test("truncates a long db.statement and refuses an unknown trace", async () => {
		const index = new TraceIndex();
		index.push([
			span({
				traceId: "t1",
				spanId: "t1-root",
				name: "query",
				owner: OWNER,
				app: "shop",
				startMs: Date.parse("2026-01-01T00:00:00.000Z"),
				attributes: [{ key: "db.statement", value: "x".repeat(5_000) }],
			}),
		]);
		const found = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "t1",
		});
		const node = (
			valueIn(found.json).spans as Array<Record<string, unknown>>
		)[0];
		const attributes = node?.attributes as Record<string, string>;
		expect(attributes["db.statement"]?.length).toBe(MAX_ATTRIBUTE_CHARS + 1);
		const missing = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "nope",
		});
		expect(missing.status).toBe(404);
		expect(errorOf(missing.json).code).toBe("trace-unknown");
	});

	test("answers 503 when this server receives no telemetry", async () => {
		const { status, json } = await post({}, AGENT_OTEL_QUERY_PATH, {});
		expect(status).toBe(503);
		expect(errorOf(json).code).toBe("trace-index-unavailable");
	});
});

// ---------------------------------------------------------------------------
// db_query
// ---------------------------------------------------------------------------

interface SqlCall {
	readonly statement: string;
}

function sqlPort(options: {
	calls: SqlCall[];
	rows?: readonly unknown[];
	failOn?: string;
	closed?: { count: number };
}): SqlPort {
	return {
		async open(): Promise<SqlSession> {
			return {
				async query(statement: string) {
					options.calls.push({ statement });
					if (options.failOn && statement.includes(options.failOn))
						throw new Error(
							"ERROR: cannot execute UPDATE in a read-only transaction",
						);
					if (statement === "SELECT 1")
						return options.rows ?? [{ id: 1, name: "order" }];
					return [];
				},
				async close() {
					if (options.closed) options.closed.count++;
				},
			};
		},
	};
}

const ORDERS: InfraService = {
	ident: "orders-db",
	displayName: "Orders DB",
	type: "docker",
	query: {
		kind: "postgres",
		host: "127.0.0.1",
		port: 5432,
		database: "orders",
		userEnv: "ORDERS_DB_USER",
		passwordEnv: "ORDERS_DB_PASSWORD",
	},
};

function appOf(ident: string, checkout: string): App {
	return {
		ident,
		displayName: ident,
		repositoryPath: `https://example.com/${ident}.git`,
		appType: "APP",
		sourceType: "git",
		gitMode: "BRANCH",
		localDirectoryPath: checkout,
		branch: "main",
	};
}

interface SlotStub {
	readonly app: string;
	readonly holder: string | null;
	readonly endpoints: Record<string, string>;
}

function instancesDouble(
	slots: readonly SlotStub[],
	touched: string[] = [],
): EnvironmentInstanceController {
	return {
		slots: async () => slots,
		touchOwnedActivity: (owner: string, app: string) => {
			touched.push(`${owner}:${app}`);
		},
	} as unknown as EnvironmentInstanceController;
}

function appsDouble(apps: readonly App[]): EnvironmentManager {
	return {
		getApps: () => apps,
		getAppByIdent: (ident: string) => apps.find((app) => app.ident === ident),
	} as unknown as EnvironmentManager;
}

function dbDeps(overrides: Partial<DebugRouteDeps> = {}): DebugRouteDeps {
	const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "debug-routes-"));
	const app = appOf("shop", checkout);
	return {
		instances: instancesDouble([
			{
				app: "shop",
				holder: OWNER,
				endpoints: { api: "http://127.0.0.1:8080" },
			},
		]),
		apps: appsDouble([app]),
		infraServices: () => [ORDERS],
		resolveOwnerCheckout: () => checkout,
		discovery: () => [
			{
				id: "app/shop/action/run/docker/default",
				action: "run",
				runtime: "docker",
				label: "default",
				sourcePath: path.join(checkout, "docker-compose.yml"),
				requires: [{ infra: "orders-db" }],
			},
		],
		env: (name: string) =>
			name === "ORDERS_DB_USER"
				? "orders"
				: name === "ORDERS_DB_PASSWORD"
					? "hunter2-secret"
					: undefined,
		...overrides,
	};
}

describe("db_query", () => {
	test("runs inside a read-only transaction and always rolls back", async () => {
		const calls: SqlCall[] = [];
		const closed = { count: 0 };
		const { status, json } = await post(
			dbDeps({ sql: sqlPort({ calls, closed }) }),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1" },
		);
		expect(status).toBe(200);
		expect(calls.map((call) => call.statement)).toEqual([
			"BEGIN READ ONLY",
			"SET LOCAL statement_timeout = '10s'",
			"SELECT 1",
			"ROLLBACK",
		]);
		expect(closed.count).toBe(1);
		expect(valueIn(json)).toMatchObject({
			kind: "postgres",
			database: "orders",
			rowCount: 1,
			limit: 50,
			truncated: false,
		});
	});

	test("selects a schema with a quoted identifier and bounds a MySQL query", async () => {
		const calls: SqlCall[] = [];
		await post(dbDeps({ sql: sqlPort({ calls }) }), AGENT_DB_QUERY_PATH, {
			infra: "orders-db",
			sql: "SELECT 1",
			schema: "reporting",
			limit: 5,
		});
		expect(calls.map((call) => call.statement)).toContain(
			'SET LOCAL search_path = "reporting"',
		);
		const mysql: SqlCall[] = [];
		await post(
			dbDeps({
				sql: sqlPort({ calls: mysql }),
				infraServices: () => [
					{
						...ORDERS,
						query: {
							kind: "mysql",
							host: "127.0.0.1",
							port: 3306,
							database: "orders",
							userEnv: "ORDERS_DB_USER",
							passwordEnv: "ORDERS_DB_PASSWORD",
						},
					},
				],
			}),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1", schema: "orders" },
		);
		expect(mysql.map((call) => call.statement)).toEqual([
			"SET SESSION max_execution_time = 10000",
			"USE `orders`",
			"START TRANSACTION READ ONLY",
			"SELECT 1",
			"ROLLBACK",
		]);
	});

	test("a refused write reports the database's answer and still rolls back", async () => {
		const calls: SqlCall[] = [];
		const closed = { count: 0 };
		const { status, json } = await post(
			dbDeps({ sql: sqlPort({ calls, closed, failOn: "UPDATE" }) }),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "UPDATE orders SET paid = true" },
		);
		expect(status).toBe(400);
		expect(errorOf(json).code).toBe("query-failed");
		expect(errorOf(json).message).toContain("read-only transaction");
		expect(calls.map((call) => call.statement)).toEqual([
			"BEGIN READ ONLY",
			"SET LOCAL statement_timeout = '10s'",
			"UPDATE orders SET paid = true",
			"ROLLBACK",
		]);
		expect(closed.count).toBe(1);
	});

	test("refuses an infra the held app does not require", async () => {
		const calls: SqlCall[] = [];
		const required = await post(
			dbDeps({
				sql: sqlPort({ calls }),
				discovery: () => [
					{
						id: "app/shop/action/run/docker/default",
						action: "run",
						runtime: "docker",
						label: "default",
						sourcePath: "/tmp/compose.yml",
						requires: [{ infra: "billing-db" }],
					},
				],
			}),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1" },
		);
		expect(required.status).toBe(409);
		expect(errorOf(required.json).code).toBe("infra-not-required");
		expect(calls).toHaveLength(0);
		// Nothing held at all: the refusal says which precondition failed.
		const held = await post(
			dbDeps({
				sql: sqlPort({ calls }),
				instances: instancesDouble([
					{ app: "shop", holder: "workflow:other", endpoints: {} },
				]),
			}),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1" },
		);
		expect(held.status).toBe(409);
		expect(errorOf(held.json).code).toBe("app-not-held");
		expect(calls).toHaveLength(0);
	});

	test("refuses an infra without a query connection and missing credentials", async () => {
		const noQuery = await post(
			dbDeps({
				infraServices: () => [{ ident: "orders-db", displayName: "Orders" }],
				sql: sqlPort({ calls: [] }),
			}),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1" },
		);
		expect(noQuery.status).toBe(409);
		expect(errorOf(noQuery.json).code).toBe("no-query-connection");
		const missing = await post(
			dbDeps({ sql: sqlPort({ calls: [] }), env: () => undefined }),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1" },
		);
		expect(missing.status).toBe(409);
		expect(errorOf(missing.json).code).toBe("credentials-missing");
		// The refusal names the variables, never a value.
		expect(errorOf(missing.json).message).toContain("ORDERS_DB_PASSWORD");
		expect(errorOf(missing.json).message).not.toContain("hunter2-secret");
		const unknown = await post(
			dbDeps({ sql: sqlPort({ calls: [] }) }),
			AGENT_DB_QUERY_PATH,
			{ infra: "nope", sql: "SELECT 1" },
		);
		expect(unknown.status).toBe(404);
		expect(errorOf(unknown.json).code).toBe("infra-not-found");
	});

	test("bounds rows and truncates long values", async () => {
		const rows = [
			{ id: 1, note: "x".repeat(10_000) },
			{ id: 2, note: "short" },
			{ id: 3, note: "short" },
		];
		const { json } = await post(
			dbDeps({ sql: sqlPort({ calls: [], rows }) }),
			AGENT_DB_QUERY_PATH,
			{ infra: "orders-db", sql: "SELECT 1", limit: 2 },
		);
		const value = valueIn(json);
		expect(value.rowCount).toBe(2);
		expect(value.truncated).toBe(true);
		const first = (value.rows as Array<Record<string, string>>)[0];
		expect((first?.note ?? "").length).toBeLessThanOrEqual(MAX_VALUE_CHARS + 1);
	});
});

// ---------------------------------------------------------------------------
// http_request
// ---------------------------------------------------------------------------

describe("http_request", () => {
	test("calls a held app's endpoint and redacts credentials", async () => {
		const seen: Array<{ url: string; method: string; body?: string }> = [];
		const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen.push({
				url: String(input),
				method: init?.method ?? "GET",
				...(init?.body === undefined ? {} : { body: String(init.body) }),
			});
			return new Response(
				JSON.stringify({ ok: true, secret: "hunter2-secret" }),
				{
					status: 201,
					headers: {
						"content-type": "application/json",
						"set-cookie": "session=abc",
						authorization: "Bearer token",
					},
				},
			);
		}) as unknown as typeof fetch;
		const touched: string[] = [];
		const { status, json } = await post(
			dbDeps({
				send,
				instances: instancesDouble(
					[
						{
							app: "shop",
							holder: OWNER,
							endpoints: { api: "http://127.0.0.1:8080" },
						},
					],
					touched,
				),
			}),
			AGENT_HTTP_REQUEST_PATH,
			{
				app: "shop",
				endpoint: "api",
				method: "POST",
				path: "/orders?limit=5",
				headers: [{ name: "accept", value: "application/json" }],
				body: '{"paid":true}',
			},
		);
		expect(status).toBe(200);
		expect(seen).toEqual([
			{
				url: "http://127.0.0.1:8080/orders?limit=5",
				method: "POST",
				body: '{"paid":true}',
			},
		]);
		const value = valueIn(json);
		expect(value).toMatchObject({ status: 201, truncated: false });
		expect(value.headers).toMatchObject({
			"set-cookie": "«redacted:set-cookie»",
			authorization: "«redacted:authorization»",
			"content-type": "application/json",
		});
		expect(touched).toEqual([`${OWNER}:shop`]);
	});

	test("refuses an app another workflow holds, naming the holder", async () => {
		const { status, json } = await post(
			dbDeps({
				instances: instancesDouble([
					{ app: "shop", holder: "workflow:other", endpoints: {} },
				]),
			}),
			AGENT_HTTP_REQUEST_PATH,
			{ app: "shop", endpoint: "api" },
		);
		expect(status).toBe(409);
		expect(errorOf(json).code).toBe("app-not-held");
		expect(errorOf(json).message).toContain("workflow:other");
	});

	test("refuses an unknown endpoint, a path leaving the origin and a huge body", async () => {
		const deps = dbDeps({});
		const endpoint = await post(deps, AGENT_HTTP_REQUEST_PATH, {
			app: "shop",
			endpoint: "grpc",
		});
		expect(endpoint.status).toBe(404);
		expect(errorOf(endpoint.json).code).toBe("endpoint-unknown");
		expect(errorOf(endpoint.json).message).toContain("api");
		const escaped = await post(deps, AGENT_HTTP_REQUEST_PATH, {
			app: "shop",
			endpoint: "api",
			path: "//elsewhere.example.com/steal",
		});
		expect(escaped.status).toBe(400);
		expect(errorOf(escaped.json).code).toBe("invalid-path");
		const huge = await post(deps, AGENT_HTTP_REQUEST_PATH, {
			app: "shop",
			endpoint: "api",
			method: "POST",
			body: "x".repeat(70_000),
		});
		expect(huge.status).toBe(400);
	});

	test("stops reading a response at the cap and applies the environment redactor", async () => {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "debug-config-"));
		fs.writeFileSync(
			path.join(configDir, ".env"),
			"ORDERS_DB_PASSWORD=hunter2-secret\n",
		);
		const send = (async () =>
			new Response(`${"y".repeat(80_000)}hunter2-secret`, {
				status: 200,
			})) as unknown as typeof fetch;
		const { json } = await post(
			dbDeps({ send, configDir }),
			AGENT_HTTP_REQUEST_PATH,
			{ app: "shop", endpoint: "api", path: "/big" },
		);
		const value = valueIn(json);
		expect(value.truncated).toBe(true);
		expect(value.bytes).toBe(64 * 1024);
		expect(String(value.body)).not.toContain("hunter2-secret");
	});
});

describe("the debug route surface", () => {
	test("claims only its own paths and answers POST only", async () => {
		const other = await handleDebugRoute(
			{},
			new Request(`http://127.0.0.1${AGENT_LIST_PATH}`),
			urlFor(AGENT_LIST_PATH),
			OWNER,
		);
		expect(other).toBeUndefined();
		const response = await handleDebugRoute(
			{},
			new Request(`http://127.0.0.1${AGENT_OTEL_QUERY_PATH}`, {
				method: "GET",
			}),
			urlFor(AGENT_OTEL_QUERY_PATH),
			OWNER,
		);
		expect(response?.status).toBe(405);
	});

	test("an unheld-owner query answers with that owner's own traces only", async () => {
		const index = new TraceIndex();
		index.push(requestTrace({ traceId: "t1", owner: OWNER, run: "grant-1" }));
		const { json } = await post(
			{ traceIndex: index },
			AGENT_OTEL_QUERY_PATH,
			{},
			"workflow:someone-else",
		);
		expect(valueIn(json).traces).toEqual([]);
	});
});

// The one attribute name attribution is read from, asserted here rather than
// repeated as a literal in every test.
describe("trace attribution", () => {
	test("indexes by the resource attribute the run wiring writes", () => {
		expect(AC_OWNER_ATTRIBUTE).toBe("ac.owner");
	});
});

describe("readOnlyStatements", () => {
	test("always rolls a read-only transaction back", async () => {
		const calls: SqlCall[] = [];
		await runReadOnlyQuery(
			sqlPort({ calls }),
			{
				kind: "postgres",
				host: "127.0.0.1",
				port: 5432,
				database: "orders",
				user: "u",
				password: "p",
			} satisfies DbQueryConnection,
			{ sql: "SELECT 1" },
		);
		expect(calls[calls.length - 1]?.statement).toBe("ROLLBACK");
	});
});

// `fix-otel-query-and-debug-worktree`, defect 1a: a request trace the list
// showed could not be resolved as a span tree seconds later, because the index
// evicted strictly by insertion order — a backend that polls twice a second
// rolls the 200-trace window over in about a hundred seconds and took the one
// trace the caller cared about with it.
describe("otel_query keeps a request trace while a poller rolls the window over", () => {
	const base = Date.parse("2026-01-01T00:00:00.000Z");

	/** The poller's traffic: one span per query, more traces than the index
	 * retains. */
	function poll(index: TraceIndex, count: number, fromMs: number): void {
		for (let i = 0; i < count; i += 1) {
			index.push([
				span({
					traceId: `poll-${String(i).padStart(4, "0")}`,
					spanId: `poll-${i}-1`,
					name: "SELECT 1",
					owner: OWNER,
					startMs: fromMs + i,
					kind: 1,
				}),
			]);
		}
	}

	test("the oldest poller trace is evicted before the request trace", async () => {
		const index = new TraceIndex();
		index.push(requestTrace({ traceId: "req-1", owner: OWNER, startMs: base }));
		poll(index, MAX_INDEXED_TRACES + 40, base + 1_000);
		// The window rolled over...
		expect(index.size(OWNER)).toBe(MAX_INDEXED_TRACES);
		expect(index.evictedTrace(OWNER, "poll-0000")).toBe(true);
		// ... and the request trace is still listable and still resolvable.
		expect(index.evictedTrace(OWNER, "req-1")).toBe(false);
		const listed = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {});
		expect(listed.status).toBe(200);
		expect(valueIn(listed.json).indexTruncated).toBe(true);
		expect(
			(valueIn(listed.json).traces as Array<{ traceId: string }>)[0],
		).toMatchObject({ traceId: "req-1", rootKind: "server" });
		const tree = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "req-1",
		});
		expect(tree.status).toBe(200);
		expect(valueIn(tree.json)).toMatchObject({ mode: "tree", spanCount: 2 });
	});

	test("an evicted trace answers trace-evicted, one never received answers trace-unknown", async () => {
		const index = new TraceIndex();
		index.push(
			requestTrace({ traceId: "req-old", owner: OWNER, startMs: base }),
		);
		// Enough *request-level* traces to push the oldest one out: background
		// traces go first, so this is what has to be flooded to lose a request.
		for (let i = 0; i <= MAX_INDEXED_TRACES; i += 1) {
			index.push(
				requestTrace({
					traceId: `req-new-${i}`,
					owner: OWNER,
					startMs: base + 1_000 + i,
				}),
			);
		}
		expect(index.evictedTrace(OWNER, "req-old")).toBe(true);
		const evicted = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "req-old",
		});
		expect(evicted.status).toBe(410);
		expect(errorOf(evicted.json).code).toBe("trace-evicted");
		expect(errorOf(evicted.json).message).toContain("evicted");
		// An id this workflow's runs never exported is a different finding, and it
		// is the only one a re-run can fix.
		const unknown = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "req-never-exported",
		});
		expect(unknown.status).toBe(404);
		expect(errorOf(unknown.json).code).toBe("trace-unknown");
	});

	test("a span-tree lookup finds a trace whose id arrives in another case", async () => {
		const index = new TraceIndex();
		index.push(
			requestTrace({ traceId: "abcdef0123", owner: OWNER, startMs: base }),
		);
		const tree = await post({ traceIndex: index }, AGENT_OTEL_QUERY_PATH, {
			traceId: "ABCDEF0123",
		});
		expect(tree.status).toBe(200);
		expect(valueIn(tree.json).traceId).toBe("abcdef0123");
	});
});

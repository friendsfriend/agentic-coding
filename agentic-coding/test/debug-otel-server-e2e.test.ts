// `otel_query` through the real composition root, with synthetic spans
// (`fix-otel-query-and-debug-worktree`).
//
// The defects this file pins were found by an end-to-end retest against a real
// server, so the evidence here is produced the same way: `startWorkflowServer`
// owns the OTLP receiver and the debug route, the spans arrive as a real
// `POST /v1/traces` export carrying the resource attributes the run wiring
// writes, and the query is a real `otel_query` tool call over HTTP with the
// workflow's own capability. Nothing here injects a fake of the index, the
// route or the receiver.
//
// It reproduces, in order:
//   1a. a request trace that the list shows and a poller's traces then roll out
//       of the retained 200-trace window — the span tree must still answer, and
//       a trace that is evicted anyway must answer `trace-evicted`, not
//       `trace-unknown`;
//   1b. the `http` filter for a route that exists, in both forms the developer
//       tried, and the per-filter counts that explain `matched: 0`;
//   1c. the tool surface itself (the answer and the refusal the model sees).
import { describe, expect, test } from "bun:test";
import { createDebugExtension } from "../src/agent-host/debug-tools.ts";
import {
	ENVIRONMENT_OWNER_HEADER,
	ENVIRONMENT_TOKEN_ENV,
	ENVIRONMENT_URL_ENV,
	environmentOwnerFor,
} from "../src/agent-host/environment-capability.ts";
import { environmentTokenFor } from "../src/server/auth.ts";
import type { EnvironmentOwner } from "../src/server/environment/instances/model.ts";
import { resolveInstanceVariables } from "../src/server/environment/instances/variables.ts";
import { startWorkflowServer } from "../src/server/lifecycle.ts";
import { AGENT_OTEL_QUERY_PATH } from "../src/server/protocol.ts";
import type { SignalRouter } from "../src/server/receivers/index.ts";

const WORKFLOW_ID = "wf-otel-e2e";
const OWNER: EnvironmentOwner = environmentOwnerFor(
	WORKFLOW_ID,
) as EnvironmentOwner;
const APP = "grid-allocation-api";
const GRANT = "grant-e2e";
/** The route the developer's retest used, with the attributes a real
 * ASP.NET-style server span carries. */
const ROUTE = "/grid-allocation-api/v1/requests";
const REQUEST_NAME = `POST ${ROUTE}`;

/** A free loopback port, discovered by binding one and letting it go. */
function freePort(): number {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

function hex(value: number, width: number): string {
	return value.toString(16).padStart(width, "0");
}

interface SyntheticSpan {
	readonly traceId: string;
	readonly spanId: string;
	readonly parentSpanId?: string;
	readonly name: string;
	/** The OTLP span kind: 2 is `server` (an inbound request), 1 internal. */
	readonly kind: number;
	readonly attributes?: Record<string, string>;
	readonly startNanos: bigint;
	readonly endNanos: bigint;
}

let nextSpan = 1;

/** One span whose ids and timestamps are unique, so a synthetic batch is a valid
 * export the receiver accepts without a second thought. */
function spanOf(input: {
	traceId: string;
	name: string;
	kind: number;
	parentSpanId?: string;
	attributes?: Record<string, string>;
	startNanos: bigint;
	durationMs?: number;
	spanId?: string;
}): SyntheticSpan {
	const span: SyntheticSpan = {
		traceId: input.traceId,
		spanId: input.spanId ?? hex(nextSpan++, 16),
		...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
		name: input.name,
		kind: input.kind,
		...(input.attributes ? { attributes: input.attributes } : {}),
		startNanos: input.startNanos,
		endNanos: input.startNanos + BigInt((input.durationMs ?? 1) * 1_000_000),
	};
	return span;
}

/** The OTLP/JSON an exporter sends, with the resource attributes the run's own
 * variables carry (so `ac.owner`, `ac.app` and `ac.run` are the real ones). */
function otlpBody(
	spans: readonly SyntheticSpan[],
	resourceAttributes: string,
): string {
	const resource = resourceAttributes
		.split(",")
		.map((pair) => pair.split("="))
		.filter((pair) => pair.length === 2)
		.map(([key, value]) => ({ key, value: { stringValue: value } }));
	return JSON.stringify({
		resourceSpans: [
			{
				resource: { attributes: resource },
				scopeSpans: [
					{
						scope: { name: "e2e" },
						spans: spans.map((span) => ({
							traceId: span.traceId,
							spanId: span.spanId,
							...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
							name: span.name,
							kind: span.kind,
							startTimeUnixNano: span.startNanos.toString(),
							endTimeUnixNano: span.endNanos.toString(),
							status: { code: 1 },
							attributes: Object.entries(span.attributes ?? {}).map(
								([key, value]) => ({ key, value: { stringValue: value } }),
							),
						})),
					},
				],
			},
		],
	});
}

interface Executable {
	execute(
		args: unknown,
		api: unknown,
		context: unknown,
	): Promise<{
		output: Array<{ type: string; text: string }>;
		isError?: boolean;
	}>;
}

/** One `otel_query` tool call against the running server: the real tool, the
 * real HTTP route, the real capability. */
async function otelQuery(
	url: string,
	token: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const env: Record<string, string> = {
		HERDR_WORKFLOW_ID: WORKFLOW_ID,
		[ENVIRONMENT_URL_ENV]: url,
		[ENVIRONMENT_TOKEN_ENV]: token,
	};
	const extension = createDebugExtension(() => ({
		runId: "run-e2e",
		cwd: process.cwd(),
		env,
		toolPolicy: "default",
	}));
	const tool = (extension.tools ?? []).find(
		(entry) => entry.name === "otel_query",
	) as unknown as Executable | undefined;
	if (!tool) throw new Error("the debug extension offers no otel_query");
	const result = await tool.execute(args, {}, {});
	return {
		text: result.output.map((block) => block.text).join(""),
		isError: result.isError === true,
	};
}

function parseValue(text: string): Record<string, unknown> {
	const parsed = JSON.parse(text) as Record<string, unknown>;
	return parsed;
}

describe("otel_query against the real server", () => {
	test("lists a request trace, resolves its span tree after the poller rolls the window over, filters by HTTP route and explains an empty match", async () => {
		const receiverPort = freePort();
		const server = await startWorkflowServer({
			port: 0,
			receivers: { httpPort: receiverPort },
			// The sink the shell would own; the index is fed by the server's own
			// receiver wrapper in `lifecycle.ts`, exactly as in production.
			signalSink: {
				pushTraces: () => {},
				pushMetrics: () => {},
				pushLogs: () => {},
			} satisfies SignalRouter,
		});
		const token = environmentTokenFor(server.token, OWNER);
		const resourceAttributes =
			resolveInstanceVariables({
				owner: OWNER,
				appDir: "/tmp/checkout",
				app: APP,
				runtime: "script",
				grantId: GRANT,
				receiver: { httpPort: receiverPort },
			}).OTEL_RESOURCE_ATTRIBUTES ?? "";
		expect(resourceAttributes).toContain(`ac.owner=${OWNER}`);
		const exportSpans = async (
			spans: readonly SyntheticSpan[],
		): Promise<void> => {
			const response = await fetch(
				`http://127.0.0.1:${receiverPort}/v1/traces`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: otlpBody(spans, resourceAttributes),
				},
			);
			expect(response.status).toBe(200);
		};
		try {
			// The request trace: a `server` root naming the route, with the
			// attributes a real server span carries, plus 32 child spans.
			const requestTrace = hex(0x4bf92f, 32);
			const requestStart = 1_767_225_600_000_000_000n;
			const root = spanOf({
				traceId: requestTrace,
				spanId: "00f067aa0ba902b7",
				name: REQUEST_NAME,
				kind: 2,
				startNanos: requestStart,
				durationMs: 125,
				attributes: {
					"http.request.method": "POST",
					"http.route": ROUTE,
					"http.response.status_code": "201",
				},
			});
			const children = Array.from({ length: 32 }, (_, index) =>
				spanOf({
					traceId: requestTrace,
					parentSpanId: root.spanId,
					name: "db.query",
					kind: 3,
					startNanos: requestStart + BigInt(index + 1) * 1_000_000n,
					durationMs: 2,
				}),
			);
			await exportSpans([root, ...children]);

			// The poller: one span per export group, twice a second in production.
			// 240 of them is more than the 200-trace window the index retains.
			let pollerClock = requestStart;
			let poller = 0;
			const exportPollers = async (count: number): Promise<void> => {
				const batch: SyntheticSpan[] = [];
				for (let index = 0; index < count; index += 1) {
					pollerClock += 500_000_000n;
					batch.push(
						spanOf({
							traceId: hex(0x700000 + poller, 32),
							name: "SELECT 1",
							kind: 1,
							startNanos: pollerClock,
						}),
					);
					poller += 1;
				}
				await exportSpans(batch);
			};

			// The list the developer saw: the request trace first, with app/run
			// attribution and the root span's kind.
			const listed = parseValue(
				(await otelQuery(server.url, token, {})).text,
			) as {
				mode: string;
				traces: Array<Record<string, unknown>>;
				matched: number;
				considered: number;
			};
			expect(listed.mode).toBe("list");
			expect(listed.traces[0]).toMatchObject({
				traceId: requestTrace,
				root: REQUEST_NAME,
				rootKind: "server",
				app: APP,
				run: GRANT,
				spanCount: 33,
			});
			// The span tree of that exact id, seconds later in production.
			const tree = parseValue(
				(await otelQuery(server.url, token, { traceId: requestTrace })).text,
			) as {
				mode: string;
				spanCount: number;
				spans: Array<Record<string, unknown>>;
			};
			expect(tree.mode).toBe("tree");
			expect(tree.spanCount).toBe(33);
			expect(tree.spans[0]).toMatchObject({
				name: REQUEST_NAME,
				attributes: {
					"http.request.method": "POST",
					"http.route": ROUTE,
					"http.response.status_code": "201",
				},
			});

			// The poller rolls the window over: 240 single-span traces against a
			// 200-trace bound. Insertion-order eviction dropped the request trace
			// here; priority eviction keeps it (and it is not background noise).
			await exportPollers(120);
			await exportPollers(120);
			const afterFlood = parseValue(
				(await otelQuery(server.url, token, {})).text,
			) as { traces: Array<Record<string, unknown>>; indexTruncated: boolean };
			expect(afterFlood.indexTruncated).toBe(true);
			expect(
				afterFlood.traces.some((row) => row.traceId === requestTrace),
			).toBe(true);
			const treeAfterFlood = await otelQuery(server.url, token, {
				traceId: requestTrace,
			});
			expect(treeAfterFlood.isError).toBe(false);
			expect(JSON.parse(treeAfterFlood.text).spanCount).toBe(33);

			// 1b: the `http` filter, in both forms the developer tried.
			for (const http of [ROUTE, REQUEST_NAME]) {
				const filtered = parseValue(
					(
						await otelQuery(server.url, token, {
							http,
							minSpans: 1,
							includeNoise: true,
						})
					).text,
				) as { matched: number; traces: Array<Record<string, unknown>> };
				expect(filtered.matched).toBeGreaterThanOrEqual(1);
				expect(filtered.traces[0]?.traceId).toBe(requestTrace);
			}
			// A case difference is not a miss either: the filter is
			// case-insensitive.
			const caseInsensitive = parseValue(
				(
					await otelQuery(server.url, token, {
						http: ROUTE.toUpperCase(),
						includeNoise: true,
					})
				).text,
			) as { matched: number };
			expect(caseInsensitive.matched).toBeGreaterThanOrEqual(1);

			// 1b: a filter that matches nothing says what each filter removed.
			const empty = parseValue(
				(
					await otelQuery(server.url, token, {
						http: "/no-such-route",
						minSpans: 1,
						includeNoise: true,
					})
				).text,
			) as {
				matched: number;
				considered: number;
				filtered: Record<string, number>;
				notice: string;
			};
			expect(empty.matched).toBe(0);
			expect(empty.filtered.http).toBe(empty.considered);
			expect(empty.considered).toBeGreaterThanOrEqual(200);
			expect(empty.notice).toContain("http");

			// A trace the index received and then dropped answers `trace-evicted`;
			// an id no run of this workflow exported answers `trace-unknown`. The
			// two are different findings.
			const neverExported = await otelQuery(server.url, token, {
				traceId: hex(0xabcdef, 32),
			});
			expect(neverExported.isError).toBe(true);
			expect(neverExported.text).toContain("[trace-unknown]");

			// Enough request-level traces to evict the first one: background
			// traces go first, so this needs more than the poller's share.
			let requestFlood = 0x900000;
			for (let batch = 0; batch < 12; batch += 1) {
				const spans: SyntheticSpan[] = [];
				for (let index = 0; index < 20; index += 1) {
					const traceId = hex(requestFlood, 32);
					requestFlood += 1;
					const start = requestStart + BigInt(requestFlood) * 1_000_000_000n;
					const parent = spanOf({
						traceId,
						name: `GET /flood/${requestFlood}`,
						kind: 2,
						startNanos: start,
					});
					spans.push(
						parent,
						spanOf({
							traceId,
							parentSpanId: parent.spanId,
							name: "db.query",
							kind: 3,
							startNanos: start + 1_000_000n,
						}),
					);
				}
				await exportSpans(spans);
			}
			const evicted = await otelQuery(server.url, token, {
				traceId: requestTrace,
			});
			expect(evicted.isError).toBe(true);
			expect(evicted.text).toContain("[trace-evicted]");
			expect(evicted.text).toContain("evicted");
		} finally {
			await server.stop();
		}
	}, 120_000);

	test("a case-different trace id still resolves, and the route it claims is the only one answered", async () => {
		const receiverPort = freePort();
		const server = await startWorkflowServer({
			port: 0,
			receivers: { httpPort: receiverPort },
			signalSink: {
				pushTraces: () => {},
				pushMetrics: () => {},
				pushLogs: () => {},
			} satisfies SignalRouter,
		});
		const token = environmentTokenFor(server.token, OWNER);
		const resourceAttributes =
			resolveInstanceVariables({
				owner: OWNER,
				appDir: "/tmp/checkout",
				app: APP,
				runtime: "script",
				grantId: GRANT,
				receiver: { httpPort: receiverPort },
			}).OTEL_RESOURCE_ATTRIBUTES ?? "";
		try {
			const traceId = hex(0xabc123, 32);
			const span = spanOf({
				traceId: traceId.toUpperCase(),
				name: "GET /orders",
				kind: 2,
				startNanos: 1_767_225_600_000_000_000n,
			});
			const response = await fetch(
				`http://127.0.0.1:${receiverPort}/v1/traces`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: otlpBody([span], resourceAttributes),
				},
			);
			expect(response.status).toBe(200);
			const tree = await otelQuery(server.url, token, { traceId });
			expect(tree.isError).toBe(false);
			expect(JSON.parse(tree.text).traceId).toBe(traceId);
			// The owner-scoped surface: the same route for another workflow's owner
			// is a capability this token does not hold.
			const other = await fetch(`${server.url}${AGENT_OTEL_QUERY_PATH}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					[ENVIRONMENT_OWNER_HEADER]: environmentOwnerFor("wf-somebody-else"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ traceId }),
			});
			expect(other.status).toBe(401);
		} finally {
			await server.stop();
		}
	}, 60_000);
});

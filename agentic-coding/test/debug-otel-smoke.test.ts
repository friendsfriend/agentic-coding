// A span an app exports through the run's OTel wiring, found again by
// `otel_query` (`add-agent-debug-tools`, tasks 1.1/2.1 and the opt-in smoke 3.1).
//
// The always-run test drives the receiver's own router (the OTLP HTTP export an
// app sends) and then asks the debug route for the trace, so the wiring the run
// receives, the receiver's decoding and the query are one checked path. The
// opt-in smoke does the same over a real loopback listener, with the endpoint
// the variables name:
//
//   DEVENV_SMOKE_DEBUG=1 bun test test/debug-otel-smoke.test.ts
import { describe, expect, test } from "bun:test";
import { handleDebugRoute } from "../src/server/debug/routes.ts";
import { TraceIndex } from "../src/server/debug/trace-index.ts";
import { resolveInstanceVariables } from "../src/server/environment/instances/variables.ts";
import { AGENT_OTEL_QUERY_PATH } from "../src/server/protocol.ts";
import type { SignalRouter } from "../src/server/receivers/index.ts";
import { routeReceiverRequest } from "../src/server/receivers/index.ts";
import { startTelemetryReceivers } from "../src/server/receivers.ts";

const ENABLED = process.env.DEVENV_SMOKE_DEBUG === "1";
const OWNER = "workflow:wf-smoke";
const APP = "customer-mw";

/** What an app's OTLP exporter sends: one export carrying the resource
 * attributes the run was given in `OTEL_RESOURCE_ATTRIBUTES`. */
function otlpExport(resourceAttributes: string): unknown {
	const resource = resourceAttributes
		.split(",")
		.map((pair) => pair.split("="))
		.filter((pair) => pair.length === 2)
		.map(([key, value]) => ({
			key,
			value: { stringValue: value },
		}));
	return {
		resourceSpans: [
			{
				resource: { attributes: resource },
				scopeSpans: [
					{
						scope: { name: "smoke" },
						spans: [
							{
								traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
								spanId: "00f067aa0ba902b7",
								name: "GET /orders",
								kind: 2,
								startTimeUnixNano: "1767225600000000000",
								endTimeUnixNano: "1767225600125000000",
								status: { code: 1 },
								attributes: [
									{ key: "http.method", value: { stringValue: "GET" } },
								],
							},
						],
					},
				],
			},
		],
	};
}

async function queryTraces(
	index: TraceIndex,
): Promise<Record<string, unknown>> {
	const response = await handleDebugRoute(
		{ traceIndex: index },
		new Request(`http://127.0.0.1${AGENT_OTEL_QUERY_PATH}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}),
		new URL(`http://127.0.0.1${AGENT_OTEL_QUERY_PATH}`),
		OWNER,
	);
	if (!response) throw new Error("the debug route did not claim its own path");
	const body = (await response.json()) as {
		value?: Record<string, unknown>;
		error?: { code?: string; message?: string };
	};
	if (response.status !== 200)
		throw new Error(`${response.status}: ${body.error?.message}`);
	return body.value ?? {};
}

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

test("a span exported with the run's OTLP variables is queryable by that workflow", async () => {
	const index = new TraceIndex();
	const sink: SignalRouter = {
		pushTraces: (spans) => {
			index.push(spans);
		},
		pushMetrics: () => {},
		pushLogs: () => {},
	};
	// A script run of this app: the variables are exactly what the instance
	// start injects, so the export carries the receiver's address and the
	// attribution attributes of this workflow's grant.
	const variables = resolveInstanceVariables({
		owner: OWNER,
		appDir: "/tmp/checkout",
		app: APP,
		runtime: "script",
		grantId: "grant-smoke",
		receiver: { httpPort: 4318 },
	});
	const response = await routeReceiverRequest(
		new Request("http://127.0.0.1/v1/traces", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(
				otlpExport(variables.OTEL_RESOURCE_ATTRIBUTES ?? ""),
			),
		}),
		sink,
	);
	expect(response?.status).toBe(200);
	const value = await queryTraces(index);
	expect(value.mode).toBe("list");
	expect(value.traces).toEqual([
		expect.objectContaining({
			traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
			root: "GET /orders",
			status: "ok",
			app: APP,
			run: "grant-smoke",
		}),
	]);
});

describe.skipIf(!ENABLED)("span export over the wire", () => {
	test("a real export reaches the receiver on the endpoint the variables name", async () => {
		const index = new TraceIndex();
		const port = freePort();
		const receivers = await startTelemetryReceivers(
			{ httpPort: port, binds: { hosts: ["127.0.0.1"] } },
			{
				pushTraces: (spans) => {
					index.push(spans);
				},
				pushMetrics: () => {},
				pushLogs: () => {},
			},
		);
		try {
			const variables = resolveInstanceVariables({
				owner: OWNER,
				appDir: "/tmp/checkout",
				app: APP,
				runtime: "script",
				grantId: "grant-smoke-wire",
				receiver: { httpPort: port },
			});
			const response = await fetch(
				`${variables.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(
						otlpExport(variables.OTEL_RESOURCE_ATTRIBUTES ?? ""),
					),
				},
			);
			expect(response.status).toBe(200);
			const value = await queryTraces(index);
			expect(value.traces).toEqual([
				expect.objectContaining({ app: APP, run: "grant-smoke-wire" }),
			]);
		} finally {
			await receivers.stop();
		}
	});
});

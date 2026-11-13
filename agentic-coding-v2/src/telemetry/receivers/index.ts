import type { LogData, MetricData, SpanData } from "../contracts.ts";
import {
	normalizeDatadogLogs,
	normalizeDatadogSpans,
	parseDatadogJson,
} from "./datadog.ts";
import { decodeDatadogSeries } from "./datadog-series.ts";
import { decodeOtlpLogs, decodeOtlpMetrics, decodeOtlpTraces } from "./otlp.ts";
import { normalizeZipkinSpans } from "./zipkin.ts";

export interface SignalRouter {
	pushTraces: (spans: SpanData[]) => void;
	pushMetrics: (metrics: MetricData[]) => void;
	pushLogs: (logs: LogData[]) => void;
}

// ---- HTTP request router for receiver endpoints ----

export function routeReceiverRequest(
	request: Request,
	router: SignalRouter,
): Response | Promise<Response> | null {
	const url = new URL(request.url);
	const path = url.pathname;

	// OTLP HTTP — existing path
	if (path === "/v1/traces" && request.method === "POST")
		return handleOtlpTraces(request, router);
	if (path === "/v1/metrics" && request.method === "POST")
		return handleOtlpMetrics(request, router);
	if (path === "/v1/logs" && request.method === "POST")
		return handleOtlpLogs(request, router);

	// Zipkin
	if (path === "/api/v2/spans" && request.method === "POST")
		return handleZipkin(request, router);

	// Datadog traces (multi-version)
	if (
		[
			"/v0.3/traces",
			"/v0.4/traces",
			"/v0.5/traces",
			"/api/v0.2/traces",
		].includes(path) &&
		request.method === "POST"
	)
		return handleDatadogTraces(request, router);
	// Datadog metrics
	if (
		["/api/v1/series", "/api/v2/series"].includes(path) &&
		request.method === "POST"
	)
		return handleDatadogSeries(request, router);
	// Datadog logs
	if (path === "/api/v2/logs" && request.method === "POST")
		return handleDatadogLogs(request, router);

	return null; // not a receiver route
}

// ---- OTLP handlers ----

async function body(request: Request): Promise<string> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	let size = 0;
	const chunks: ArrayBuffer[] = [];
	for (;;) {
		const next = await reader.read();
		if (next.done) return new Blob(chunks).text();
		size += next.value.byteLength;
		if (size > 5_000_000) throw new RangeError("payload too large");
		chunks.push(
			next.value.buffer.slice(
				next.value.byteOffset,
				next.value.byteOffset + next.value.byteLength,
			) as ArrayBuffer,
		);
	}
}

function otlpResponse() {
	return Response.json({ partialSuccess: {} });
}

function errorResponse(status: number, message: string) {
	return new Response(message, { status });
}

async function handleOtlpTraces(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	)
		return errorResponse(415, "OTLP HTTP JSON required");
	try {
		const spans = decodeOtlpTraces(JSON.parse(await body(request)));
		if (!spans.length) return errorResponse(400, "no valid spans");
		router.pushTraces(spans);
		return otlpResponse();
	} catch (e) {
		return errorResponse(
			e instanceof RangeError ? 413 : 400,
			"Invalid telemetry payload",
		);
	}
}

async function handleOtlpMetrics(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	)
		return errorResponse(415, "OTLP HTTP JSON required");
	try {
		const metrics = decodeOtlpMetrics(JSON.parse(await body(request)));
		if (!metrics.length) return errorResponse(400, "no valid metrics");
		router.pushMetrics(metrics);
		return otlpResponse();
	} catch (e) {
		return errorResponse(
			e instanceof RangeError ? 413 : 400,
			"Invalid telemetry payload",
		);
	}
}

async function handleOtlpLogs(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	if (
		!request.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	)
		return errorResponse(415, "OTLP HTTP JSON required");
	try {
		const logs = decodeOtlpLogs(JSON.parse(await body(request)));
		if (!logs.length) return errorResponse(400, "no valid logs");
		router.pushLogs(logs);
		return otlpResponse();
	} catch (e) {
		return errorResponse(
			e instanceof RangeError ? 413 : 400,
			"Invalid telemetry payload",
		);
	}
}

// ---- Zipkin ----

async function handleZipkin(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	try {
		const spans = normalizeZipkinSpans(JSON.parse(await body(request)));
		router.pushTraces(spans);
		return Response.json({});
	} catch {
		return errorResponse(400, "Invalid telemetry payload");
	}
}

// ---- Datadog ----

async function handleDatadogTraces(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	try {
		const spans = normalizeDatadogSpans(parseDatadogJson(await body(request)));
		router.pushTraces(spans);
		return Response.json({});
	} catch {
		return errorResponse(400, "Invalid telemetry payload");
	}
}

async function handleDatadogSeries(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	try {
		const metrics = decodeDatadogSeries(
			await body(request),
			new URL(request.url).pathname === "/api/v2/series" ? "v2" : "v1",
		);
		router.pushMetrics(metrics);
		return Response.json({});
	} catch {
		return errorResponse(400, "Invalid telemetry payload");
	}
}

async function handleDatadogLogs(
	request: Request,
	router: SignalRouter,
): Promise<Response> {
	try {
		const logs = normalizeDatadogLogs(parseDatadogJson(await body(request)));
		router.pushLogs(logs);
		return Response.json({});
	} catch {
		return errorResponse(400, "Invalid telemetry payload");
	}
}

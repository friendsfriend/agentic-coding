import type { LogData, SpanData } from "../contracts.ts";

// Preserve uint64 integer tokens before JSON number rounding. Bun supplies the
// reviver source context; absent that capability, unsafe identities are refused.
const integerFields = new Set([
	"trace_id",
	"span_id",
	"parent_id",
	"dd.trace_id",
	"dd.span_id",
	"start",
	"duration",
]);
export function parseDatadogJson(text: string): unknown {
	return JSON.parse(
		text,
		(key: string, value: unknown, context?: { source?: string }) =>
			typeof value === "number" &&
			!Number.isSafeInteger(value) &&
			integerFields.has(key) &&
			context?.source &&
			/^\d+$/.test(context.source)
				? context.source
				: value,
	);
}

// ---- Datadog Trace -> SpanData ----

interface DDTraceSpan {
	trace_id: number | string;
	span_id: number | string;
	parent_id?: number | string;
	name: string;
	service: string;
	resource?: string;
	start: number | string;
	duration?: number | string;
	error?: number;
	meta?: Record<string, string>;
}

function idToString(id: number | string): string {
	// JSON numbers cannot carry arbitrary uint64 identities losslessly.
	if (typeof id === "number" && (!Number.isSafeInteger(id) || id < 1))
		throw new Error("Unsafe Datadog identity");
	if (
		typeof id !== "number" &&
		(typeof id !== "string" || !/^\d{1,20}$/.test(id))
	)
		throw new Error("Invalid Datadog identity");
	const value = BigInt(id);
	if (value < 1n || value > 18446744073709551615n)
		throw new Error("Invalid Datadog identity");
	return value.toString(16).padStart(16, "0");
}
function traceId(value: number | string, high?: string): string {
	if (
		high !== undefined &&
		(typeof high !== "string" || !/^[a-f0-9]{16}$/i.test(high))
	)
		throw new Error("Invalid Datadog trace high word");
	return `${high?.toLowerCase() ?? "0000000000000000"}${idToString(value)}`;
}
function unlinked(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === 0 ||
		(typeof value === "string" && /^0+$/.test(value))
	);
}
function logSpanId(value: unknown): string | undefined {
	if (unlinked(value)) return undefined;
	if (typeof value !== "string" && typeof value !== "number")
		throw new Error("Invalid Datadog log identity");
	return idToString(value);
}
function logTraceId(value: unknown): string | undefined {
	if (unlinked(value)) return undefined;
	if (typeof value === "string" && /^[a-f0-9]{32}$/i.test(value))
		return value.toLowerCase();
	return logSpanId(value)?.padStart(32, "0");
}
function nanos(value: number | string): bigint {
	// Datadog trace start/duration are already nanoseconds. The HTTP parser
	// retains integer literals exactly; never invent low bits of unsafe numbers.
	if (
		typeof value === "number"
			? !Number.isSafeInteger(value) || value < 0
			: typeof value !== "string" || !/^\d{1,19}$/.test(value)
	)
		throw new Error("Invalid Datadog timestamp");
	const parsed = BigInt(value);
	if (parsed > 9223372036854775807n)
		throw new Error("Invalid Datadog timestamp");
	return parsed;
}

export function normalizeDatadogSpans(body: unknown): SpanData[] {
	// DD trace payload: [[{...}, ...], ...] — array of trace arrays
	if (!Array.isArray(body)) throw new Error("expected array of trace arrays");
	const spans: SpanData[] = [];
	for (const trace of body) {
		if (!Array.isArray(trace)) throw new Error("Invalid Datadog trace array");
		for (const raw of trace) {
			spans.push(normalizeDatadogSpan(raw));
		}
	}
	return spans;
}

function normalizeDatadogSpan(raw: DDTraceSpan): SpanData {
	const start = nanos(raw.start);
	const end = start + nanos(raw.duration ?? 0);
	const error = raw.error ?? 0;
	if (error !== 0 && error !== 1) throw new Error("Invalid Datadog error flag");
	const meta = raw.meta ?? {};

	return {
		traceId: traceId(raw.trace_id, meta["_dd.p.tid"]),
		spanId: idToString(raw.span_id),
		parentSpanId:
			raw.parent_id != null && raw.parent_id !== 0 && raw.parent_id !== "0"
				? idToString(raw.parent_id)
				: "",
		name: raw.name,
		startTimeUnixNano: start.toString(),
		endTimeUnixNano: end.toString(),
		status: {
			code: error ? 2 : 0,
			message: error ? (meta["error.msg"] ?? meta.error ?? "error") : undefined,
		},
		attributes: Object.entries(meta).map(([key, value]) => ({ key, value })),
		resource: {
			attributes: [{ key: "service.name", value: raw.service }],
			droppedAttributesCount: 0,
		},
		scope: { name: "datadog", version: "" },
		serviceName: raw.service,
		kind: 2,
	};
}

// ---- Datadog Logs -> LogData ----

interface DDLogEntry {
	message: string;
	status?: string;
	timestamp?: string | number;
	service?: string;
	dd?: { trace_id?: string; span_id?: string };
	[key: string]: unknown;
}

export function normalizeDatadogLogs(body: unknown): LogData[] {
	if (!Array.isArray(body)) throw new Error("expected array of log entries");
	return body.map(normalizeDatadogLog);
}

function normalizeDatadogLog(raw: DDLogEntry): LogData {
	const stamp = raw.timestamp ?? Date.now();
	const millis =
		typeof stamp === "number"
			? stamp
			: /^\d+$/.test(stamp)
				? Number(stamp)
				: Date.parse(stamp);
	if (!Number.isSafeInteger(millis) || millis < 0)
		throw new Error("Invalid Datadog log timestamp");
	const ts = (BigInt(millis) * 1_000_000n).toString();
	const severityMap: Record<string, string> = {
		emerg: "FATAL",
		fatal: "FATAL",
		error: "ERROR",
		critical: "ERROR",
		alert: "ERROR",
		crit: "ERROR",
		err: "ERROR",
		warning: "WARN",
		warn: "WARN",
		notice: "INFO",
		info: "INFO",
		debug: "DEBUG",
		trace: "TRACE",
	};
	const severity = severityMap[raw.status?.toLowerCase() ?? ""] ?? "INFO";
	const attrs = Object.entries(raw)
		.filter(
			([k]) => !["message", "status", "timestamp", "service", "dd"].includes(k),
		)
		.map(([k, v]) => ({ key: k, value: String(v) }));

	return {
		resource: {
			attributes: [{ key: "service.name", value: raw.service ?? "datadog" }],
		},
		scope: { name: "datadog", version: "" },
		timeUnixNano: ts,
		severity,
		body: raw.message ?? "",
		attributes: attrs,
		traceId: logTraceId(raw.dd?.trace_id ?? raw["dd.trace_id"]),
		spanId: logSpanId(raw.dd?.span_id ?? raw["dd.span_id"]),
		serviceName: raw.service ?? "datadog",
	};
}

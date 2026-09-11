import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The fixed telemetry export/shutdown flush budget (complete-workflow-
 * effect-cutover, task 2.4): OTLP/JSONL exports never keep the application
 * alive beyond this bound, and a failed export is observational — it can
 * never roll back or replay a committed command. */
export const TELEMETRY_FLUSH_BUDGET_MS = 750;

export interface TraceContext {
	traceId: string;
	spanId: string;
	flags: string;
}
/** One scalar telemetry attribute value. Numeric and boolean values stay
 * typed so consumers can sum and average without parsing (D4/D6). */
export type TelemetryScalar = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryScalar>;

/** The wire shape of one event in `.herdr-workflow/<id>/telemetry.jsonl` and in
 * the OTLP/JSON logs export. Enriched payload fields travel at the envelope top
 * level (D5); the parser maps every non-reserved scalar key to a span
 * attribute, so a new field appears in the viewer without a parser change. */
export interface TelemetryEnvelope {
	schemaVersion: 1;
	at: string;
	layer: "engine" | "adapter" | "runtime";
	event: string;
	outcome?: "ok" | "error";
	durationMs?: number;
	workflowId: string;
	runId?: string;
	stepId?: string;
	role?: string;
	profile?: string;
	runtime?: string;
	sessionId?: string;
	messageId?: string;
	effectId?: string;
	traceparent?: string;
	/** Optional enriched payload fields used by the engine and runtime bridges;
	 * runtime-specific keys keep their own vocabulary (D4). */
	attempt?: number;
	tool?: string;
	model?: string;
	provider?: string;
	tokens?: number;
	cost?: number;
	attributes?: TelemetryAttributes;
	[key: string]: TelemetryScalar | TelemetryAttributes | undefined;
}

/** Input shared by the engine, adapter, and (documented) bridge envelope
 * builders. `payload` keys are copied to the envelope top level after the
 * bounded/content filter is applied. */
export interface TelemetryEventInput {
	layer: "engine" | "adapter" | "runtime";
	event: string;
	at: string;
	workflowId: string;
	runId?: string;
	stepId?: string;
	role?: string;
	profile?: string;
	runtime?: string;
	sessionId?: string;
	messageId?: string;
	effectId?: string;
	outcome?: "ok" | "error";
	durationMs?: number;
	traceparent?: string;
	attributes?: TelemetryAttributes;
	payload?: Record<string, unknown>;
	captureContent?: boolean;
}

/** Build one enriched envelope, applying the bounded attribute helper to the
 * top-level payload. Never throws for a scalar payload. */
export function telemetryEnvelope(
	input: TelemetryEventInput,
): TelemetryEnvelope {
	const { payload, captureContent, ...identity } = input;
	return {
		schemaVersion: 1,
		...identity,
		...(payload ? boundedTelemetryPayload(payload, captureContent) : {}),
	} as TelemetryEnvelope;
}

/** Adapter-layer input: the effect runner resolves identity from the run and
 * workflow snapshot and emits through the same bounded sink. */
export interface AdapterTelemetryInput {
	event: string;
	at: string;
	workflowId: string;
	runId?: string;
	stepId?: string;
	role?: string;
	profile?: string;
	runtime?: string;
	sessionId?: string;
	effectId?: string;
	outcome?: "ok" | "error";
	durationMs?: number;
	traceparent?: string;
	payload?: Record<string, unknown>;
	captureContent?: boolean;
}

export function adapterTelemetryEnvelope(
	input: AdapterTelemetryInput,
): TelemetryEnvelope {
	return telemetryEnvelope({ ...input, layer: "adapter" });
}
export function parseTraceparent(value?: string): TraceContext | undefined {
	const match = value?.match(
		/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i,
	);
	return match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])
		? { traceId: match[1], spanId: match[2], flags: match[3] }
		: undefined;
}
export function childTrace(parent?: TraceContext): TraceContext {
	return {
		traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
		spanId: randomBytes(8).toString("hex"),
		flags: parent?.flags ?? "01",
	};
}
export function traceparent(context: TraceContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}
export class TelemetrySink {
	constructor(
		private readonly directory: string,
		private readonly exportUrl?: string,
	) {}
	emit(envelope: TelemetryEnvelope): void {
		try {
			fs.mkdirSync(this.directory, { recursive: true });
			fs.appendFileSync(
				path.join(this.directory, "telemetry.jsonl"),
				`${JSON.stringify(envelope)}\n`,
			);
		} catch {
			/* observational */
		}
		if (this.exportUrl)
			void fetch(this.exportUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(envelope),
				signal: AbortSignal.timeout(TELEMETRY_FLUSH_BUDGET_MS),
			}).catch(() => undefined);
	}
}
/** One bounded attribute limit shared by every emitter: long strings are
 * truncated, numbers and booleans are preserved as scalars, and unknown value
 * types are dropped rather than stringified. */
export const TELEMETRY_ATTRIBUTE_LIMIT = 8192;

/** Bounded, content-free payload for envelope top-level fields or the named
 * `attributes` object. Any key containing `content` is dropped unless content
 * capture is explicitly enabled; there is no other content path. */
export function boundedTelemetryPayload(
	value: Record<string, unknown>,
	captureContent = false,
): TelemetryAttributes {
	const result: TelemetryAttributes = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined || item === null) continue;
		if (!captureContent && key.toLowerCase().includes("content")) continue;
		if (typeof item === "string")
			result[key] = item.slice(0, TELEMETRY_ATTRIBUTE_LIMIT);
		else if (typeof item === "number" || typeof item === "boolean")
			result[key] = item;
	}
	return result;
}

/** Credential shapes redacted from any telemetry string, mirroring the runtime
 * bridges so engine error classes never export secrets (SEC-002). */
export const TELEMETRY_SECRET_PATTERN =
	/(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;

/** Redact known credential shapes before a value is exported to telemetry. */
export function redactTelemetryText(value: string): string {
	return value.replace(TELEMETRY_SECRET_PATTERN, "[REDACTED]");
}

/** Backwards-compatible alias for the bounded payload helper. */
export function boundedRuntimeAttributes(
	value: Record<string, unknown>,
	captureContent = false,
): TelemetryAttributes {
	return boundedTelemetryPayload(value, captureContent);
}

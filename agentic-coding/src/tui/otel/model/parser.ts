import { createHash } from "node:crypto";
import type { SpanData } from "./types";

const id = (value: unknown, size: number) =>
	typeof value === "string" &&
	/^[0-9a-f]+$/i.test(value) &&
	value.length === size;
const nanos = (value: unknown) =>
	typeof value === "string" && /^\d+$/.test(value);
type OtlpAttributeValue = {
	stringValue?: unknown;
	boolValue?: unknown;
	intValue?: unknown;
	doubleValue?: unknown;
};

const attrValue = (
	item: OtlpAttributeValue | undefined,
): string | number | boolean | undefined =>
	typeof item?.stringValue === "string"
		? item.stringValue
		: typeof item?.boolValue === "boolean"
			? item.boolValue
			: item?.intValue !== undefined
				? Number(item.intValue)
				: typeof item?.doubleValue === "number"
					? item.doubleValue
					: undefined;

function normalizeAttrs(
	attrs: unknown,
): Array<{ key: string; value: string | number | boolean }> {
	if (Array.isArray(attrs))
		return attrs.map((a) => ({
			key: String(a.key ?? ""),
			value: attrValue(a.value) ?? "",
		}));
	if (attrs && typeof attrs === "object")
		return Object.entries(attrs as Record<string, unknown>).map(([k, v]) => ({
			key: k,
			value:
				typeof v === "string" || typeof v === "number" || typeof v === "boolean"
					? v
					: String(v),
		}));
	return [];
}

export function parseLine(line: string): SpanData | undefined {
	try {
		const raw = JSON.parse(line);
		if (
			!raw ||
			!id(raw.traceId, 32) ||
			!id(raw.spanId, 16) ||
			typeof raw.name !== "string" ||
			!nanos(raw.startTimeUnixNano) ||
			!nanos(raw.endTimeUnixNano)
		)
			return undefined;
		const status =
			typeof raw.status === "object" && raw.status !== null
				? {
						code: Number(raw.status.code ?? 0),
						message: raw.status.message ?? undefined,
					}
				: { code: raw.status === "ERROR" ? 2 : raw.status === "OK" ? 0 : 0 };
		const attributes = normalizeAttrs(raw.attributes ?? []);
		const resourceAttributes = normalizeAttrs(raw.resource?.attributes ?? []);
		const serviceName = String(
			attributes.find((attribute) => attribute.key === "service.name")?.value ??
				resourceAttributes.find((attribute) => attribute.key === "service.name")
					?.value ??
				"unknown",
		);
		return {
			traceId: raw.traceId.toLowerCase(),
			spanId: raw.spanId.toLowerCase(),
			parentSpanId: id(raw.parentSpanId, 16)
				? String(raw.parentSpanId).toLowerCase()
				: "",
			name: raw.name,
			startTimeUnixNano: raw.startTimeUnixNano,
			endTimeUnixNano: raw.endTimeUnixNano,
			status,
			attributes,
			resource: {
				attributes: resourceAttributes,
				droppedAttributesCount: Number(
					raw.resource?.droppedAttributesCount ?? 0,
				),
			},
			scope: { name: raw.scope?.name ?? "", version: raw.scope?.version ?? "" },
			serviceName,
			kind: Number(raw.kind ?? 0),
		};
	} catch {
		return undefined;
	}
}

export function parseJsonl(text: string): SpanData[] {
	const spans: SpanData[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const span = parseLine(line);
		if (span) spans.push(span);
	}
	return spans;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

const digest = (text: string, size: number): string =>
	createHash("sha256").update(text).digest("hex").slice(0, size);

/** Convert one workflow telemetry envelope (`.herdr-workflow/<id>/telemetry.jsonl`,
 * see `workflow/observability.ts`) into the span shape the trace views render.
 * Envelopes are point events, so a span covers `durationMs` (when reported)
 * ending at `at`; `traceparent` supplies the trace identity and `workflowId`
 * becomes `herdr.change.id`, which is what groups spans by workflow. */
export function parseTelemetryLine(
	line: string,
	index = 0,
): SpanData | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const envelope = raw as Record<string, unknown>;
	const event = typeof envelope.event === "string" ? envelope.event : undefined;
	const workflowId =
		typeof envelope.workflowId === "string" ? envelope.workflowId : undefined;
	const at =
		typeof envelope.at === "string" ? Date.parse(envelope.at) : Number.NaN;
	if (!event || !Number.isFinite(at)) return undefined;
	const layer = typeof envelope.layer === "string" ? envelope.layer : "engine";
	const traceparent =
		typeof envelope.traceparent === "string"
			? TRACEPARENT.exec(envelope.traceparent)
			: null;
	// All events of one runtime run share the run's traceparent span id, so the
	// span id must come from the envelope itself to stay unique per event.
	const traceId = traceparent
		? traceparent[1]?.toLowerCase()
		: digest(`workflow:${workflowId ?? "unknown"}`, 32);
	const spanId = digest(`${index}:${line}`, 16);
	const durationMs =
		typeof envelope.durationMs === "number" && envelope.durationMs > 0
			? envelope.durationMs
			: 0;
	const attributes: Array<{
		key: string;
		value: string | number | boolean;
	}> = [];
	if (workflowId)
		attributes.push({ key: "herdr.change.id", value: workflowId });
	const stringFields: Array<[string, unknown]> = [
		["herdr.role", envelope.role],
		["herdr.run.id", envelope.runId],
		["herdr.step.id", envelope.stepId],
		["herdr.effect.id", envelope.effectId],
		["herdr.profile", envelope.profile],
		["herdr.message.id", envelope.messageId],
		["herdr.outcome", envelope.outcome],
	];
	for (const [key, value] of stringFields)
		if (typeof value === "string" && value) attributes.push({ key, value });
	if (envelope.attributes && typeof envelope.attributes === "object")
		for (const [key, value] of Object.entries(
			envelope.attributes as Record<string, unknown>,
		))
			if (
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean"
			)
				attributes.push({ key, value });
	const runtime =
		typeof envelope.runtime === "string" ? envelope.runtime : undefined;
	const serviceName =
		layer === "engine" ? "herdr-workflow" : (runtime ?? layer);
	return {
		traceId,
		spanId,
		parentSpanId: "",
		name: event,
		startTimeUnixNano: (
			BigInt(Math.round(at - durationMs)) * 1_000_000n
		).toString(),
		endTimeUnixNano: (BigInt(Math.round(at)) * 1_000_000n).toString(),
		status: {
			code: envelope.outcome === "error" ? 2 : 0,
			message: envelope.outcome === "error" ? "error" : undefined,
		},
		attributes,
		resource: { attributes: [], droppedAttributesCount: 0 },
		scope: { name: layer, version: "" },
		serviceName,
		kind: 0,
	};
}

export function parseTelemetryJsonl(text: string): SpanData[] {
	const spans: SpanData[] = [];
	let index = 0;
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		index += 1;
		const span = parseTelemetryLine(line, index);
		if (span) spans.push(span);
	}
	return spans;
}

import { object } from "../config.ts";

export type SpanObservation = {
	traceId: string;
	spanId: string;
	parentSpanId: string | null;
	name: string;
	kind: string;
	startTime: string;
	endTime: string;
	durationMs: number;
	status: "unset" | "ok" | "error";
	statusMessage: string;
	service: string;
	attributes: Record<string, unknown>;
	events: { name: string; time: string; attributes: Record<string, unknown> }[];
	links: {
		traceId: string;
		spanId: string;
		attributes: Record<string, unknown>;
	}[];
	dropped: { attributes: number; events: number; links: number };
	capturedAt: number;
};
export type LogObservation = {
	traceId: string | null;
	spanId: string | null;
	severity: string;
	severityNumber: number;
	body: unknown;
	attributes: Record<string, unknown>;
	service: string;
	capturedAt: number;
};
const malformed = () =>
	new Error("Malformed or unsupported bounded OTLP JSON payload");
function array(value: unknown, maximum: number): unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > maximum) throw malformed();
	return value;
}
function identifier(
	value: unknown,
	length: number,
	redact: (value: string) => string,
	optional = false,
): string | null {
	if (optional && (value === undefined || value === "")) return null;
	if (
		typeof value !== "string" ||
		value.length !== length ||
		!/^[a-f0-9]+$/i.test(value) ||
		/^0+$/.test(value) ||
		redact(value) !== value ||
		redact(value.toLowerCase()) !== value.toLowerCase()
	)
		throw malformed();
	return value.toLowerCase();
}
function nanos(value: unknown, redact: (value: string) => string): bigint {
	if (
		typeof value !== "string" ||
		!/^\d{1,20}$/.test(value) ||
		redact(value) !== value
	)
		throw malformed();
	const result = BigInt(value);
	if (result > 18446744073709551615n) throw malformed();
	return result;
}
function clipped(
	value: unknown,
	redact: (value: string) => string,
	maximum = 2048,
): string {
	if (typeof value !== "string") throw malformed();
	const safe = redact(value);
	return safe.length > maximum
		? `${safe.slice(0, maximum - 11)}[truncated]`
		: safe;
}
function anyValue(
	raw: unknown,
	redact: (value: string) => string,
	depth = 0,
): unknown {
	if (depth > 4) return "[nested OTLP value omitted]";
	const value = object(raw);
	if (typeof value.stringValue === "string")
		return clipped(value.stringValue, redact);
	if (typeof value.boolValue === "boolean") return value.boolValue;
	if (
		typeof value.doubleValue === "number" &&
		Number.isFinite(value.doubleValue)
	)
		return value.doubleValue;
	if (typeof value.intValue === "string" && /^-?\d{1,20}$/.test(value.intValue))
		return clipped(value.intValue, redact);
	if (value.arrayValue !== undefined)
		return array(object(value.arrayValue).values, 16).map((item) =>
			anyValue(item, redact, depth + 1),
		);
	if (value.kvlistValue !== undefined)
		return attributes(object(value.kvlistValue).values, redact, depth + 1);
	return "[unsupported OTLP value omitted]";
}
function attributes(
	raw: unknown,
	redact: (value: string) => string,
	depth = 0,
): Record<string, unknown> {
	return Object.fromEntries(
		array(raw, 64).map((item) => {
			const entry = object(item);
			return [
				clipped(entry.key, redact, 256),
				anyValue(entry.value, redact, depth),
			];
		}),
	);
}
function records(
	payload: unknown,
	mode: "traces" | "logs",
	redact: (value: string) => string,
) {
	const data = object(payload),
		result: Array<{ record: Record<string, unknown>; service: string }> = [];
	const resources = array(
		data[mode === "traces" ? "resourceSpans" : "resourceLogs"],
		16,
	);
	for (const rawResource of resources) {
		const resource = object(rawResource),
			metadata =
				resource.resource === undefined ? {} : object(resource.resource);
		// Attribution never comes from resource attributes. Only the diagnostic service name is retained.
		const service = attributes(metadata.attributes, redact)["service.name"];
		for (const rawScope of array(
			resource[mode === "traces" ? "scopeSpans" : "scopeLogs"],
			16,
		)) {
			const scope = object(rawScope);
			for (const record of array(
				scope[mode === "traces" ? "spans" : "logRecords"],
				500,
			)) {
				result.push({
					record: object(record),
					service:
						typeof service === "string"
							? service.length > 512
								? `${service.slice(0, 501)}[truncated]`
								: service
							: "not-reported",
				});
				if (result.length > 500) throw malformed();
			}
		}
	}
	return result;
}
function dropped(value: unknown): number {
	if (value === undefined) return 0;
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 4294967295
	)
		throw malformed();
	return value;
}
export function decodeSpans(
	payload: unknown,
	redact: (value: string) => string,
	capturedAt: number,
): SpanObservation[] {
	return records(payload, "traces", redact).map(({ record, service }) => {
		const traceId = identifier(record.traceId, 32, redact),
			spanId = identifier(record.spanId, 16, redact);
		if (!traceId || !spanId) throw malformed();
		const parentSpanId = identifier(record.parentSpanId, 16, redact, true);
		const start = nanos(record.startTimeUnixNano, redact),
			end = nanos(record.endTimeUnixNano, redact);
		if (end < start) throw malformed();
		const status = record.status === undefined ? {} : object(record.status);
		const code = status.code === undefined ? 0 : status.code;
		if (typeof code !== "number" || ![0, 1, 2].includes(code))
			throw malformed();
		const kinds = [
			"unspecified",
			"internal",
			"server",
			"client",
			"producer",
			"consumer",
		];
		const kind = record.kind === undefined ? 0 : record.kind;
		if (typeof kind !== "number" || !Number.isInteger(kind) || !kinds[kind])
			throw malformed();
		return {
			traceId,
			spanId,
			parentSpanId,
			name: clipped(record.name, redact, 512),
			kind: kinds[kind],
			startTime: start.toString(),
			endTime: end.toString(),
			durationMs: Number(end - start) / 1000000,
			status: code === 2 ? "error" : code === 1 ? "ok" : "unset",
			statusMessage:
				status.message === undefined
					? ""
					: clipped(status.message, redact, 512),
			service,
			attributes: attributes(record.attributes, redact),
			events: array(record.events, 64).map((raw) => {
				const event = object(raw);
				return {
					name: clipped(event.name, redact, 512),
					time: nanos(event.timeUnixNano, redact).toString(),
					attributes: attributes(event.attributes, redact),
				};
			}),
			links: array(record.links, 64).map((raw) => {
				const link = object(raw),
					traceId = identifier(link.traceId, 32, redact),
					spanId = identifier(link.spanId, 16, redact);
				if (!traceId || !spanId) throw malformed();
				return {
					traceId,
					spanId,
					attributes: attributes(link.attributes, redact),
				};
			}),
			dropped: {
				attributes: dropped(record.droppedAttributesCount),
				events: dropped(record.droppedEventsCount),
				links: dropped(record.droppedLinksCount),
			},
			capturedAt,
		};
	});
}
export function decodeLogs(
	payload: unknown,
	redact: (value: string) => string,
	capturedAt: number,
): LogObservation[] {
	return records(payload, "logs", redact).map(({ record, service }) => {
		const traceId = identifier(record.traceId, 32, redact, true),
			spanId = identifier(record.spanId, 16, redact, true);
		const severityNumber =
			record.severityNumber === undefined ? 0 : record.severityNumber;
		if (
			typeof severityNumber !== "number" ||
			!Number.isInteger(severityNumber) ||
			severityNumber < 0 ||
			severityNumber > 24
		)
			throw malformed();
		return {
			traceId,
			spanId,
			severity:
				record.severityText === undefined
					? ""
					: clipped(record.severityText, redact, 64),
			severityNumber,
			body: record.body === undefined ? null : anyValue(record.body, redact),
			attributes: attributes(record.attributes, redact),
			service,
			capturedAt,
		};
	});
}

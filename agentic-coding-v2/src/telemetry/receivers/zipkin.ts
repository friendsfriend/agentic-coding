import type { SpanData } from "../contracts.ts";

interface ZipkinSpan {
	traceId: string;
	id: string;
	parentId?: string;
	name: string;
	timestamp?: number | string;
	duration?: number | string;
	kind?: string;
	annotations?: Array<{ timestamp: number | string; value: string }>;
	localEndpoint?: { serviceName?: string };
	tags?: Record<string, string>;
}

function microsToNanos(micros: number | string | undefined): bigint {
	const value = micros ?? 0;
	if (
		typeof value === "number"
			? !Number.isSafeInteger(value) || value < 0
			: typeof value !== "string" || !/^\d{1,19}$/.test(value)
	)
		throw new Error("Invalid Zipkin timestamp");
	return BigInt(value) * 1000n;
}
function identity(value: string, lengths: number[], width: number): string {
	if (
		typeof value !== "string" ||
		!lengths.includes(value.length) ||
		!/^[a-f0-9]+$/i.test(value) ||
		/^0+$/.test(value)
	)
		throw new Error("Invalid Zipkin identity");
	return value.toLowerCase().padStart(width, "0");
}

export function normalizeZipkinSpans(body: unknown): SpanData[] {
	if (!Array.isArray(body)) throw new Error("expected array");
	return body.map(normalizeZipkinSpan);
}

export function normalizeZipkinSpan(raw: ZipkinSpan): SpanData {
	const serviceName = raw.localEndpoint?.serviceName ?? "unknown";
	const startTimeNanos = microsToNanos(raw.timestamp);
	const endTimeNanos = startTimeNanos + microsToNanos(raw.duration);
	const tags = raw.tags ?? {};
	const statusCode = tags.error ? 2 : 0;

	return {
		traceId: identity(raw.traceId, [16, 32], 32),
		spanId: identity(raw.id, [16], 16),
		parentSpanId: raw.parentId ? identity(raw.parentId, [16], 16) : "",
		name: raw.name,
		startTimeUnixNano: startTimeNanos.toString(),
		endTimeUnixNano: endTimeNanos.toString(),
		status: { code: statusCode, message: tags.error },
		attributes: Object.entries(tags).map(([key, value]) => ({ key, value })),
		resource: {
			attributes: [{ key: "service.name", value: serviceName }],
			droppedAttributesCount: 0,
		},
		scope: { name: "zipkin", version: "" },
		serviceName,
		kind:
			(
				{
					INTERNAL: 1,
					SERVER: 2,
					CLIENT: 3,
					PRODUCER: 4,
					CONSUMER: 5,
				} as Record<string, number>
			)[raw.kind ?? ""] ?? 0,
		...(raw.annotations?.length
			? {
					events: raw.annotations.map((annotation) => ({
						name: annotation.value,
						timeUnixNano: microsToNanos(annotation.timestamp).toString(),
						attributes: [],
					})),
				}
			: {}),
	};
}

import type {
	LogData,
	MetricData,
	MetricDataPoint,
	MetricValue,
	SpanData,
	SpanEvent,
} from "../contracts.ts";

function id(value: unknown, size: number): boolean {
	return (
		typeof value === "string" &&
		/^[0-9a-f]+$/i.test(value) &&
		value.length === size
	);
}

function nanos(value: unknown): string | undefined {
	if (
		typeof value === "string" &&
		/^\d{1,19}$/.test(value) &&
		BigInt(value) <= 9223372036854775807n
	)
		return value;
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
		return value.toString();
	return undefined;
}

type OtlpAttributeValue = {
	stringValue?: unknown;
	boolValue?: unknown;
	intValue?: unknown;
	doubleValue?: unknown;
};

function attrValue(
	item: OtlpAttributeValue | undefined,
): string | number | boolean | undefined {
	if (typeof item?.stringValue === "string") return item.stringValue;
	if (typeof item?.boolValue === "boolean") return item.boolValue;
	if (item?.intValue !== undefined) return Number(item.intValue);
	return typeof item?.doubleValue === "number" ? item.doubleValue : undefined;
}

function normAttrs(
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

function strAttrs(attrs: unknown): Array<{ key: string; value: string }> {
	if (Array.isArray(attrs))
		return attrs.map((a) => ({
			key: String(a.key ?? ""),
			value: String(attrValue(a.value) ?? ""),
		}));
	if (attrs && typeof attrs === "object")
		return Object.entries(attrs as Record<string, unknown>).map(([k, v]) => ({
			key: k,
			value: String(v),
		}));
	return [];
}

// ---- Spans ----

export // biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
function normalizeOtlpSpan(raw: any): SpanData | undefined {
	const startTimeUnixNano = nanos(raw?.startTimeUnixNano);
	const endTimeUnixNano = nanos(raw?.endTimeUnixNano);
	if (
		!raw ||
		!id(raw.traceId, 32) ||
		!id(raw.spanId, 16) ||
		typeof raw.name !== "string" ||
		!startTimeUnixNano ||
		!endTimeUnixNano
	)
		return undefined;
	const status =
		typeof raw.status === "object" && raw.status !== null
			? {
					code: Number(raw.status.code ?? 0),
					message: raw.status.message ?? undefined,
				}
			: { code: raw.status === "ERROR" ? 2 : 0 };
	const attributes = normAttrs(raw.attributes ?? []);
	const resourceAttributes = normAttrs(raw.resource?.attributes ?? []);
	// Exceptions and log points arrive as span events. They are kept (bounded to
	// their name, time and normalized attributes) because they are usually the
	// reason a span failed, and dropping them would leave a status code as the
	// only explanation a debug tool can report.
	const events: SpanEvent[] = Array.isArray(raw.events)
		? raw.events
				.filter(
					(event: unknown) =>
						typeof (event as { name?: unknown } | null)?.name === "string",
				)
				.map(
					(event: {
						name: string;
						timeUnixNano?: unknown;
						attributes?: unknown;
					}) => ({
						name: event.name,
						timeUnixNano: nanos(event.timeUnixNano) ?? startTimeUnixNano,
						attributes: normAttrs(event.attributes ?? []).map((attribute) => ({
							key: attribute.key,
							value: String(attribute.value),
						})),
					}),
				)
		: [];
	const serviceName = String(
		attributes.find((a) => a.key === "service.name")?.value ??
			resourceAttributes.find((a) => a.key === "service.name")?.value ??
			"unknown",
	);
	return {
		traceId: String(raw.traceId).toLowerCase(),
		spanId: String(raw.spanId).toLowerCase(),
		parentSpanId: id(raw.parentSpanId, 16)
			? String(raw.parentSpanId).toLowerCase()
			: "",
		name: raw.name,
		startTimeUnixNano,
		endTimeUnixNano,
		status,
		attributes,
		resource: {
			attributes: resourceAttributes,
			droppedAttributesCount: Number(raw.resource?.droppedAttributesCount ?? 0),
		},
		scope: { name: raw.scope?.name ?? "", version: raw.scope?.version ?? "" },
		serviceName,
		kind: Number(raw.kind ?? 0),
		...(events.length > 0 ? { events } : {}),
	};
}

export // biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
function decodeOtlpTraces(payload: any): SpanData[] {
	const spans: SpanData[] = [];
	for (const resource of payload?.resourceSpans ?? []) {
		// The resource's attributes are handed to the span normalizer *raw* (in
		// their OTLP `{stringValue}` form) and merged into the span's own: it
		// normalizes once, so a value that arrives typed (an int, a bool) stays
		// typed, and `ac.owner`/`ac.run` survive for attribution.
		const resourceAttributes = resource.resource?.attributes ?? [];
		for (const scope of resource.scopeSpans ?? []) {
			for (const span of scope.spans ?? []) {
				const normalized = normalizeOtlpSpan({
					...span,
					scope: {
						name: scope.scope?.name ?? "",
						version: scope.scope?.version ?? "",
					},
					attributes: [...resourceAttributes, ...(span.attributes ?? [])],
					resource: {
						attributes: resourceAttributes,
						droppedAttributesCount: Number(
							resource.resource?.droppedAttributesCount ?? 0,
						),
					},
				});
				if (normalized) spans.push(normalized);
			}
		}
	}
	return spans;
}

/** OTLP bucket counts are uint64 per bucket; the model carries them exactly or
 * not at all. */
function histogramCounts(value: unknown): number[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error("Invalid OTLP histogram buckets");
	const counts = value.map((item: unknown) => protoInt64(item));
	if (counts.some((count) => count < 0))
		throw new Error("Invalid OTLP histogram buckets");
	return counts;
}

function histogramBounds(value: unknown): number[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value)) throw new Error("Invalid OTLP histogram bounds");
	return value.map((item: unknown) => {
		const bound = protoDouble(item);
		if (bound.value === null) throw new Error("Invalid OTLP histogram bounds");
		return bound.value;
	});
}

type UntrustedPoint = {
	startTimeUnixNano?: unknown;
	timeUnixNano?: unknown;
	attributes?: unknown;
	asDouble?: unknown;
	asInt?: unknown;
	sum?: unknown;
	count?: unknown;
	bucketCounts?: unknown;
	explicitBounds?: unknown;
};

/** One OTLP metric data point. An absent start time is unknown ("0") rather
 * than a copy of the observation time, and an absent histogram sum is an
 * explicit `unknown` measurement rather than a fabricated zero. */
function metricPoint(dp: UntrustedPoint, histogram: boolean): MetricDataPoint {
	const time = nanos(dp.timeUnixNano);
	const start =
		dp.startTimeUnixNano === undefined || dp.startTimeUnixNano === null
			? "0"
			: nanos(dp.startTimeUnixNano);
	if (time === undefined || start === undefined)
		throw new Error("Invalid OTLP metric time");
	const attributes = strAttrs(dp.attributes ?? []);
	if (!histogram)
		return {
			startTimeUnixNano: start,
			timeUnixNano: time,
			...pointMeasurement(dp),
			attributes,
		};
	const bucketCounts = histogramCounts(dp.bucketCounts);
	const explicitBounds = histogramBounds(dp.explicitBounds);
	if (bucketCounts) {
		const bounds = explicitBounds ?? [];
		if (bucketCounts.length !== bounds.length + 1)
			throw new Error("Invalid OTLP histogram buckets");
		for (let index = 1; index < bounds.length; index++) {
			const bound = bounds[index];
			const previous = bounds[index - 1];
			if (bound === undefined || previous === undefined || bound <= previous)
				throw new Error("Invalid OTLP histogram bounds");
		}
	} else if (explicitBounds) throw new Error("Invalid OTLP histogram buckets");
	const count =
		dp.count === undefined || dp.count === null
			? undefined
			: protoInt64(dp.count);
	if (count !== undefined && count < 0)
		throw new Error("Invalid OTLP histogram count");
	if (
		count !== undefined &&
		bucketCounts &&
		bucketCounts.reduce((total, current) => total + current, 0) !== count
	)
		throw new Error("Invalid OTLP histogram count");
	const value =
		dp.sum === undefined || dp.sum === null
			? ({ value: null, nonFiniteValue: "unknown" } as const)
			: protoDouble(dp.sum);
	return {
		startTimeUnixNano: start,
		timeUnixNano: time,
		...value,
		bucketCounts,
		explicitBounds,
		attributes,
	};
}

// ---- Metrics ----

/** ProtoJSON double: a JSON number, a numeric string, or one of the spec's
 * special string tokens. Anything else is a malformed measurement. */
function protoDouble(value: unknown): MetricValue {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Invalid OTLP metric double");
		return { value };
	}
	if (typeof value === "string") {
		switch (value) {
			case "NaN":
				return { value: null, nonFiniteValue: "NaN" };
			case "Infinity":
				return { value: null, nonFiniteValue: "+Inf" };
			case "-Infinity":
				return { value: null, nonFiniteValue: "-Inf" };
		}
		if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(value))
			throw new Error("Invalid OTLP metric double");
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) throw new Error("Invalid OTLP metric double");
		return { value: parsed };
	}
	throw new Error("Invalid OTLP metric double");
}

/** ProtoJSON int64: a JSON integer or its decimal string. A value the native
 * double model cannot carry exactly is refused, never silently rounded. */
function protoInt64(value: unknown): number {
	const text =
		typeof value === "number"
			? String(value)
			: typeof value === "string"
				? value
				: "";
	if (!/^-?\d+$/.test(text)) throw new Error("Invalid OTLP metric integer");
	const parsed = Number(text);
	if (!Number.isSafeInteger(parsed) || BigInt(text) !== BigInt(parsed))
		throw new Error("Unrepresentable OTLP metric integer");
	return parsed;
}

/** A gauge/sum point carries exactly one of asDouble/asInt; neither is a
 * missing measurement, not a zero. */
function pointMeasurement(dp: {
	asDouble?: unknown;
	asInt?: unknown;
}): MetricValue {
	const hasDouble = dp.asDouble !== undefined && dp.asDouble !== null;
	const hasInt = dp.asInt !== undefined && dp.asInt !== null;
	if (hasDouble === hasInt) throw new Error("Invalid OTLP metric point value");
	return hasDouble ? protoDouble(dp.asDouble) : { value: protoInt64(dp.asInt) };
}

export // biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
function decodeOtlpMetrics(payload: any): MetricData[] {
	const metrics: MetricData[] = [];
	for (const resource of payload?.resourceMetrics ?? []) {
		const resAttrs = strAttrs(resource.resource?.attributes ?? []);
		const serviceName =
			resAttrs.find((a) => a.key === "service.name")?.value ?? "unknown";
		for (const scope of resource.scopeMetrics ?? []) {
			for (const metric of scope.metrics ?? []) {
				const pts =
					metric.gauge?.dataPoints ??
					metric.sum?.dataPoints ??
					metric.histogram?.dataPoints ??
					[];
				const type = metric.gauge
					? "gauge"
					: metric.sum
						? "sum"
						: metric.histogram
							? "histogram"
							: undefined;
				if (!type) throw new Error("Unsupported OTLP metric kind");
				// biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
				const dataPoints: MetricDataPoint[] = pts.map((dp: any) =>
					metricPoint(dp, type === "histogram"),
				);
				metrics.push({
					resource: { attributes: resAttrs },
					scope: {
						name: scope.scope?.name ?? "",
						version: scope.scope?.version ?? "",
					},
					name: metric.name ?? "",
					description: metric.description ?? "",
					unit: metric.unit ?? "",
					type,
					dataPoints,
					serviceName,
				});
			}
		}
	}
	return metrics;
}

// ---- Logs ----

export // biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
function decodeOtlpLogs(payload: any): LogData[] {
	const logs: LogData[] = [];
	for (const resource of payload?.resourceLogs ?? []) {
		const resAttrs = strAttrs(resource.resource?.attributes ?? []);
		const serviceName =
			resAttrs.find((a) => a.key === "service.name")?.value ?? "unknown";
		for (const scope of resource.scopeLogs ?? []) {
			for (const log of scope.logRecords ?? []) {
				logs.push({
					resource: { attributes: resAttrs },
					scope: {
						name: scope.scope?.name ?? "",
						version: scope.scope?.version ?? "",
					},
					timeUnixNano: log.timeUnixNano ?? "0",
					severity: log.severityText ?? "INFO",
					body:
						typeof log.body?.stringValue === "string"
							? log.body.stringValue
							: JSON.stringify(log.body ?? ""),
					attributes: strAttrs(log.attributes ?? []),
					traceId: log.traceId ? String(log.traceId).toLowerCase() : undefined,
					spanId: log.spanId ? String(log.spanId).toLowerCase() : undefined,
					serviceName,
				});
			}
		}
	}
	return logs;
}

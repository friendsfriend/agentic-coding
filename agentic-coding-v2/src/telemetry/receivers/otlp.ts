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

const anyValueDepth = 8;

/** One OTLP AnyValue in its native form: a scalar, an exact int64 as its own
 * decimal text (never rounded through a double), a special double as the token
 * the source wrote, bytes as their base64 payload, or a bounded recursive
 * array/kvlist structure. An unknown shape is refused, not stringified. */
function anyValue(value: unknown, depth = 0): unknown {
	if (value === undefined || value === null) return "";
	if (typeof value !== "object") throw new Error("Invalid OTLP AnyValue");
	if (depth > anyValueDepth) throw new Error("Invalid OTLP AnyValue depth");
	const any = value as Record<string, unknown>;
	if (typeof any.stringValue === "string") return any.stringValue;
	if (typeof any.boolValue === "boolean") return any.boolValue;
	if (any.intValue !== undefined) {
		if (typeof any.intValue === "number" && Number.isSafeInteger(any.intValue))
			return any.intValue;
		if (typeof any.intValue === "string" && /^-?\d+$/.test(any.intValue)) {
			const parsed = Number(any.intValue);
			return Number.isSafeInteger(parsed) ? parsed : any.intValue;
		}
		throw new Error("Invalid OTLP AnyValue integer");
	}
	if (any.doubleValue !== undefined) {
		const double = protoDouble(any.doubleValue);
		return double.value ?? String(any.doubleValue);
	}
	if (typeof any.bytesValue === "string") return any.bytesValue;
	if (any.arrayValue !== undefined) {
		const items = (any.arrayValue as { values?: unknown }).values ?? [];
		if (!Array.isArray(items)) throw new Error("Invalid OTLP AnyValue array");
		return items.map((item: unknown) => anyValue(item, depth + 1));
	}
	if (any.kvlistValue !== undefined) {
		const items = (any.kvlistValue as { values?: unknown }).values ?? [];
		if (!Array.isArray(items)) throw new Error("Invalid OTLP AnyValue list");
		const entries: Record<string, unknown> = Object.create(null);
		for (const item of items) {
			const entry = item as { key?: unknown; value?: unknown } | null;
			if (typeof entry?.key !== "string")
				throw new Error("Invalid OTLP AnyValue list entry");
			entries[entry.key] = anyValue(entry.value, depth + 1);
		}
		return entries;
	}
	throw new Error("Unsupported OTLP AnyValue");
}

/** An attribute value the records carry: a scalar, or the JSON text of a
 * structured value so a k/v list is readable instead of silently empty. */
function attributeValue(value: unknown): string | number | boolean {
	if (value === undefined) throw new Error("Invalid OTLP attribute");
	const decoded = anyValue(value);
	return typeof decoded === "string" ||
		typeof decoded === "number" ||
		typeof decoded === "boolean"
		? decoded
		: JSON.stringify(decoded);
}

/** Attributes in the OTLP list shape (and the legacy map shape), keeping their
 * order. A named key is required: an attribute without one identifies nothing. */
function attributeEntries(
	attrs: unknown,
): Array<{ key: string; value: string | number | boolean }> {
	if (attrs === undefined || attrs === null) return [];
	if (Array.isArray(attrs))
		return attrs.map((item) => {
			const entry = item as { key?: unknown; value?: unknown } | null;
			if (typeof entry?.key !== "string" || !entry.key)
				throw new Error("Invalid OTLP attribute key");
			return { key: entry.key, value: attributeValue(entry.value) };
		});
	if (typeof attrs === "object")
		return Object.entries(attrs as Record<string, unknown>).map(
			([key, value]) => {
				if (!key) throw new Error("Invalid OTLP attribute key");
				return {
					key,
					value:
						value !== null &&
						typeof value === "object" &&
						!("stringValue" in value) === false
							? attributeValue(value)
							: typeof value === "string" ||
									typeof value === "number" ||
									typeof value === "boolean"
								? value
								: String(JSON.stringify(value)),
				};
			},
		);
	throw new Error("Invalid OTLP attributes");
}

function strAttrs(attrs: unknown): Array<{ key: string; value: string }> {
	return attributeEntries(attrs).map(({ key, value }) => ({
		key,
		value: typeof value === "string" ? value : String(value),
	}));
}

const statusNames = ["UNSET", "OK", "ERROR"];
const spanKindNames = [
	"UNSPECIFIED",
	"INTERNAL",
	"SERVER",
	"CLIENT",
	"PRODUCER",
	"CONSUMER",
];

/** A ProtoJSON enum arrives as its number or its name; anything outside the
 * declared set is a malformed record, never a silent default. */
function enumNumber(
	value: unknown,
	names: string[],
	prefix: string,
	label: string,
): number {
	const index =
		typeof value === "string"
			? names.indexOf(
					value.startsWith(prefix) ? value.slice(prefix.length) : value,
				)
			: Number(value);
	if (!Number.isInteger(index) || index < 0 || index >= names.length)
		throw new Error(`Invalid OTLP ${label}`);
	return index;
}

const spanKind = (value: unknown) =>
	enumNumber(value, spanKindNames, "SPAN_KIND_", "span kind");

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
	// An absent status is the protocol default (unset); a present one must be a
	// declared code and a textual message.
	const status = (() => {
		if (raw.status === undefined || raw.status === null) return { code: 0 };
		if (typeof raw.status !== "object") {
			return {
				code: enumNumber(
					raw.status,
					statusNames,
					"STATUS_CODE_",
					"status code",
				),
			};
		}
		const code =
			raw.status.code === undefined || raw.status.code === null
				? 0
				: enumNumber(
						raw.status.code,
						statusNames,
						"STATUS_CODE_",
						"status code",
					);
		const message = raw.status.message;
		if (
			message !== undefined &&
			message !== null &&
			typeof message !== "string"
		)
			throw new Error("Invalid OTLP status message");
		return message ? { code, message } : { code };
	})();
	const attributes = attributeEntries(raw.attributes);
	const resourceAttributes = attributeEntries(raw.resource?.attributes);
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
					}) => {
						// A missing event time stays unknown; the span's own start is not
						// the moment the event happened.
						const happened = nanos(event.timeUnixNano);
						if (event.timeUnixNano !== undefined && happened === undefined)
							throw new Error("Invalid OTLP event time");
						return {
							name: event.name,
							timeUnixNano: happened,
							attributes: strAttrs(event.attributes),
						};
					},
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
			droppedAttributesCount:
				raw.resource?.droppedAttributesCount === undefined
					? 0
					: protoInt64(raw.resource.droppedAttributesCount),
		},
		scope: { name: raw.scope?.name ?? "", version: raw.scope?.version ?? "" },
		serviceName,
		kind: raw.kind === undefined || raw.kind === null ? 0 : spanKind(raw.kind),
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

/** The OTel severity number names, index 0 being "SEVERITY_NUMBER_UNSPECIFIED".
 * A numeric severity is shown by its own OTel name ("INFO2" for 10), so nothing
 * is rounded to a neighbouring level it does not have. */
const severityNames = [
	"",
	"TRACE",
	"TRACE2",
	"TRACE3",
	"TRACE4",
	"DEBUG",
	"DEBUG2",
	"DEBUG3",
	"DEBUG4",
	"INFO",
	"INFO2",
	"INFO3",
	"INFO4",
	"WARN",
	"WARN2",
	"WARN3",
	"WARN4",
	"ERROR",
	"ERROR2",
	"ERROR3",
	"ERROR4",
	"FATAL",
	"FATAL2",
	"FATAL3",
	"FATAL4",
];

/** ProtoJSON enums arrive as their name or their number; an absent or
 * unspecified severity stays absent instead of becoming a default level. */
function severity(log: { severityText?: unknown; severityNumber?: unknown }) {
	const raw = log.severityNumber;
	let index: number | undefined;
	if (raw !== undefined && raw !== null) {
		index =
			typeof raw === "number"
				? raw
				: typeof raw === "string"
					? raw.startsWith("SEVERITY_NUMBER_")
						? severityNames.indexOf(raw.slice("SEVERITY_NUMBER_".length))
						: Number(raw)
					: Number.NaN;
		if (!Number.isInteger(index) || index < 0 || index >= severityNames.length)
			throw new Error("Invalid OTLP severity number");
	}
	if (typeof log.severityText === "string" && log.severityText.trim())
		return log.severityText;
	return index === undefined ? "" : (severityNames[index] ?? "");
}

/** A log body as text: the scalar itself or the JSON of a structured body. */
function logBody(value: unknown): string {
	const body = anyValue(value);
	return typeof body === "string" ? body : JSON.stringify(body);
}

/** A correlation id is used as-is or not at all: 32/16 lowercase hex, and an
 * all-zero id is the protocol's "unset" rather than a trace a query can match. */
function correlation(value: unknown, size: number): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (
		typeof value !== "string" ||
		value.length !== size ||
		!/^[0-9a-f]+$/i.test(value)
	)
		throw new Error("Invalid OTLP correlation id");
	const lower = value.toLowerCase();
	return /^0+$/.test(lower) ? undefined : lower;
}

export // biome-ignore lint/suspicious/noExplicitAny: untrusted OTLP JSON, validated field-by-field
function decodeOtlpLogs(payload: any): LogData[] {
	const logs: LogData[] = [];
	for (const resource of payload?.resourceLogs ?? []) {
		const resAttrs = strAttrs(resource.resource?.attributes ?? []);
		const serviceName =
			resAttrs.find((a) => a.key === "service.name")?.value ?? "unknown";
		for (const scope of resource.scopeLogs ?? []) {
			for (const log of scope.logRecords ?? []) {
				// A record the source could not place in time would sort at the epoch and
				// be pruned as ancient, so its own observed time is the only fallback.
				const time = nanos(log.timeUnixNano ?? log.observedTimeUnixNano);
				if (time === undefined) throw new Error("Invalid OTLP log time");
				logs.push({
					resource: { attributes: resAttrs },
					scope: {
						name: scope.scope?.name ?? "",
						version: scope.scope?.version ?? "",
					},
					timeUnixNano: time,
					severity: severity(log),
					body: logBody(log.body),
					attributes: strAttrs(log.attributes ?? []),
					traceId: correlation(log.traceId, 32),
					spanId: correlation(log.spanId, 16),
					serviceName,
				});
			}
		}
	}
	return logs;
}

import type { MetricData, MetricDataPoint } from "../contracts.ts";

function invalid(): never {
	throw new Error("Invalid Datadog series payload");
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) invalid();
	return value;
}
function text(value: unknown): string {
	if (typeof value !== "string") invalid();
	return value;
}

/** Decimal seconds, including exponent notation, converted without floating-point
 * multiplication. Sub-nanosecond observations are refused rather than rounded. */
function seconds(value: unknown, wholeOnly: boolean): string {
	if (typeof value !== "string" && typeof value !== "number") invalid();
	const source = String(value);
	if (source.length > 64) invalid();
	const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
	if (!match) invalid();
	const fraction = match[2] ?? "";
	const exponent = Number(match[3] ?? 0);
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30) invalid();
	let nanos = BigInt(`${match[1]}${fraction}`);
	const shift = 9 + exponent - fraction.length;
	if (shift >= 0) nanos *= 10n ** BigInt(shift);
	else {
		const divisor = 10n ** BigInt(-shift);
		if (nanos % divisor !== 0n) invalid();
		nanos /= divisor;
	}
	if (
		nanos > 9223372036854775807n ||
		(wholeOnly && nanos % 1_000_000_000n !== 0n)
	)
		invalid();
	return nanos.toString();
}

/** Both APIs have numeric timestamps, but v1 uses tuple points and v2 objects.
 * Retain their decimal tokens before JSON can round fractional seconds. */
function parse(body: string): unknown {
	return JSON.parse(
		body,
		function (
			this: unknown,
			key: string,
			value: unknown,
			context?: { source?: string },
		) {
			if (
				typeof value === "number" &&
				(key === "timestamp" ||
					(Array.isArray(this) &&
						this.length === 2 &&
						key === "0" &&
						typeof this[1] === "number"))
			) {
				if (context?.source) return context.source;
				if (!Number.isSafeInteger(value)) invalid();
			}
			return value;
		},
	);
}

export function decodeDatadogSeries(
	body: string,
	version: "v1" | "v2",
): MetricData[] {
	const payload = record(parse(body));
	return list(payload.series).map((value) => {
		const series = record(value);
		const name = text(series.metric);
		if (!name) invalid();
		const labels = list(series.tags ?? []).map((value) => {
			const tag = text(value);
			const colon = tag.indexOf(":");
			const key = colon < 0 ? tag : tag.slice(0, colon);
			if (!key) invalid();
			return { key, value: colon < 0 ? "true" : tag.slice(colon + 1) };
		});
		let kind: string;
		if (version === "v1") {
			kind = text(series.type ?? "gauge");
			if (!["gauge", "count", "rate"].includes(kind)) invalid();
		} else {
			const type = series.type ?? 0;
			if (
				typeof type !== "number" ||
				!Number.isInteger(type) ||
				type < 0 ||
				type > 3
			)
				invalid();
			kind = ["unspecified", "count", "rate", "gauge"][type] ?? invalid();
		}
		const attributes = [{ key: "datadog.metric.type", value: kind }];
		if (series.interval !== undefined) {
			if (
				typeof series.interval !== "number" ||
				!Number.isSafeInteger(series.interval) ||
				series.interval < 0 ||
				((kind === "count" || kind === "rate") && series.interval === 0)
			)
				invalid();
			attributes.push({
				key: "datadog.interval",
				value: String(series.interval),
			});
		}
		if (series.source_type_name !== undefined)
			attributes.push({
				key: "datadog.source_type_name",
				value: text(series.source_type_name),
			});
		if (version === "v1" && series.host !== undefined) {
			const host = text(series.host);
			if (!host) invalid();
			attributes.push({ key: "host.name", value: host });
		}
		if (version === "v2") {
			for (const value of list(series.resources ?? [])) {
				const resource = record(value);
				const type = text(resource.type),
					name = text(resource.name);
				if (!type || !name) invalid();
				attributes.push({
					key: type === "host" ? "host.name" : `datadog.resource.${type}`,
					value: name,
				});
			}
		}
		const services = [
			...new Set(
				labels
					.filter((label) => label.key === "service" && label.value)
					.map((label) => label.value),
			),
		];
		if (services.length > 1) invalid();
		const hosts = [
			...new Set(
				attributes
					.filter((attribute) => attribute.key === "host.name")
					.map((attribute) => attribute.value),
			),
		];
		const points = list(series.points);
		if (!points.length) invalid();
		const dataPoints: MetricDataPoint[] = points.map((value) => {
			let stamp: unknown, sample: unknown;
			if (version === "v1") {
				const tuple = list(value);
				if (tuple.length !== 2) invalid();
				[stamp, sample] = tuple;
			} else {
				const point = record(value);
				stamp = point.timestamp;
				sample = point.value;
			}
			if (typeof sample !== "number" || !Number.isFinite(sample)) invalid();
			const time = seconds(stamp, version === "v2");
			return {
				startTimeUnixNano: time,
				timeUnixNano: time,
				value: sample,
				attributes: labels,
			};
		});
		return {
			resource: { attributes },
			scope: { name: "datadog", version: "" },
			name,
			description: "",
			unit: text(series.unit ?? ""),
			// Rate observations are gauges, not count samples. Preserve the declared
			// kind and interval in resource identity; never invent cumulative counts.
			type: kind === "count" ? "sum" : "gauge",
			dataPoints,
			serviceName:
				services[0] ?? (hosts.length === 1 ? hosts[0] : "datadog") ?? "datadog",
		};
	});
}

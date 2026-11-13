import type { MetricData, MetricDataPoint } from "../contracts.ts";

type StatsDKind = "c" | "g" | "ms" | "h" | "d";
interface StatsDParsed {
	name: string;
	value: number;
	type: StatsDKind;
	sampleRate: number;
	tags: Array<{ key: string; value: string }>;
}
const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Supported numeric observations only. Stateful relative gauges, sets, packed
 * values and origin extensions are refused rather than silently reinterpreted. */
export function parseStatsDLine(line: string): StatsDParsed | null {
	const parts = line.trim().split("|");
	const head = parts[0] ?? "";
	const colon = head.indexOf(":");
	if (colon < 1) return null;
	const name = head.slice(0, colon),
		token = head.slice(colon + 1);
	if (!/^[^\s:|]+$/.test(name) || !numeric.test(token)) return null;
	const value = Number(token),
		type = parts[1];
	if (
		!Number.isFinite(value) ||
		(type !== "c" &&
			type !== "g" &&
			type !== "ms" &&
			type !== "h" &&
			type !== "d")
	)
		return null;
	if (type === "g" && /^[+-]/.test(token)) return null;
	let sampleRate = 1,
		hasRate = false,
		hasTags = false;
	const tags: StatsDParsed["tags"] = [];
	for (const flag of parts.slice(2)) {
		if (flag.startsWith("@")) {
			if (hasRate || !numeric.test(flag.slice(1))) return null;
			hasRate = true;
			sampleRate = Number(flag.slice(1));
			if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1)
				return null;
		} else if (flag.startsWith("#")) {
			if (hasTags) return null;
			hasTags = true;
			for (const item of flag.slice(1).split(",")) {
				const tag = item.trim(),
					split = tag.indexOf(":");
				const key = split < 0 ? tag : tag.slice(0, split);
				if (!key) return null;
				tags.push({ key, value: split < 0 ? "true" : tag.slice(split + 1) });
			}
		} else return null;
	}
	if (type === "g" && sampleRate !== 1) return null;
	return { name, value, type, sampleRate, tags };
}

/** One owner-provided observation time per sample, not a fictional wire time.
 * Validate the entire packet before returning anything to the storage router. */
export function normalizeStatsDMetrics(
	lines: string[],
	source: string,
	observedAt: () => string,
): MetricData[] {
	const observations: StatsDParsed[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const parsed = parseStatsDLine(line);
		if (!parsed) throw new Error("Invalid or unsupported StatsD observation");
		observations.push(parsed);
	}
	const aggregator = new Map<string, MetricData>();
	for (const parsed of observations) {
		const key = JSON.stringify([
			parsed.name,
			parsed.type,
			parsed.sampleRate,
			[...parsed.tags].sort(
				(a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
			),
		]);
		const value =
			parsed.type === "c" ? parsed.value / parsed.sampleRate : parsed.value;
		if (!Number.isFinite(value))
			throw new Error("Invalid StatsD count estimate");
		const time = observedAt();
		const point: MetricDataPoint = {
			startTimeUnixNano: time,
			timeUnixNano: time,
			value,
			attributes: parsed.tags,
		};
		const existing = aggregator.get(key);
		if (existing) existing.dataPoints.push(point);
		else
			aggregator.set(key, {
				resource: {
					attributes: [
						{ key: "service.name", value: source },
						{ key: "statsd.type", value: parsed.type },
						{ key: "statsd.sample_rate", value: String(parsed.sampleRate) },
						{ key: "statsd.timestamp.source", value: "collector-observed" },
					],
				},
				scope: { name: "statsd", version: "" },
				name: parsed.name,
				description:
					parsed.type === "c"
						? "StatsD count deltas adjusted by inverse sample rate."
						: parsed.type === "g"
							? "StatsD absolute gauge observations."
							: "Unaggregated StatsD timer/distribution observations; no histogram buckets.",
				unit: parsed.type === "ms" ? "ms" : "",
				type: parsed.type === "c" ? "sum" : "gauge",
				dataPoints: [point],
				serviceName: source,
			});
	}
	return [...aggregator.values()];
}

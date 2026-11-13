import type { MetricData, MetricDataPoint } from "../contracts.ts";

type Labels = Array<{ key: string; value: string }>;
type Kind = "counter" | "gauge" | "histogram" | "summary" | "untyped";
interface Family {
	help: string;
	type: Kind;
	hasHelp?: boolean;
	hasType?: boolean;
}
interface Sample {
	name: string;
	labels: Labels;
	value: number;
	time: string;
}
interface Histogram {
	family: string;
	labels: Labels;
	time: string;
	buckets: Array<{ bound: number; count: number }>;
	count?: number;
	sum?: number;
}
const numberToken = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const sorted = (labels: Labels) =>
	[...labels].sort((a, b) => a.key.localeCompare(b.key));
function invalid(): never {
	throw new Error("Invalid or unsupported Prometheus exposition");
}
function numeric(value: string): number {
	if (!numberToken.test(value)) invalid();
	const number = Number(value);
	if (!Number.isFinite(number)) invalid();
	return number;
}
function decodeEscapes(value: string, quoted: boolean): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char !== "\\") {
			result += char;
			continue;
		}
		const next = value[++index];
		if (next === "n") result += "\n";
		else if (next === "\\" || (quoted && next === '"')) result += next;
		else invalid();
	}
	return result;
}
function labels(value: string): Labels {
	const result: Labels = [];
	const seen = new Set<string>();
	const pattern =
		/[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*"((?:[^"\\]|\\[n"\\])*)"[ \t]*(,|$)/y;
	let cursor = 0;
	while (cursor < value.length) {
		while (value[cursor] === " " || value[cursor] === "\t") cursor++;
		if (cursor === value.length) break;
		pattern.lastIndex = cursor;
		const match = pattern.exec(value);
		if (!match || seen.has(match[1])) invalid();
		seen.add(match[1]);
		result.push({ key: match[1], value: decodeEscapes(match[2], true) });
		cursor = pattern.lastIndex;
	}
	return result;
}
function timestamp(value: string | undefined, observed: string): string {
	if (value === undefined) return observed;
	if (!/^[+]?\d{1,16}$/.test(value)) invalid();
	const nanos = BigInt(value) * 1_000_000n;
	if (nanos > 9223372036854775807n) invalid();
	return nanos.toString();
}

/** Finite classic 0.0.4 exposition. Refuse unrepresentable/malformed scrapes
 * atomically; do not silently skip samples or pretend to implement OpenMetrics. */
export function parsePrometheusText(
	text: string,
	source: string,
): MetricData[] {
	const observed = (BigInt(Date.now()) * 1_000_000n).toString();
	const families = new Map<string, Family>();
	const samples: Sample[] = [];
	const identities = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#")) {
			if (/^#\s*(UNIT|EOF)(?:\s|$)/.test(line)) invalid();
			const directive =
				/^#\s*(HELP|TYPE)\s+([a-zA-Z_:][a-zA-Z0-9_:]*)(?:[ \t]+(.*))?$/.exec(
					line,
				);
			if (!directive) {
				if (/^#\s*(HELP|TYPE)(?:\s|$)/.test(line)) invalid();
				continue;
			}
			const name = directive[2];
			const family = families.get(name) ?? { help: "", type: "untyped" };
			if (directive[1] === "HELP") {
				if (family.hasHelp) invalid();
				family.hasHelp = true;
				family.help = decodeEscapes(directive[3] ?? "", false);
			} else {
				if (
					family.hasType ||
					!["counter", "gauge", "histogram", "summary", "untyped"].includes(
						directive[3] ?? "",
					)
				)
					invalid();
				family.hasType = true;
				family.type = directive[3] as Kind;
			}
			families.set(name, family);
			continue;
		}
		const match =
			/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?[ \t]+([^\s]+)(?:[ \t]+([^\s]+))?[ \t]*$/.exec(
				line,
			);
		if (!match) invalid();
		const attributes = labels(match[2] ?? "");
		const key = JSON.stringify([match[1], sorted(attributes)]);
		if (identities.has(key)) invalid();
		identities.add(key);
		samples.push({
			name: match[1],
			labels: attributes,
			value: numeric(match[3]),
			time: timestamp(match[4], observed),
		});
	}
	const metrics = new Map<string, MetricData>();
	const histograms = new Map<string, Histogram>();
	const emit = (
		name: string,
		familyName: string,
		family: Family,
		component: string,
		type: MetricData["type"],
		point: MetricDataPoint,
	) => {
		let metric = metrics.get(name);
		if (!metric) {
			metric = {
				name,
				description: family.help,
				unit: "",
				type,
				scope: { name: "prometheus", version: "" },
				serviceName: source,
				resource: {
					attributes: [
						{ key: "service.name", value: source },
						{ key: "prometheus.family", value: familyName },
						{ key: "prometheus.type", value: family.type },
						{ key: "prometheus.component", value: component },
						...(type === "sum" || type === "histogram"
							? [{ key: "prometheus.temporality", value: "cumulative" }]
							: []),
					],
				},
				dataPoints: [],
			};
			metrics.set(name, metric);
		}
		if (metric.type !== type) invalid();
		metric.dataPoints.push(point);
	};
	for (const sample of samples) {
		let familyName = sample.name,
			component = "sample";
		let family = families.get(familyName);
		if (!family) {
			const suffix = /^(.*)_(bucket|sum|count)$/.exec(sample.name);
			const parent = suffix ? families.get(suffix[1]) : undefined;
			if (
				suffix &&
				parent &&
				(parent.type === "histogram" || parent.type === "summary")
			) {
				familyName = suffix[1];
				family = parent;
				component = suffix[2];
			}
		}
		family ??= { help: "", type: "untyped" };
		if (family.type === "histogram") {
			if (!["bucket", "sum", "count"].includes(component)) invalid();
			const le = sample.labels.find((label) => label.key === "le");
			if ((component === "bucket") !== Boolean(le)) invalid();
			const attributes = sample.labels.filter((label) => label.key !== "le");
			const key = JSON.stringify([familyName, sorted(attributes), sample.time]);
			const histogram = histograms.get(key) ?? {
				family: familyName,
				labels: attributes,
				time: sample.time,
				buckets: [],
			};
			if (component === "bucket") {
				const bound =
					le?.value === "+Inf" || le?.value === "Inf"
						? Number.POSITIVE_INFINITY
						: numeric(le?.value ?? "");
				histogram.buckets.push({ bound, count: sample.value });
			} else if (component === "count") histogram.count = sample.value;
			else histogram.sum = sample.value;
			histograms.set(key, histogram);
		} else if (family.type === "summary") {
			if (component === "bucket") invalid();
			if (component === "sample") {
				const quantile = numeric(
					sample.labels.find((label) => label.key === "quantile")?.value ?? "",
				);
				if (quantile < 0 || quantile > 1) invalid();
				component = "quantile";
			}
		}
		emit(
			sample.name,
			familyName,
			family,
			component,
			family.type === "counter" ||
				["bucket", "count", "sum"].includes(component)
				? "sum"
				: "gauge",
			{
				startTimeUnixNano: "0",
				timeUnixNano: sample.time,
				value: sample.value,
				attributes: sample.labels,
			},
		);
	}
	for (const histogram of histograms.values()) {
		const { count, sum } = histogram;
		if (
			count === undefined ||
			sum === undefined ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			(count === 0 && sum !== 0)
		)
			invalid();
		const buckets = histogram.buckets.sort((a, b) => a.bound - b.bound);
		if (
			!buckets.length ||
			buckets.at(-1)?.bound !== Number.POSITIVE_INFINITY ||
			buckets.at(-1)?.count !== count
		)
			invalid();
		const bounds: number[] = [],
			counts: number[] = [];
		let previous = 0;
		for (const [index, bucket] of buckets.entries()) {
			if (
				!Number.isSafeInteger(bucket.count) ||
				bucket.count < previous ||
				(index > 0 &&
					bucket.bound <=
						(buckets[index - 1]?.bound ?? Number.NEGATIVE_INFINITY))
			)
				invalid();
			counts.push(bucket.count - previous);
			previous = bucket.count;
			if (Number.isFinite(bucket.bound)) bounds.push(bucket.bound);
		}
		const family = families.get(histogram.family);
		if (!family) invalid();
		emit(histogram.family, histogram.family, family, "histogram", "histogram", {
			startTimeUnixNano: "0",
			timeUnixNano: histogram.time,
			value: sum,
			attributes: histogram.labels,
			bucketCounts: counts,
			explicitBounds: bounds,
		});
	}
	return [...metrics.values()];
}

import type { MetricData, MetricDataPoint } from "./contracts.ts";

const attributes = (items: Array<{ key: string; value: string }>) =>
	[...items].sort(
		(a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
	);
/** Compatible stream identity: point labels remain individual series within
 * that stream; different resources/scopes/types/units must never be merged. */
export const metricStreamId = (metric: MetricData): string =>
	JSON.stringify([
		metric.serviceName,
		metric.name,
		metric.type,
		metric.unit,
		metric.scope.name,
		metric.scope.version,
		attributes(metric.resource.attributes),
	]);
const pointId = (point: MetricDataPoint) =>
	JSON.stringify([
		point.startTimeUnixNano,
		point.timeUnixNano,
		attributes(point.attributes),
	]);

/** Input is newest-ingested batch first. A retransmission/correction replaces
 * the same sample coordinates, while independently labelled points survive.
 * Retention is the database's explicit record window, not a second hidden cap. */
export function mergeMetricBatches(batches: MetricData[]): MetricData[] {
	const streams = new Map<
		string,
		{ metric: MetricData; points: Map<string, MetricDataPoint> }
	>();
	for (const metric of batches) {
		const id = metricStreamId(metric);
		let stream = streams.get(id);
		if (!stream) {
			stream = { metric: { ...metric, dataPoints: [] }, points: new Map() };
			streams.set(id, stream);
		}
		for (const point of metric.dataPoints) {
			const coordinate = pointId(point);
			if (!stream.points.has(coordinate)) stream.points.set(coordinate, point);
		}
	}
	return [...streams.values()].map(({ metric, points }) => ({
		...metric,
		dataPoints: [...points.values()].sort((a, b) => {
			const left = BigInt(a.timeUnixNano),
				right = BigInt(b.timeUnixNano);
			return left < right
				? -1
				: left > right
					? 1
					: pointId(a).localeCompare(pointId(b));
		}),
	}));
}

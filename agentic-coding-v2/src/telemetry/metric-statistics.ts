import type { MetricData, MetricStatistics } from "./contracts.ts";

/** Finite-only descriptive statistics, never invented zero measurements. Native
 * history reads and the compatibility store use this same projection. */
export function metricStatistics(
	metric: Pick<MetricData, "dataPoints">,
): MetricStatistics {
	let avg = 0,
		min = Number.POSITIVE_INFINITY,
		max = Number.NEGATIVE_INFINITY,
		finiteCount = 0;
	for (const point of metric.dataPoints) {
		const value = point.value;
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		finiteCount++;
		// A convex mean avoids overflowing the sum of otherwise finite samples.
		avg = avg * ((finiteCount - 1) / finiteCount) + value / finiteCount;
		min = Math.min(min, value);
		max = Math.max(max, value);
	}
	return {
		avg: finiteCount && Number.isFinite(avg) ? avg : null,
		min: finiteCount ? min : null,
		max: finiteCount ? max : null,
		count: metric.dataPoints.length,
		finiteCount,
	};
}

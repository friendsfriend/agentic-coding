import { describe, expect, test } from "bun:test";
import {
	appendContainerSample,
	containerTrend,
	sampleContainer,
	sparkline,
} from "../src/environments/stats.ts";

describe("container stats history", () => {
	test("caps samples and computes sparklines/deltas", () => {
		const first = sampleContainer(
			{
				container: "a",
				provider: "docker",
				cpuPercent: 1,
				memoryUsageBytes: 100,
				memoryPercent: 10,
				networkRxBytes: 10,
				networkTxBytes: 5,
			},
			1,
		);
		const second = sampleContainer(
			{
				container: "a",
				provider: "docker",
				cpuPercent: 3,
				memoryUsageBytes: 200,
				memoryPercent: 30,
				networkRxBytes: 30,
				networkTxBytes: 9,
			},
			2,
		);
		const samples = appendContainerSample(
			appendContainerSample([], first, 2),
			second,
			2,
		);
		expect(samples).toHaveLength(2);
		expect(appendContainerSample(samples, { ...second, at: 3 }, 2)).toEqual([
			second,
			{ ...second, at: 3 },
		]);
		expect(containerTrend(samples)).toMatchObject({
			count: 2,
			cpuDelta: 2,
			memoryDelta: 100,
			networkRxDelta: 20,
			networkTxDelta: 4,
		});
		expect(containerTrend(samples).cpuSpark).toBe("▃█");
		expect(containerTrend(samples).memorySpark).toBe("▃█");
	});

	test("renders bounded sparklines and handles missing data", () => {
		expect(sparkline([0, 50, 100], 100)).toBe("▁▅█");
		expect(sparkline([])).toBe("");
		expect(containerTrend([])).toMatchObject({
			count: 0,
			cpuSpark: "",
			memorySpark: "",
		});
		expect(containerTrend([{ at: 1, cpuPercent: 5 }])).toMatchObject({
			count: 1,
			cpuDelta: undefined,
			cpuSpark: "█",
		});
	});
});

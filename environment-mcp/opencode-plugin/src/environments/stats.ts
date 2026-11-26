import type { ContainerStatsEntry } from "./model.ts";

export type ContainerSample = {
	at: number;
	cpuPercent?: number;
	memoryUsageBytes?: number;
	memoryPercent?: number;
	networkRxBytes?: number;
	networkTxBytes?: number;
	pids?: number;
};

export type ContainerTrend = {
	count: number;
	cpuSpark: string;
	memorySpark: string;
	cpuDelta?: number;
	memoryDelta?: number;
	networkRxDelta?: number;
	networkTxDelta?: number;
};

const glyphs = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function sampleContainer(
	entry: ContainerStatsEntry,
	at = Date.now(),
): ContainerSample {
	return {
		at,
		...(entry.cpuPercent !== undefined ? { cpuPercent: entry.cpuPercent } : {}),
		...(entry.memoryUsageBytes !== undefined
			? { memoryUsageBytes: entry.memoryUsageBytes }
			: {}),
		...(entry.memoryPercent !== undefined
			? { memoryPercent: entry.memoryPercent }
			: {}),
		...(entry.networkRxBytes !== undefined
			? { networkRxBytes: entry.networkRxBytes }
			: {}),
		...(entry.networkTxBytes !== undefined
			? { networkTxBytes: entry.networkTxBytes }
			: {}),
		...(entry.pids !== undefined ? { pids: entry.pids } : {}),
	};
}

export function appendContainerSample(
	samples: readonly ContainerSample[],
	sample: ContainerSample,
	limit = 60,
) {
	const next = [...samples, sample];
	return next.length > limit ? next.slice(next.length - limit) : next;
}

export function sparkline(values: readonly number[], peak?: number) {
	if (!values.length) return "";
	const max = peak ?? Math.max(...values, 0);
	const scale = max > 0 ? max : 1;
	return values
		.map((value) => {
			const index = Math.min(
				7,
				Math.max(0, Math.round((Math.max(0, value) / scale) * 7)),
			);
			return glyphs[index] ?? glyphs[0];
		})
		.join("");
}

function delta(values: readonly (number | undefined)[]) {
	const defined = values.filter(
		(value): value is number => value !== undefined,
	);
	if (defined.length < 2) return undefined;
	const first = defined[0];
	const last = defined[defined.length - 1];
	if (first === undefined || last === undefined) return undefined;
	return last - first;
}

export function containerTrend(
	samples: readonly ContainerSample[],
	window = 30,
): ContainerTrend {
	const recent = samples.slice(-window);
	const cpu = recent.flatMap((sample) =>
		sample.cpuPercent !== undefined ? [sample.cpuPercent] : [],
	);
	const memoryPercent = recent.flatMap((sample) =>
		sample.memoryPercent !== undefined ? [sample.memoryPercent] : [],
	);
	const memoryUsage = recent.flatMap((sample) =>
		sample.memoryUsageBytes !== undefined ? [sample.memoryUsageBytes] : [],
	);
	return {
		count: recent.length,
		cpuSpark: sparkline(cpu),
		memorySpark: sparkline(memoryPercent.length ? memoryPercent : memoryUsage),
		cpuDelta: delta(recent.map((sample) => sample.cpuPercent)),
		memoryDelta: delta(recent.map((sample) => sample.memoryUsageBytes)),
		networkRxDelta: delta(recent.map((sample) => sample.networkRxBytes)),
		networkTxDelta: delta(recent.map((sample) => sample.networkTxBytes)),
	};
}

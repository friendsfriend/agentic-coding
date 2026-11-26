export type ContainerStats = {
	cpuPercent?: number;
	memoryUsageBytes?: number;
	memoryLimitBytes?: number;
	memoryPercent?: number;
	networkRxBytes?: number;
	networkTxBytes?: number;
	pids?: number;
	readAt?: string;
};

export type ContainerStatsEntry = ContainerStats & {
	container: string;
	repository?: string;
	app?: string;
	service?: string;
	provider: "docker" | "podman";
};

export type ContainerStatsResult = {
	containers: readonly ContainerStatsEntry[];
	unavailable: number;
	note: string;
};

export interface ContainerStatsPort {
	stats(
		provider: "docker" | "podman",
		socket: string,
		container: string,
		signal: AbortSignal,
	): Promise<ContainerStats>;
}

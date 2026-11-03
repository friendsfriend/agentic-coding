export type Exit = { code: number | null; signal: string | null };
export type RuntimeStatus = {
	runtime: "docker" | "podman" | "kubernetes";
	kind?: "container" | "network" | "pod";
	name: string;
	id: string | null;
	state: "running" | "stopped" | "absent" | "unknown";
	health: "healthy" | "unhealthy" | "starting" | null;
	owned: boolean | null;
	observedAt: number;
};
/** Live authority, never reconstructed from a durable resource identifier. */
export interface EnvironmentProcess {
	readonly pid: number | null;
	readonly done: Promise<Exit>;
	readonly logs: string;
	readonly outcome: Exit | null;
	readonly cleanupFailed: boolean;
	readonly runtimeStatus?: RuntimeStatus;
	readonly runtimeStatuses?: RuntimeStatus[];
	ready(signal?: AbortSignal): Promise<void>;
	wait(signal?: AbortSignal): Promise<Exit>;
	stop(): Promise<void>;
}

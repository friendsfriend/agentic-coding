import type { TelemetryReader } from "./model.ts";
export type Exit = { code: number | null; signal: string | null };
export type LogTiming = {
	basis: "host-receipt-completed-lines" | "provider-event-time-completed-lines";
	/** `observedAt` is the runtime's own timestamp for that completed line; a
	 * provider-timed capture without it is invalid rather than host-substituted. */
	entries: Array<{
		receivedAt: number;
		observedAt?: string;
		characters: number;
	}>;
	truncated: boolean;
};
export type ServiceLog = {
	output: string;
	truncated: boolean;
	timing?: LogTiming;
};
export type RuntimeStatus = {
	runtime: "docker" | "podman" | "kubernetes";
	kind?: "container" | "network" | "pod";
	name: string;
	id: string | null;
	state: "running" | "stopped" | "absent" | "unknown";
	health: "healthy" | "unhealthy" | "starting" | null;
	// Configured check kind; health remains a Kubernetes API observation, not a local probe.
	readiness?: "http-probe" | "tcp-probe" | "pod-ready";
	owned: boolean | null;
	observedAt: number;
};
/** Live authority, never reconstructed from a durable resource identifier. */
export interface EnvironmentProcess {
	readonly pid: number | null;
	readonly done: Promise<Exit>;
	readonly logs: string;
	readonly logTiming?: LogTiming;
	readonly telemetry?: TelemetryReader;
	readonly serviceLogs?: Record<string, ServiceLog>;
	/** Synchronous revocation before remote/local cleanup has an outcome. */
	readonly closing?: boolean;
	readonly outcome: Exit | null;
	readonly cleanupFailed: boolean;
	readonly runtimeStatus?: RuntimeStatus;
	readonly runtimeStatuses?: RuntimeStatus[];
	ready(signal?: AbortSignal): Promise<void>;
	wait(signal?: AbortSignal): Promise<Exit>;
	stop(): Promise<void>;
}

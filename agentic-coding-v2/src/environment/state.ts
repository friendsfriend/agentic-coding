import { defineDoc } from "@earendil-works/pi-durable";
import type { Plan } from "./model.ts";
import type { LogTiming, RuntimeStatus, ServiceLog } from "./process.ts";

export const EnvironmentState = defineDoc<{
	runs: Record<string, string>;
	operatorRevocations?: Record<string, string>;
	unitStarts?: Record<string, string>;
	stops: Record<string, string>;
	reuses?: Record<string, string>;
	httpOperations?: Record<string, string>;
	queryOperations?: Record<string, string>;
	waits?: Record<string, string>;
	waitPolls?: Record<string, string>;
	waitOrdinal?: number;
	referenceGraphs?: Record<string, string>;
}>({
	kind: "v2.environments",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {}, stops: {}, reuses: {}, httpOperations: {} }),
	checkpointWhen: () => true,
});
export type ReuseReceipt = {
	owner: number;
	request: string;
	runs: string[];
	createdAt: number;
};
export type IdleReap = { at: number; lastActivityAt: number; ttlMs: number };
export type OperatorUnitStart = {
	id: string;
	requestId: string;
	owner: number;
	runId: string;
	revision: number;
	reason: string;
	topology: string;
	batch: string;
	createdAt: number;
	state:
		| "pending"
		| "review"
		| "issued"
		| "completed"
		| "rejected"
		| "interrupted";
	error?: string;
};
export type OperatorUnitStop = {
	runId: string;
	revision: number;
	reason: string;
};
export type StopReceipt = {
	/** Revision-fenced developer intention; observation only, never a restored handle. */
	operatorUnit?: OperatorUnitStop;
	owner: number;
	apps: string[] | null;
	runs: string[];
	batches: string[];
	done: boolean;
	cleanupUncertain?: boolean;
	idle?: IdleReap;
};
export type EnvironmentRun = {
	id: string;
	batch: string;
	request: string;
	owner: number;
	plan: Plan;
	state: "reserved" | "running" | "stopping" | "exited" | "interrupted";
	revision: number;
	createdAt: number;
	pid: number | null;
	ready: boolean | null;
	exitCode: number | null;
	signal: string | null;
	output: string;
	logTiming?: LogTiming;
	serviceLogs?: Record<string, ServiceLog>;
	error: string | null;
	runtimeStatus?: RuntimeStatus;
	runtimeStatuses?: RuntimeStatus[];
	inspection?: { confirmedAt: number; revision: number };
	idleReap?: IdleReap;
	cleanupRetention?: { blockedBy: string[] };
};
export const holdsResource = (run: EnvironmentRun) => run.state !== "exited";

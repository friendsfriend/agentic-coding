import { defineDoc } from "@earendil-works/pi-durable";
import type { Plan } from "./catalog.ts";
import type { RuntimeStatus } from "./process.ts";

export const EnvironmentState = defineDoc<{
	runs: Record<string, string>;
	stops: Record<string, string>;
}>({
	kind: "v2.environments",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {}, stops: {} }),
	checkpointWhen: () => true,
});
export type StopReceipt = {
	owner: number;
	apps: string[] | null;
	runs: string[];
	batches: string[];
	done: boolean;
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
	error: string | null;
	runtimeStatus?: RuntimeStatus;
	runtimeStatuses?: RuntimeStatus[];
	inspection?: { confirmedAt: number; revision: number };
};
export const holdsResource = (run: EnvironmentRun) => run.state !== "exited";

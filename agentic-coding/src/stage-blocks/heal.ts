// The bounded failure packet of a replay (`add-stage-flow-replay`, task 7).
// It names the failing block and sub-step and points at evidence; it never
// edits the block or spec.

import type { ReplayResult } from "../contracts/stage-replay.ts";
import type { FlowManifest } from "./flow.ts";
import type { StageBlockRegistry } from "./registry.ts";

export interface ReplayHealPacket {
	readonly version: 1;
	readonly flowId: string;
	readonly planId?: string;
	readonly revision?: number;
	readonly inputsHash: string;
	readonly routeStepId: string;
	readonly block: string;
	readonly blockVersion: string;
	readonly subStep?: string;
	readonly expected?: string;
	readonly observed?: string;
	readonly retryable: boolean;
	readonly evidenceIds: readonly string[];
	readonly journalIds?: readonly number[];
	readonly tracePath?: string;
	readonly scopedRegion?: Readonly<Record<string, unknown>>;
	readonly lastPassingStep?: string;
}

export function buildHealPacket(options: {
	readonly manifest: FlowManifest;
	readonly result: ReplayResult;
	readonly registry: StageBlockRegistry;
	readonly evidenceIds?: readonly string[];
	readonly journalIds?: readonly number[];
	readonly tracePath?: string;
	readonly scopedRegion?: Readonly<Record<string, unknown>>;
}): ReplayHealPacket | undefined {
	const failedIndex = options.result.steps.findIndex(
		(step) => step.status === "failed",
	);
	if (failedIndex < 0) return undefined;
	const failed = options.result.steps[failedIndex];
	if (failed === undefined) return undefined;
	const definition = options.registry.getVersion(failed.block, failed.version);
	const retryable =
		definition?.effects.every((effect) => effect === "read") === true &&
		definition.idempotent;
	const failedEvent = options.result.events?.find(
		(event) =>
			event.routeStepId === failed.routeStepId && event.status === "failed",
	);
	const lastPassing = [...options.result.steps]
		.reverse()
		.find((step) => step.status === "passed");
	return {
		version: 1,
		flowId: options.manifest.flowId,
		...(options.result.planId === undefined
			? {}
			: { planId: options.result.planId }),
		...(options.result.revision === undefined
			? {}
			: { revision: options.result.revision }),
		inputsHash: options.result.inputsHash,
		routeStepId: failed.routeStepId,
		block: failed.block,
		blockVersion: failed.version,
		...(failedEvent === undefined ? {} : { subStep: failedEvent.subStep }),
		...(failedEvent?.expected === undefined
			? {}
			: { expected: failedEvent.expected }),
		...(failedEvent?.observed === undefined
			? {}
			: { observed: failedEvent.observed }),
		retryable,
		evidenceIds: options.evidenceIds ?? failed.evidence ?? [],
		...(options.journalIds === undefined
			? {}
			: { journalIds: options.journalIds }),
		...(options.tracePath === undefined
			? {}
			: { tracePath: options.tracePath }),
		...(options.scopedRegion === undefined
			? {}
			: { scopedRegion: options.scopedRegion }),
		...(lastPassing === undefined
			? {}
			: { lastPassingStep: lastPassing.routeStepId }),
	};
}

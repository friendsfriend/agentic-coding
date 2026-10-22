// Deterministic mapping from a replay result to `core.stage-report@1`
// (`add-stage-flow-replay`, task 5). No page inspection and no model verdict:
// coverage comes from the approved plan's per-route expectation mapping.

import type { ReplayResult } from "../contracts/stage-replay.ts";
import type { FlowManifest } from "./flow.ts";

export interface ReplayReportPlan {
	readonly createsData?: boolean;
	readonly dataCreated?: readonly string[];
	readonly notTested?: readonly {
		readonly expectationId?: string;
		readonly reason: string;
	}[];
	readonly expectations: readonly {
		readonly id: string;
		readonly statement: string;
		readonly priority: "critical" | "high" | "medium" | "low";
	}[];
	readonly route: readonly {
		readonly id: string;
		readonly expectationIds?: readonly string[];
		/** Set when the plan states why a step has no block: the replay report
		 * repeats it so the step is accounted for. */
		readonly noBlockReason?: string;
	}[];
}

export interface ReplayStepFacts {
	readonly index: number;
	readonly journalIds: readonly number[];
	readonly evidenceIds: readonly string[];
}

export interface ReplayReport {
	/** The blocks the replay executed, one entry per route step. A replay report
	 * has to account for every planned route step exactly like a tester's report,
	 * or the report gate refuses it (`USAB-001`). */
	readonly blocksUsed: ReadonlyArray<{
		readonly routeStepId: string;
		readonly block: string;
		readonly version: string;
	}>;
	/** A planned route step the compiled flow does not execute. */
	readonly unblockedSteps: ReadonlyArray<{
		readonly routeStepId: string;
		readonly reason: string;
	}>;
	readonly blocksCreated: readonly [];
	readonly blocksAdjusted: readonly [];
	readonly expectations: ReadonlyArray<{
		readonly id: string;
		readonly verdict: "pass" | "fail" | "blocked" | "inconclusive";
		readonly severity: "critical" | "major" | "minor" | "info";
		readonly expected: string;
		readonly observed: string;
		readonly stepIds: readonly string[];
		readonly evidenceIds: readonly string[];
	}>;
	readonly applicationVersions: ReadonlyArray<{
		readonly application: string;
		readonly status: "unavailable";
		readonly reason: string;
	}>;
	readonly createdData: ReadonlyArray<{ readonly description: string }>;
	readonly knowledgeObservations: readonly [];
	readonly notTested: ReadonlyArray<{
		readonly expectationId?: string;
		readonly reason: string;
	}>;
}

function severityFor(
	priority: ReplayReportPlan["expectations"][number]["priority"],
): "critical" | "major" | "minor" | "info" {
	switch (priority) {
		case "critical":
			return "critical";
		case "high":
			return "major";
		case "medium":
			return "minor";
		case "low":
			return "info";
	}
}

function stepFor(
	result: ReplayResult,
	routeStepId: string,
): ReplayResult["steps"][number] | undefined {
	return result.steps.find((step) => step.routeStepId === routeStepId);
}

/** Map one replay result. A missing covering step is `inconclusive`; the caller
 * must not turn that into a pass. */
export function mapReplayToReport(
	manifest: FlowManifest,
	result: ReplayResult,
	plan: ReplayReportPlan,
	facts: readonly ReplayStepFacts[],
): { readonly report: ReplayReport; readonly complete: boolean } {
	let complete = true;
	const factsByIndex = new Map(facts.map((entry) => [entry.index, entry]));
	const report = plan.expectations.map((expectation) => {
		const covering = plan.route.filter((step) =>
			(step.expectationIds ?? []).includes(expectation.id),
		);
		if (covering.length === 0) {
			complete = false;
			return {
				id: expectation.id,
				verdict: "inconclusive" as const,
				severity: severityFor(expectation.priority),
				expected: expectation.statement,
				observed: "No replay route step maps this expectation.",
				stepIds: [],
				evidenceIds: [],
			};
		}
		const steps = covering
			.map((routeStep) => stepFor(result, routeStep.id))
			.filter(
				(step): step is ReplayResult["steps"][number] => step !== undefined,
			);
		if (steps.length !== covering.length) {
			complete = false;
			return {
				id: expectation.id,
				verdict: "inconclusive" as const,
				severity: severityFor(expectation.priority),
				expected: expectation.statement,
				observed: "A covering replay route step produced no result.",
				stepIds: covering.map((step) => step.id),
				evidenceIds: [],
			};
		}
		const evidenceIds = [
			...new Set(
				steps.flatMap((step) => {
					const found = factsByIndex.get(step.index);
					return found?.evidenceIds ?? [];
				}),
			),
		];
		const failure = steps.find((step) => step.status === "failed");
		if (failure !== undefined)
			return {
				id: expectation.id,
				verdict: "fail" as const,
				severity: severityFor(expectation.priority),
				expected: expectation.statement,
				observed: failure.error ?? "A covering replay step failed.",
				stepIds: covering.map((step) => step.id),
				evidenceIds,
			};
		const blocked = steps.find((step) => step.status === "skipped");
		if (blocked !== undefined) {
			complete = false;
			return {
				id: expectation.id,
				verdict: "blocked" as const,
				severity: severityFor(expectation.priority),
				expected: expectation.statement,
				observed:
					"A covering replay step was skipped after a dependency failure.",
				stepIds: covering.map((step) => step.id),
				evidenceIds,
			};
		}
		return {
			id: expectation.id,
			verdict: "pass" as const,
			severity: severityFor(expectation.priority),
			expected: expectation.statement,
			observed: `Replay passed: ${covering.map((step) => step.id).join(", ")}.`,
			stepIds: covering.map((step) => step.id),
			evidenceIds,
		};
	});
	const notTested = [...(plan.notTested ?? [])];
	for (const expectation of report)
		if (expectation.verdict === "inconclusive")
			notTested.push({
				expectationId: expectation.id,
				reason: expectation.observed,
			});
	const blocksUsed = result.steps.map((step) => ({
		routeStepId: step.routeStepId,
		block: step.block,
		version: step.version,
	}));
	const executed = new Set(blocksUsed.map((block) => block.routeStepId));
	const unblockedSteps = plan.route
		.filter((step) => !executed.has(step.id))
		.map((step) => ({
			routeStepId: step.id,
			reason:
				step.noBlockReason === undefined || step.noBlockReason.trim() === ""
					? "the compiled flow has no step for this route step"
					: step.noBlockReason,
		}));
	return {
		report: {
			blocksUsed,
			unblockedSteps,
			// A replay neither authors nor adjusts a block; it runs what review
			// already approved.
			blocksCreated: [],
			blocksAdjusted: [],
			expectations: report,
			applicationVersions: manifest.applications.map((application) => ({
				application,
				status: "unavailable" as const,
				reason: "Replay does not query application versions.",
			})),
			createdData: plan.createsData
				? (plan.dataCreated ?? []).map((description) => ({ description }))
				: [],
			knowledgeObservations: [],
			notTested,
		},
		complete,
	};
}

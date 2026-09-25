/** Deterministic dashboard projections: typed workflow states, observations,
 * and artifact results in, display data out. No filesystem, Git, Herdr,
 * database, network, timer, or ambient-clock access — callers supply every
 * external value (including explicit `now` arguments) and keep all I/O in
 * `observations.ts`. */

import type { RequiredUserAction } from "../../contracts/actions.ts";
import type {
	AgentUsageMetrics,
	WorkflowState,
} from "../../contracts/workflow";
import { formatDuration } from "../../workflow/format.ts";

export function phaseAgeHours(
	state: { phase: string; phaseStartedAt?: string; createdAt?: string },
	now: number,
): number {
	const at = state.phaseStartedAt ?? state.createdAt;
	if (!at) return 0;
	const age = (now - Date.parse(at)) / 3_600_000;
	return Math.max(0, Math.floor(age));
}

const COMPLETED_ACTION_LABELS: Record<string, string> = {
	"create-pr": "Create MR/PR",
	close: "Close Herdr workspace",
};

export function requiredUserActionFor(
	phase: string,
	prCreated = false,
	_artifacts: string[] = [],
	definitionId?: string,
	/** The engine view's available actions for the current step. `undefined`
	 * means no view carries this information at all (this dashboard's demo
	 * fixture, or a pre-engine store) and the legacy phase-derived set below
	 * applies. A present-but-empty array is authoritative and renders no
	 * action. */
	actions?: Array<{ id: string; label: string; confirmation: string }>,
): RequiredUserAction | undefined {
	const later = { label: "Not now", kind: "dismiss" } as const;
	if (actions !== undefined && actions.length === 0) return undefined;
	const hasAction = (id: string) =>
		actions === undefined || actions.some((action) => action.id === id);

	if (phase === "proposed" || phase === "core.plan-approval") {
		if (!hasAction("approve-plan")) return undefined;
		const proposal =
			definitionId === "openspec-propose" ||
			definitionId === "openspec-fusion-propose";
		return {
			key: "plan-review",
			title: "Action required · Plan review",
			prompt: proposal
				? "Review the OpenSpec artifacts before completing the proposal."
				: "Review the OpenSpec artifacts before the worker starts.",
			// Trigger-only: the action opens the plan review popup (artifact list)
			// directly, so there are no selectable items to render in the generic
			// ListViewModal.
			items: [],
		};
	}
	if (phase === "wiki-approval" || phase === "core.wiki-approval") {
		if (!hasAction("approve-wiki")) return undefined;
		return {
			key: "wiki-review",
			title: "Action required · Wiki review",
			prompt:
				definitionId === "wiki"
					? "Review knowledge changes before completion."
					: definitionId === "research"
						? "Review knowledge changes before closing research."
						: "Review knowledge changes before archival.",
			// Trigger-only: the action opens the wiki review popup (drafted-concept
			// list + markdown view + comment/approve/request-changes) directly, so
			// there are no selectable items to render in the generic ListViewModal.
			items: [],
		};
	}
	if (phase === "developer-review" || phase === "core.developer-review") {
		if (!hasAction("approve-review")) return undefined;
		return {
			// Stable key independent of legacy vs engine (`core.*`) phase naming,
			// so App.tsx's direct-open matching fires for both.
			key: "developer-review",
			title: "Action required · Developer review",
			prompt: "Review changed files before workflow continues.",
			// Trigger-only: the action opens the changed-files popup directly, so
			// there are no selectable items to render in the generic ListViewModal.
			items: [],
		};
	}
	if (phase === "completed" || phase === "core.completed") {
		if (actions !== undefined) {
			// Availability comes entirely from the engine's action list: whatever
			// it reports (create-pr present or absent, per its close-only manifest
			// policy and whether a pull request already exists) is exactly what
			// renders, with no separate dashboard allowlist.
			const hasCreatePr = actions.some((action) => action.id === "create-pr");
			return {
				key: `${phase}:${hasCreatePr ? "pr-available" : "closed"}`,
				title: "Action required · Workflow complete",
				prompt: hasCreatePr
					? "Create MR/PR or close workspace."
					: "Close workspace when finished.",
				items: [
					...actions.map((action) => ({
						label: COMPLETED_ACTION_LABELS[action.id] ?? action.label,
						kind: "workflow" as const,
						value: action.id,
					})),
					later,
				],
			};
		}
		// Legacy fallback: no `actions` array at all, so there is no engine data
		// to consult. Derives close-only the pre-engine way.
		const proposal =
			definitionId === "openspec-propose" ||
			definitionId === "openspec-fusion-propose";
		const wikiOnly = definitionId === "wiki" || definitionId === "research";
		const closeOnly = proposal || wikiOnly;
		return {
			key: `${phase}:${closeOnly ? "proposal" : prCreated ? "pr-created" : "no-pr"}`,
			title: "Action required · Workflow complete",
			prompt: closeOnly
				? "Close workflow when finished."
				: prCreated
					? "Close workspace when finished."
					: "Create MR/PR or close workspace.",
			items: [
				...(!closeOnly && !prCreated
					? [
							{
								label: "Create MR/PR",
								kind: "workflow" as const,
								value: "create-pr",
							},
						]
					: []),
				{
					label: "Close Herdr workspace",
					kind: "workflow",
					value: "close",
				},
				later,
			],
		};
	}
	return undefined;
}

export function approvalFor(phase: string) {
	return (
		{
			proposed: {
				prompt: "Press Enter to approve plan",
				action: "approve-plan",
			},
			fix: { prompt: "Press Enter to retry verification", action: "verify" },
			"developer-review": {
				prompt: "Press Enter to review changed files",
				action: "review",
			},
			archive: {
				prompt: "Press Enter to advance archive",
				action: "archive",
			},
			committing: {
				prompt: "Press Enter to complete committing",
				action: "archive",
			},
		} as Record<string, { prompt: string; action: string }>
	)[phase];
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/** Compose the presentation-only runtime/model label used in agent rows. */
export function agentRuntimeModelLine(
	runtime: string | undefined,
	model: string | undefined,
): string | undefined {
	const runtimeLabel = runtime
		? runtime === "opencode-v2"
			? "opencode2"
			: runtime
		: undefined;
	return runtimeLabel && model
		? `${runtimeLabel} · ${model}`
		: runtimeLabel || model || undefined;
}

/** One compact, fixed-order metric line per agent: cost, tokens in→out, cache
 * hit rate (cache-read / total prompt input), duration, tokens/s. Undefined when
 * the role recorded no metrics so the panel can omit the line entirely instead
 * of showing zero placeholders that could be mistaken for measured values. */
export function agentMetricLine(
	metrics: AgentUsageMetrics | undefined,
): string | undefined {
	if (!metrics) return undefined;
	const inputTokens = metrics.inputTokens;
	const cacheReadTokens = metrics.cacheReadTokens;
	const cacheWriteTokens = metrics.cacheWriteTokens;
	let cacheRate: number | undefined;
	if (
		inputTokens !== undefined &&
		cacheReadTokens !== undefined &&
		cacheWriteTokens !== undefined &&
		Number.isFinite(inputTokens) &&
		Number.isFinite(cacheReadTokens) &&
		Number.isFinite(cacheWriteTokens) &&
		inputTokens >= 0 &&
		cacheReadTokens >= 0 &&
		cacheWriteTokens >= 0
	) {
		const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		if (Number.isFinite(totalPromptTokens) && totalPromptTokens > 0) {
			const calculatedRate = (cacheReadTokens / totalPromptTokens) * 100;
			if (
				Number.isFinite(calculatedRate) &&
				calculatedRate >= 0 &&
				calculatedRate <= 100
			)
				cacheRate = Math.min(100, Math.max(0, calculatedRate));
		}
	}
	const parts = [
		...(metrics.cost !== undefined ? [`$${metrics.cost.toFixed(2)}`] : []),
		...(metrics.inputTokens !== undefined || metrics.outputTokens !== undefined
			? [
					`tok ${formatTokens(inputTokens ?? 0)}→${formatTokens(metrics.outputTokens ?? 0)}`,
				]
			: []),
		...(cacheRate !== undefined
			? [
					`${(cacheRate === 100 ? cacheRate : Math.floor(cacheRate * 10) / 10).toFixed(1)}%`,
				]
			: []),
		...(metrics.durationSeconds !== undefined
			? [formatDuration(metrics.durationSeconds)]
			: []),
		...(metrics.tokensPerSecond !== undefined
			? [`${metrics.tokensPerSecond} tok/s`]
			: []),
	];
	return parts.length > 0 ? parts.join(" · ") : undefined;
}
export type PhaseStatusState = Pick<
	WorkflowState,
	"phase" | "stepId" | "stepLabel" | "status"
> & {
	runs: Array<Pick<WorkflowState["runs"][number], "stepId" | "status">>;
};

export function phaseStatus(state: PhaseStatusState) {
	const text = state.stepLabel ?? state.phase;
	const terminal = ["completed", "closed"].includes(state.status);
	const blocked =
		state.status === "attention-required" &&
		state.stepId !== undefined &&
		state.runs.some(
			(run) => run.stepId === state.stepId && run.status === "blocked",
		);
	return { text, working: !terminal, blocked };
}

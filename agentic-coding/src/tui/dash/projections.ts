/** Deterministic dashboard projections: typed workflow states, observations,
 * and artifact results in, display data out. No filesystem, Git, Herdr,
 * database, network, timer, or ambient-clock access — callers supply every
 * external value (including explicit `now` arguments) and keep all I/O in
 * `observations.ts`. */
import { formatDuration } from "../../workflow/format";
import type {
	AgentUsageMetrics,
	CostMessage,
	CostRow,
	FindingCounts,
	RequiredUserAction,
	VerifierFinding,
	WorkflowState,
} from "./types";
export const USAGE_EVENT_NAMES = new Set(["runtime.usage", "model_usage"]);

/** Telemetry events that open/close an agent's active turn. `runtime.*` is the
 * current pi bridge naming; `pi_agent_*` is kept for older telemetry files. */
export const ACTIVE_START_EVENT_NAMES = new Set([
	"runtime.started",
	"pi_agent_start",
]);
export const ACTIVE_END_EVENT_NAMES = new Set([
	"runtime.settled",
	"pi_agent_end",
	"pi_agent_settled",
]);

function isUsageEvent(event: Record<string, unknown>): boolean {
	return USAGE_EVENT_NAMES.has(String(event.event));
}

interface MetricAccumulator extends AgentUsageMetrics {
	generationMs?: number;
	firstAt?: number;
	lastAt?: number;
	hasUsage?: boolean;
	cacheInputsComplete?: boolean;
	activeBoundaries?: Array<{ at: number; start: boolean }>;
}

/** Sum the agent's active turn intervals, excluding the idle gaps between them.
 * A turn opens on `runtime.started`/`pi_agent_start` and closes on the next
 * `runtime.settled`/`pi_agent_end`/`pi_agent_settled`; a turn still in flight
 * closes at the role's last observed event. Falls back to the wall-clock
 * first→last span when the role recorded no lifecycle boundaries at all. */
function activeDurationSeconds(
	boundaries: Array<{ at: number; start: boolean }>,
	fallbackSeconds: number | undefined,
	lastAt: number | undefined,
): number | undefined {
	if (boundaries.length === 0) return fallbackSeconds;
	let openAt: number | undefined;
	let totalMs = 0;
	for (const boundary of [...boundaries].sort((a, b) => a.at - b.at)) {
		if (boundary.start) {
			if (openAt === undefined) openAt = boundary.at;
			continue;
		}
		if (openAt === undefined) continue;
		totalMs += Math.max(0, boundary.at - openAt);
		openAt = undefined;
	}
	if (openAt !== undefined) totalMs += Math.max(0, (lastAt ?? openAt) - openAt);
	return Math.max(0, Math.round(totalMs / 1000));
}

/** Aggregate per-role agent metrics from a workflow's telemetry events:
 * summed cost/tokens/cache-read from usage events, active runtime from the
 * role's lifecycle turns (idle gaps between turns excluded), and output tokens
 * per second preferring summed per-message generation time over the wall-clock
 * span. Roles without any metric are omitted from the result. */
export function agentMetrics(
	events: Array<Record<string, unknown>>,
): Map<string, AgentUsageMetrics> {
	const byRole = new Map<string, MetricAccumulator>();
	for (const event of events) {
		const role = event.role;
		if (typeof role !== "string") continue;
		const row = byRole.get(role) ?? {};
		byRole.set(role, row);
		const at = Date.parse(String(event.at ?? ""));
		if (Number.isFinite(at)) {
			row.firstAt = row.firstAt === undefined ? at : Math.min(row.firstAt, at);
			row.lastAt = row.lastAt === undefined ? at : Math.max(row.lastAt, at);
			const name = String(event.event ?? "");
			if (
				ACTIVE_START_EVENT_NAMES.has(name) ||
				ACTIVE_END_EVENT_NAMES.has(name)
			) {
				if (!row.activeBoundaries) row.activeBoundaries = [];
				row.activeBoundaries.push({
					at,
					start: ACTIVE_START_EVENT_NAMES.has(name),
				});
			}
		}
		if (!isUsageEvent(event)) continue;
		const cacheInputsComplete = [
			"inputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		].every((field) => {
			const value = event[field];
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		});
		row.cacheInputsComplete =
			(row.cacheInputsComplete ?? true) && cacheInputsComplete;
		for (const field of [
			"cost",
			"inputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		] as const) {
			const value = event[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
				continue;
			row[field] = (row[field] ?? 0) + value;
			row.hasUsage = true;
		}
		const durationMs = event.durationMs;
		if (
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs > 0
		)
			row.generationMs = (row.generationMs ?? 0) + durationMs;
	}
	const result = new Map<string, AgentUsageMetrics>();
	for (const [role, row] of byRole) {
		const wallClockSeconds =
			row.firstAt !== undefined &&
			row.lastAt !== undefined &&
			row.lastAt > row.firstAt
				? Math.max(0, Math.round((row.lastAt - row.firstAt) / 1000))
				: undefined;
		const durationSeconds = activeDurationSeconds(
			row.activeBoundaries ?? [],
			wallClockSeconds,
			row.lastAt,
		);
		const outputTokens = row.outputTokens ?? 0;
		const generationSeconds = (row.generationMs ?? 0) / 1000;
		const tokensPerSecond =
			outputTokens > 0 && generationSeconds > 0
				? Math.round((outputTokens / generationSeconds) * 10) / 10
				: undefined;
		if (!row.hasUsage && durationSeconds === undefined) continue;
		result.set(role, {
			...(row.cost !== undefined ? { cost: row.cost } : {}),
			...(row.inputTokens !== undefined
				? { inputTokens: row.inputTokens }
				: {}),
			...(row.outputTokens !== undefined
				? { outputTokens: row.outputTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheReadTokens !== undefined
				? { cacheReadTokens: row.cacheReadTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheWriteTokens !== undefined
				? { cacheWriteTokens: row.cacheWriteTokens }
				: {}),
			...(durationSeconds !== undefined ? { durationSeconds } : {}),
			...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
		});
	}
	return result;
}

/** Per-role lifetime cost from model_usage rows (one per assistant message).
 * Accepts both `runtime.usage` and legacy `model_usage` event names. */
export function costSummary(events: Array<Record<string, unknown>>): CostRow[] {
	const byRole = new Map<string, CostRow>();
	for (const event of events) {
		const role = event.role;
		if (!isUsageEvent(event) || typeof role !== "string") continue;
		const row = byRole.get(role) ?? {
			role,
			messages: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cost: 0,
		};
		row.messages += 1;
		row.inputTokens += Number(event.inputTokens ?? 0);
		row.outputTokens += Number(event.outputTokens ?? 0);
		row.totalTokens += Number(event.totalTokens ?? 0);
		row.cost += Number(event.cost ?? 0);
		byRole.set(role, row);
	}
	return [...byRole.values()].sort((a, b) => b.cost - a.cost);
}

/** Per-message cost rows for one role, oldest first. */
export function costMessages(
	events: Array<Record<string, unknown>>,
	role: string,
): CostMessage[] {
	return events
		.filter((event) => isUsageEvent(event) && event.role === role)
		.sort((a, b) => String(a.at).localeCompare(String(b.at)))
		.map((event) => ({
			at: String(event.at ?? ""),
			inputTokens: Number(event.inputTokens ?? 0),
			outputTokens: Number(event.outputTokens ?? 0),
			totalTokens: Number(event.totalTokens ?? 0),
			cost: Number(event.cost ?? 0),
		}));
}

export function phaseAgeHours(
	state: { phase: string; phaseStartedAt?: string; createdAt?: string },
	now: number,
): number {
	const at = state.phaseStartedAt ?? state.createdAt;
	if (!at) return 0;
	const age = (now - Date.parse(at)) / 3_600_000;
	return Math.max(0, Math.floor(age));
}

/** True when a workflow has sat in a non-terminal phase longer than the threshold. */
export function isStale(
	state: {
		phase: string;
		status?: string;
		phaseStartedAt?: string;
		createdAt?: string;
	},
	now: number,
	thresholdHours = 6,
): boolean {
	if (state.status === "completed" || state.status === "closed") return false;
	const at = state.phaseStartedAt ?? state.createdAt;
	if (!at) return false;
	return (now - Date.parse(at)) / 3_600_000 > thresholdHours;
}
export function countVerifierFindings(
	findings: Array<Pick<VerifierFinding, "severity">>,
): FindingCounts {
	const counts: FindingCounts = { critical: 0, warning: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return counts;
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
	if (phase === "research" || phase === "core.research") {
		if (!hasAction("close-research")) return undefined;
		return {
			key: "research",
			title: "Research active",
			prompt:
				"Ask follow-ups in the researcher session, or close research when finished. The researcher itself starts wiki drafting when the user explicitly requests it.",
			items: [
				...(hasAction("research-follow-up")
					? [
							{
								label: "Ask researcher",
								kind: "workflow" as const,
								value: "research-follow-up",
							},
						]
					: []),
				{
					label: "Close research",
					kind: "workflow",
					value: "close-research",
				},
				later,
			],
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

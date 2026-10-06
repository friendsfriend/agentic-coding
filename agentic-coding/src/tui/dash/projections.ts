/** Deterministic dashboard projections: typed workflow states, observations,
 * and artifact results in, display data out. No filesystem, Git, Herdr,
 * database, network, timer, or ambient-clock access — callers supply every
 * external value (including explicit `now` arguments) and keep all I/O in
 * `observations.ts`. */

import type { RequiredUserAction } from "../../contracts/actions.ts";
import type {
	AgentUsageMetrics,
	ClassifierDecisionRecord,
	GateDecisionRecord,
	WorkflowState,
} from "../../contracts/workflow";
import { formatDuration } from "../../workflow/format.ts";

/** One classification the engine recorded, in either of the two histories it
 * keeps: a classifier question (model-pool routing, verifier-role triage, the
 * per-file judgment sweep) or a stage-gate verdict. */
export type ClassificationEntry =
	| { readonly kind: "classifier"; readonly record: ClassifierDecisionRecord }
	| { readonly kind: "gate"; readonly record: GateDecisionRecord };

/** How each classifier integration reads in a one-line row. The ids are the
 * engine's own vocabulary; the panel shows what the classification was for. */
const INTEGRATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
	routing: "routing",
	triage: "verifier roles",
	"file-judgment": "file sweep",
});

/** The outcome half of a classifier row, per integration. A `noul` question
 * resolves no profile pool, so routing's "applied profiles" would read as
 * "applied none" on a role decision that did select a role. */
function classifierOutcome(decision: ClassifierDecisionRecord): string {
	const profiles = decision.result.profiles.join(", ") || "none";
	if (decision.integration === "triage")
		return decision.result.applied ? `selected ${profiles}` : "not selected";
	// A sweep answers once per file, so its counts are its outcome.
	if (decision.integration === "file-judgment")
		return decision.result.attention ?? "no bands reported";
	return decision.result.applied ? `applied ${profiles}` : `kept ${profiles}`;
}

/** Every classification a workflow made, oldest first. Two append-only
 * histories in, one ordered list out: both carry an ISO timestamp and a unique
 * id, so the order is total and a dashboard refresh cannot reshuffle rows. */
export function classificationEntries(state: {
	readonly classifierDecisions?: readonly ClassifierDecisionRecord[];
	readonly gateDecisions?: readonly GateDecisionRecord[];
}): ClassificationEntry[] {
	const entries: ClassificationEntry[] = [
		...(state.classifierDecisions ?? []).map((record) => ({
			kind: "classifier" as const,
			record,
		})),
		...(state.gateDecisions ?? []).map((record) => ({
			kind: "gate" as const,
			record,
		})),
	];
	return entries.sort(
		(a, b) =>
			a.record.at.localeCompare(b.record.at) ||
			a.record.id.localeCompare(b.record.id),
	);
}

/** The panel's one line per classification. */
export function classificationRows(
	entries: readonly ClassificationEntry[],
): string[] {
	return entries.map((entry) =>
		entry.kind === "gate"
			? gateDecisionRow(entry.record)
			: [
					INTEGRATION_LABELS[entry.record.integration] ??
						entry.record.integration,
					entry.record.questionId,
					classifierOutcome(entry.record),
				].join(" · "),
	);
}

function gateDecisionRow(decision: GateDecisionRecord): string {
	const parts = [
		"stage gate",
		decision.stage,
		decision.decision === "skip" ? "skipped" : "runs",
		`policy ${decision.policy}`,
	];
	if (decision.decision === "skip")
		parts.push(
			decision.noul === undefined
				? "necessity unknown"
				: `necessity ${decision.noul}`,
		);
	return parts.join(" · ");
}

/** The detail a selected classification opens. */
export function classificationDetail(entry: ClassificationEntry): {
	title: string;
	content: string;
} {
	return entry.kind === "gate"
		? gateDecisionDetail(entry.record)
		: classifierDecisionDetail(entry.record);
}

/** A gate verdict is a different record from a classifier question, so it
 * reads as what it is: a stage, a policy, and what was decided with it. */
export function gateDecisionDetail(decision: GateDecisionRecord): {
	title: string;
	content: string;
} {
	return {
		title: `Stage gate · ${decision.stage}`,
		content: [
			"## Decision",
			`- **Stage:** ${decision.stage}`,
			`- **Step:** ${decision.stepId}`,
			`- **Policy:** ${decision.policy}`,
			`- **Decision:** ${decision.decision === "skip" ? "skipped" : "runs"}`,
			`- **Forced:** ${decision.forced ? "yes" : "no"}`,
			`- **Necessity:** ${decision.noul ?? "not answered"}`,
			...(decision.reason ? [`- **Reason:** ${decision.reason}`] : []),
			`- **Recorded:** ${decision.at}`,
			"",
			"> A forced decision ran its stage without asking the classifier: the",
			"> policy was always, or the answer could not be obtained.",
		].join("\n"),
	};
}

export function classifierDecisionRows(
	decisions: readonly ClassifierDecisionRecord[],
): string[] {
	return decisions.map((decision) =>
		[
			INTEGRATION_LABELS[decision.integration] ?? decision.integration,
			decision.questionId,
			classifierOutcome(decision),
		].join(" · "),
	);
}

/** A necessity answer: the value, or the fact that the question went
 * unanswered. An unanswered question is never a zero, so the distinction is
 * rendered rather than defaulted. What the value decided is already carried by
 * the record's applied result. */
function noulLine(answer: ClassifierDecisionRecord["answer"]): string[] {
	return [
		answer.noul === undefined
			? "Necessity: not answered"
			: `Necessity: ${answer.noul}`,
	];
}

/** The per-file judgment sweep answers once per candidate file, so its verdict
 * is a band per path rather than a pool of options: it gets its own table
 * instead of a routing option table that would read as nonsense. */
function fileJudgmentDetail(decision: ClassifierDecisionRecord): {
	title: string;
	content: string;
} {
	const escapeCell = (value: string) => value.replaceAll("|", "\\|");
	const rows = decision.options.map(
		(option) =>
			`| ${escapeCell(option.label)} | ${escapeCell(option.profile)} | ${
				option.criteria === undefined ? "—" : option.criteria
			} |`,
	);
	return {
		title: `File sweep · ${decision.questionId}`,
		content: [
			"## Coverage",
			`- **Coverage:** ${decision.result.attention ?? "not reported"}`,
			`- **Applied:** ${decision.result.applied ? "yes" : "no"}`,
			`- **Model:** ${decision.model}`,
			`- **Recorded:** ${decision.at}`,
			"",
			"## Flagged and ambiguous files",
			"| File | Band | Necessity |",
			"| --- | --- | ---: |",
			...(rows.length ? rows : ["| — | — | — |"]),
			"",
			"> Files in neither band were cleared, and files that were never judged",
			"> are listed in the sweep's artifact. A verdict is not evidence: read the",
			"> repository and the assigned artifacts before reporting a finding.",
		].join("\n"),
	};
}

export function classifierDecisionDetail(decision: ClassifierDecisionRecord): {
	title: string;
	content: string;
} {
	if (decision.integration === "file-judgment")
		return fileJudgmentDetail(decision);
	const answer = decision.answer;
	const escapeCell = (value: string) => value.replaceAll("|", "\\|");
	const criteria = (value: unknown) =>
		value === undefined
			? "—"
			: escapeCell(typeof value === "string" ? value : JSON.stringify(value));
	const optionRows = decision.options.map((option) => {
		const probability =
			answer.type === "choice"
				? answer.probabilities?.[option.label]
				: undefined;
		return `| ${escapeCell(option.label)} | ${escapeCell(option.profile)} | ${answer.type === "choice" && answer.choice === option.label ? "yes" : ""} | ${probability === undefined ? "—" : probability} | ${criteria(option.criteria)} |`;
	});
	const fence = "`".repeat(
		Math.max(
			3,
			...[...decision.input.matchAll(/`+/g)].map(
				(match) => match[0].length + 1,
			),
		),
	);
	return {
		title: `Classifier · ${INTEGRATION_LABELS[decision.integration] ?? decision.integration} · ${decision.questionId}`,
		content: [
			"## Decision",
			`- **Integration:** ${decision.integration} (${INTEGRATION_LABELS[decision.integration] ?? "unknown integration"})`,
			...(decision.phase ? [`- **Phase:** ${decision.phase}`] : []),
			`- **Question:** ${decision.questionId}`,
			`- **Model:** ${decision.model}`,
			`- **Recorded:** ${decision.at}`,
			"",
			"## Options and answer",
			...(decision.options.length
				? [
						"| Option | Profile | Chosen | Probability | Criteria |",
						"| --- | --- | --- | ---: | --- |",
						...optionRows,
						"",
					]
				: [
						"This integration resolves no profile pool; it asks one question.",
						"",
					]),
			...(answer.type === "choice"
				? [
						`Choice: ${answer.choice ?? "none"}`,
						`Confidence: ${answer.confidence ?? "not provided"}`,
					]
				: noulLine(answer)),
			"",
			"## Applied result",
			`- **Applied:** ${decision.result.applied ? "yes" : "no"}`,
			`- **Selected:** ${decision.result.profiles.join(", ") || "none"}`,
			...(decision.result.attention
				? [`- **Attention:** ${decision.result.attention}`]
				: []),
			...(decision.inputTruncated
				? ["", "> Stored classifier input was truncated."]
				: []),
			"",
			"## Classifier input",
			fence,
			decision.input,
			fence,
		].join("\n"),
	};
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
	// The verify-only family's findings review is the same popup and the same
	// dispatch as the developer review, over the round's findings (critical ones
	// included): one `developer-review` key, so the direct-open matching and the
	// review surface's own phase check keep working unchanged.
	if (phase === "core.findings-review") {
		if (!hasAction("approve-review")) return undefined;
		return {
			key: "developer-review",
			title: "Action required · Findings review",
			prompt:
				"Review the verification findings and select the ones a worker should fix.",
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
	// The shimmer is an aurora timeline, and a playing timeline keeps OpenTUI's
	// render loop live: a shimmer that outlived its work held a dashboard at
	// ~28 fps (measured 4-5% CPU per process) for as long as the badge stayed on
	// screen. So it means "a run for this step is actually in flight" — plus an
	// active workflow, which is being driven even between run rows. A parked or
	// paused workflow (attention-required with settled runs) has nothing running
	// and must not animate.
	const working =
		state.status === "active" ||
		state.runs.some(
			(run) =>
				run.stepId === state.stepId &&
				["pending", "working"].includes(run.status),
		);
	const blocked =
		state.status === "attention-required" &&
		state.stepId !== undefined &&
		state.runs.some(
			(run) => run.stepId === state.stepId && run.status === "blocked",
		);
	return { text, working, blocked };
}

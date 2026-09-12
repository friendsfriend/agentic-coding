// Pure Herdr sidebar projection (improve-herdr-workflow-sidebar).
//
// Turns the typed workflow views plus separately supplied live Herdr
// observations into display-only card text and a machine-readable input rank.
// No TUI imports, clock reads, or I/O belong here — the caller supplies the
// current time, the observations, and the target classification, and the
// publication adapters (sidebar-sync.ts) own every write.
import type { WorkflowView } from "./contracts.ts";

/** Metadata source id. Owns every `ac_` token; nothing else may clear them. */
export const SIDEBAR_SOURCE = "agentic-coding";
/** The transient native Agents view this integration installs. */
export const SIDEBAR_VIEW_ID = "agentic-coding-sidebar";
export const SIDEBAR_VIEW_LABEL = "input first";

/** Herdr truncates metadata values; bound display text well below that. */
export const SIDEBAR_TOKEN_LIMIT = 80;

/** The marker is a plain text-presentation glyph followed by one space, so
 * both states occupy the same terminal-cell slot and the project text never
 * moves when attention toggles. No emoji variation selector. */
export const SIDEBAR_INPUT_GLYPH = "◆";
export const SIDEBAR_IDLE_GLYPH = "◇";
export const SIDEBAR_TREE_WORKFLOW = "├─";
export const SIDEBAR_TREE_LAST = "└─";
export const SIDEBAR_TREE_CONTINUATION = "│";

/** Workspace (Space) card tokens, one display token per configured row. */
export const SIDEBAR_WORKSPACE_TOKENS = {
	project: "ac_project_line",
	workflow: "ac_workflow_line",
	kind: "ac_type_line",
	phase: "ac_phase_line",
} as const;
/** Pane (Agent) card tokens. */
export const SIDEBAR_PANE_TOKENS = {
	project: "ac_project_line",
	workflow: "ac_workflow_line",
	role: "ac_role_line",
	status: "ac_status_line",
	rank: "ac_input_rank",
} as const;

/** Sort ranks: confirmed/retained input first, unknown next, fresh no-input last. */
export const INPUT_RANK_REQUIRED = "2";
export const INPUT_RANK_UNKNOWN = "1";
export const INPUT_RANK_NONE = "0";

export type InputRank =
	| typeof INPUT_RANK_REQUIRED
	| typeof INPUT_RANK_UNKNOWN
	| typeof INPUT_RANK_NONE;

export const SIDEBAR_ALL_WORKSPACE_TOKENS: readonly string[] = Object.values(
	SIDEBAR_WORKSPACE_TOKENS,
);
export const SIDEBAR_ALL_PANE_TOKENS: readonly string[] = [
	...Object.values(SIDEBAR_PANE_TOKENS),
];

/** Live runtime observation of one Herdr pane, as read by the caller. */
export interface SidebarObservation {
	paneId: string;
	/** `unknown` covers both "not an agent" and "Herdr could not tell". */
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	/** False when the read failed or returned no evidence for this pane. */
	fresh: boolean;
}

/** One unmanaged (no workflow association) Herdr pane. */
export interface UnmanagedPane {
	paneId: string;
	workspaceId: string;
	label: string;
	status: string;
	/** Native tab label, shown on the second row when Herdr reports one. */
	tabLabel?: string;
}

/** One unmanaged (no workflow association) Herdr space. */
export interface UnmanagedWorkspace {
	workspaceId: string;
	label: string;
	/** Live agent state of the space, when Herdr reports one. */
	status?: string;
}

/** Standalone (repository-independent) target labels, resolved by the caller
 * from the existing target classification. */
export interface SidebarTargetClassification {
	workflowId: string;
	label: "Research" | "Wiki";
}

export interface SidebarPaneCard {
	paneId: string;
	tokens: Record<string, string>;
}

export interface SidebarWorkspaceCard {
	workspaceId: string;
	tokens: Record<string, string>;
}

/** A pane/workspace that previously carried managed tokens but no longer does. */
export interface SidebarClear {
	targetId: string;
	tokens: readonly string[];
}

export interface SidebarPublication {
	panes: SidebarPaneCard[];
	workspaces: SidebarWorkspaceCard[];
	/** Managed targets that dropped out of the managed set this refresh. */
	clearedPanes: SidebarClear[];
	clearedWorkspaces: SidebarClear[];
}

export interface SidebarProjectionInput {
	views: readonly WorkflowView[];
	observations: readonly SidebarObservation[];
	unmanagedPanes: readonly UnmanagedPane[];
	unmanagedWorkspaces?: readonly UnmanagedWorkspace[];
	/** Herdr's live pane ids for this read. When supplied, a managed run whose
	 * pane no longer exists is skipped instead of publishing (or clearing) a
	 * card for a vanished target. */
	livePaneIds?: readonly string[];
	/** Herdr's live workspace ids for this read; same skip rule as panes. */
	liveWorkspaceIds?: readonly string[];
	/** Repository-independent target labels; absent means none. */
	standalone?: readonly SidebarTargetClassification[];
	/** Ids that carried managed tokens on the previous publication. */
	managedPaneIds?: readonly string[];
	managedWorkspaceIds?: readonly string[];
	/** Panes that already owed runtime input before this read; a failed read
	 * must not downgrade them to "no known input". */
	retainedRequiredPanes?: readonly string[];
}

/** Bounded, single-line display text: control characters (C0/C1, DEL)
 * become spaces, and the value is clamped to the token limit.
 * Canonical identities are never derived from the truncated text. */
export function sidebarText(
	value: string,
	limit = SIDEBAR_TOKEN_LIMIT,
): string {
	const cleaned = value
		// biome-ignore lint/suspicious/noControlCharactersInRegex: display text must never carry terminal control sequences
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.trim();
	// Internal spaces survive verbatim so the tree rows keep their alignment.
	return cleaned.length > limit ? cleaned.slice(0, limit).trimEnd() : cleaned;
}

/** Canonical repository basename: the project identity for a card. The linked
 * worktree basename is never used. */
export function repositoryBasename(repository: string): string {
	const parts = repository.split(/[\\/]+/).filter(Boolean);
	return parts.at(-1) ?? "";
}

/** The project label for one workflow: canonical repository basename, the
 * existing repository-independent target classification, or the worktree
 * basename as a last resort. Never invents a project from display text. */
export function projectLabel(
	view: WorkflowView,
	standalone: readonly SidebarTargetClassification[] = [],
): string {
	const classified = standalone.find(
		(entry) => entry.workflowId === view.workflowId,
	);
	if (classified) return classified.label;
	const repository = repositoryBasename(view.repository);
	if (repository) return repository;
	const worktree = repositoryBasename(view.worktree);
	return worktree || "Unassigned";
}

function marker(owed: boolean): string {
	return owed ? SIDEBAR_INPUT_GLYPH : SIDEBAR_IDLE_GLYPH;
}

function projectLine(label: string, owed: boolean): string {
	return sidebarText(`${marker(owed)} ${label}`);
}

/** A workflow card owes input when a registered blocking gate is available,
 * when committed state requires operator intervention, or when any associated
 * agent has its own requirement. Optional actions never mark it. */
export function workflowRequiresInput(
	view: WorkflowView,
	agentRequiresInput: boolean,
): boolean {
	if (agentRequiresInput) return true;
	if (view.status === "paused" || view.status === "attention-required")
		return true;
	return view.availableActions.some((action) => action.requiresInput === true);
}

/** The run currently associated with a persistent pane: later runs win, so a
 * historical run can never overwrite the card of its successor. */
export function currentRunForPane<T extends { id: string; paneId?: string }>(
	runs: readonly T[],
	paneId: string,
): T | undefined {
	let current: T | undefined;
	for (const run of runs) if (run.paneId === paneId) current = run;
	return current;
}

/** Confirmed developer input is owed for this exact run: an unexpired pending
 * developer question recorded by it. Peer consultations are already excluded
 * from `pendingQuestions`, and questions of other (historical) runs never
 * apply. */
export function runRequiresDeveloperInput(
	view: WorkflowView,
	runId: string,
): boolean {
	return (view.pendingQuestions ?? []).some(
		(question) => question.runId === runId,
	);
}

/** Freshness-window default for live observations (Herdr lifecycle reads). */
export const OBSERVATION_STALE_MS = 15_000;

export function observationIsStale(
	observation: SidebarObservation,
	observedAt: string | undefined,
	now: Date,
	staleMs = OBSERVATION_STALE_MS,
): boolean {
	if (!observation.fresh) return true;
	if (observedAt === undefined) return false;
	const at = Date.parse(observedAt);
	if (Number.isNaN(at)) return true;
	return now.getTime() - at > staleMs;
}

export interface PaneInputFacts {
	/** Pending developer question or fresh blocked runtime prompt. */
	requiresInput: boolean;
	/** Nothing was observed at all (neither fresh nor retained positive). */
	unknown: boolean;
}

/**
 * Combine the committed obligation with the live observation:
 * - committed question or fresh `blocked` → required;
 * - a retained prior positive observation that cannot be refreshed → still
 *   required (never downgrade a known obligation to "no input");
 * - no observation at all → unknown (hollow marker, explicit unknown state);
 * - fresh non-blocked observation without a question → nothing owed.
 */
export function paneInputFacts(
	committedRequiresInput: boolean,
	observation: SidebarObservation | undefined,
	retainedRequired = false,
): PaneInputFacts {
	if (committedRequiresInput) return { requiresInput: true, unknown: false };
	// Fresh evidence decides: a non-blocked live read clears a previous
	// runtime-only obligation instead of manufacturing a negative fact.
	if (observation?.fresh) {
		if (observation.status === "blocked")
			return { requiresInput: true, unknown: false };
		return { requiresInput: false, unknown: false };
	}
	if (retainedRequired) return { requiresInput: true, unknown: false };
	return { requiresInput: false, unknown: true };
}

export function inputRank(facts: PaneInputFacts): InputRank {
	if (facts.requiresInput) return INPUT_RANK_REQUIRED;
	return facts.unknown ? INPUT_RANK_UNKNOWN : INPUT_RANK_NONE;
}

/** Runtime activity text for the status row: the observed Herdr state, or an
 * explicit uncertainty label. Committed run status is never substituted here. */
export function runtimeStatusText(
	observation: SidebarObservation | undefined,
): string {
	if (!observation?.fresh) return "unknown";
	const label: Record<SidebarObservation["status"], string> = {
		idle: "idle",
		working: "working",
		blocked: "blocked (input)",
		done: "done",
		unknown: "unknown",
	};
	return label[observation.status];
}

export function runtimeStatusGlyph(
	observation: SidebarObservation | undefined,
): string {
	if (!observation?.fresh) return "?";
	const glyph: Record<SidebarObservation["status"], string> = {
		idle: "○",
		working: "●",
		blocked: "◆",
		done: "✓",
		unknown: "?",
	};
	return glyph[observation.status];
}

/** Phase label: the registered current-step label, falling back to the id. */
export function phaseLabel(view: WorkflowView): string {
	return view.currentStep.label?.trim() || view.currentStep.id;
}

/** The pane rows of one managed card, keyed by the publication tokens. */
function paneTokens(input: {
	project: string;
	workflow: string;
	role: string;
	status: string;
	rank: InputRank;
}): Record<string, string> {
	const t = SIDEBAR_PANE_TOKENS;
	return {
		[t.project]: projectLine(input.project, input.rank === INPUT_RANK_REQUIRED),
		[t.workflow]: sidebarText(`${SIDEBAR_TREE_WORKFLOW} ${input.workflow}`),
		[t.role]: sidebarText(`${SIDEBAR_TREE_CONTINUATION}  ${input.role}`),
		[t.status]: sidebarText(`${SIDEBAR_TREE_LAST} ${input.status}`),
		[t.rank]: input.rank,
	};
}

function workspaceTokens(input: {
	project: string;
	workflow: string;
	kind: string;
	phase: string;
	owed: boolean;
}): Record<string, string> {
	const t = SIDEBAR_WORKSPACE_TOKENS;
	return {
		[t.project]: projectLine(input.project, input.owed),
		[t.workflow]: sidebarText(`${SIDEBAR_TREE_WORKFLOW} ${input.workflow}`),
		[t.kind]: sidebarText(`${SIDEBAR_TREE_CONTINUATION}  ${input.kind}`),
		[t.phase]: sidebarText(`${SIDEBAR_TREE_LAST} ${input.phase}`),
	};
}

interface WorkspaceCandidate {
	workspaceId: string;
	owed: boolean;
	workflowId: string;
	tokens: Record<string, string>;
}

/**
 * Pure projection of one refresh into display tokens plus separate machine
 * sort keys. Managed panes always win over unmanaged fallbacks for the same
 * pane id, and a pane is published once, for its current association only.
 */
export function projectSidebar(
	input: SidebarProjectionInput,
): SidebarPublication {
	const standalone = input.standalone ?? [];
	const retainedRequired = new Set(input.retainedRequiredPanes ?? []);
	const livePaneIds = input.livePaneIds
		? new Set(input.livePaneIds)
		: undefined;
	const liveWorkspaceIds = input.liveWorkspaceIds
		? new Set(input.liveWorkspaceIds)
		: undefined;
	const observations = new Map(
		input.observations.map((observation) => [observation.paneId, observation]),
	);
	const panes: SidebarPaneCard[] = [];
	const workspaces: SidebarWorkspaceCard[] = [];
	const managedPaneIds = new Set<string>();
	const managedWorkspaceIds = new Set<string>();
	const workspaceCandidates: WorkspaceCandidate[] = [];

	for (const view of input.views) {
		const label = projectLabel(view, standalone);
		const paneRuns = view.runs.filter(
			(run): run is (typeof view.runs)[number] & { paneId: string } =>
				typeof run.paneId === "string" && run.paneId.length > 0,
		);
		const paneIds = [...new Set(paneRuns.map((run) => run.paneId))].filter(
			(paneId) => livePaneIds?.has(paneId) ?? true,
		);

		let workflowOwnsInput = false;
		const observedTracked = new Map<string, SidebarPaneCard>();

		for (const paneId of paneIds) {
			const run = currentRunForPane(paneRuns, paneId);
			if (!run) continue;
			const observation = observations.get(paneId);
			const facts = paneInputFacts(
				runRequiresDeveloperInput(view, run.id),
				observation,
				retainedRequired.has(paneId),
			);
			if (facts.requiresInput) workflowOwnsInput = true;
			const card: SidebarPaneCard = {
				paneId,
				tokens: paneTokens({
					project: label,
					workflow: view.workflowId,
					role: run.role,
					status: `${runtimeStatusGlyph(observation)} ${runtimeStatusText(observation)}`,
					rank: inputRank(facts),
				}),
			};
			observedTracked.set(paneId, card);
			managedPaneIds.add(paneId);
		}

		const owed = workflowRequiresInput(view, workflowOwnsInput);
		if (view.workspace && (liveWorkspaceIds?.has(view.workspace) ?? true)) {
			managedWorkspaceIds.add(view.workspace);
			workspaceCandidates.push({
				workspaceId: view.workspace,
				owed,
				workflowId: view.workflowId,
				tokens: workspaceTokens({
					project: label,
					workflow: view.workflowId,
					kind: view.definition.id,
					phase: phaseLabel(view),
					owed,
				}),
			});
		}
		// Historical runs collapsed into one pane card: publish the current
		// association once, never the superseded ones.
		for (const card of observedTracked.values()) panes.push(card);
	}

	// One Space card per workspace: prefer a workflow that owes input, then the
	// lowest workflow id, so concurrent workflows on one workspace converge on
	// the same card in every application instance.
	const chosenWorkspaces = new Map<string, WorkspaceCandidate>();
	for (const candidate of workspaceCandidates) {
		const current = chosenWorkspaces.get(candidate.workspaceId);
		if (
			!current ||
			(candidate.owed && !current.owed) ||
			(candidate.owed === current.owed &&
				candidate.workflowId < current.workflowId)
		) {
			chosenWorkspaces.set(candidate.workspaceId, candidate);
		}
	}
	for (const candidate of [...chosenWorkspaces.values()].sort((a, b) =>
		a.workspaceId < b.workspaceId ? -1 : a.workspaceId > b.workspaceId ? 1 : 0,
	))
		workspaces.push({
			workspaceId: candidate.workspaceId,
			tokens: candidate.tokens,
		});

	// Unmanaged entries keep native names so configured rows never render
	// blank; they receive no workflow identity, no marker, and no managed
	// sort key (so they sort after managed entries).
	for (const pane of input.unmanagedPanes) {
		if (managedPaneIds.has(pane.paneId)) continue;
		const t = SIDEBAR_PANE_TOKENS;
		panes.push({
			paneId: pane.paneId,
			tokens: {
				[t.project]: sidebarText(pane.label || pane.paneId),
				...(pane.tabLabel
					? {
							[t.workflow]: sidebarText(
								`${SIDEBAR_TREE_WORKFLOW} ${pane.tabLabel}`,
							),
						}
					: {}),
				[t.status]: sidebarText(
					`${SIDEBAR_TREE_LAST} ${pane.status || "unknown"}`,
				),
			},
		});
	}
	for (const workspace of input.unmanagedWorkspaces ?? []) {
		if (managedWorkspaceIds.has(workspace.workspaceId)) continue;
		workspaces.push({
			workspaceId: workspace.workspaceId,
			tokens: {
				[SIDEBAR_WORKSPACE_TOKENS.project]: sidebarText(
					workspace.label || workspace.workspaceId,
				),
				// No invented workflow identity: the last row repeats the space's own
				// live state so configured rows are not blank.
				...(workspace.status
					? {
							[SIDEBAR_WORKSPACE_TOKENS.phase]: sidebarText(
								`${SIDEBAR_TREE_LAST} ${workspace.status}`,
							),
						}
					: {}),
			},
		});
	}

	const clearedPanes = (input.managedPaneIds ?? [])
		.filter(
			(paneId) =>
				!managedPaneIds.has(paneId) && (livePaneIds?.has(paneId) ?? true),
		)
		.map((paneId) => ({ targetId: paneId, tokens: SIDEBAR_ALL_PANE_TOKENS }));
	const clearedWorkspaces = (input.managedWorkspaceIds ?? [])
		.filter(
			(workspaceId) =>
				!managedWorkspaceIds.has(workspaceId) &&
				(liveWorkspaceIds?.has(workspaceId) ?? true),
		)
		.map((workspaceId) => ({
			targetId: workspaceId,
			tokens: SIDEBAR_ALL_WORKSPACE_TOKENS,
		}));

	return { panes, workspaces, clearedPanes, clearedWorkspaces };
}

/** The `agent.view.set` request body: input rank first, then native
 * workspace/tab/pane order. No filter, so unmanaged entries (which lack the
 * token) stay visible after managed ones. */
export function agentViewSetParams(): {
	source: string;
	label: string;
	sort: Array<{ field: unknown; order: string }>;
} {
	return {
		source: SIDEBAR_SOURCE,
		label: SIDEBAR_VIEW_LABEL,
		sort: [
			{ field: { token: SIDEBAR_PANE_TOKENS.rank }, order: "desc" },
			{ field: "workspace_order", order: "asc" },
			{ field: "tab_order", order: "asc" },
			{ field: "pane_order", order: "asc" },
		],
	};
}

export function agentViewClearParams(): { source: string } {
	return { source: SIDEBAR_SOURCE };
}

/** Definitions whose target is repository-independent: their card shows the
 * existing target classification instead of a folder name. */
export const STANDALONE_DEFINITIONS: Readonly<
	Record<string, "Research" | "Wiki">
> = {
	research: "Research",
	wiki: "Wiki",
	"wiki-comments": "Wiki",
};

/** Classify the repository-independent workflows of one refresh. */
export function standaloneClassifications(
	views: readonly WorkflowView[],
): SidebarTargetClassification[] {
	return views.flatMap((view) => {
		const label = STANDALONE_DEFINITIONS[view.definition.id];
		return label && !repositoryBasename(view.repository)
			? [{ workflowId: view.workflowId, label }]
			: [];
	});
}

/** The pane ids whose last projection owed input, so the next read can retain
 * a known obligation across a failed observation. */
export function retainedRequiredPaneIds(
	publication: SidebarPublication,
	previous: readonly string[] = [],
): string[] {
	const next = new Set(previous);
	for (const card of publication.panes) {
		if (card.tokens[SIDEBAR_PANE_TOKENS.rank] === INPUT_RANK_REQUIRED)
			next.add(card.paneId);
		else next.delete(card.paneId);
	}
	return [...next];
}

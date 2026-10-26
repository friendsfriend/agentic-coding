import type { Keybind, KeybindSection } from "@agentic-coding/ui";
import { hostKeybind } from "../../../packages/devenv/cli/src/tui/keyboard/host-keys.ts";
import {
	AGENTS_PANEL,
	CLASSIFIER_PANEL,
	EVIDENCE_PANEL,
	OPENSPEC_PANEL,
} from "./panel-grid.ts";
import { artifactSurfaceLabel } from "./projections.ts";

/**
 * Footer contexts for the dashboard detail panels. `Keybind.context` entries
 * are only shown in the footer while their panel is focused; the `?` help
 * modal lists every panel's keys regardless.
 */
export const CHANGE_PANEL_CONTEXT = "change";
export const OPENSPEC_PANEL_CONTEXT = "openspec";
export const AGENTS_PANEL_CONTEXT = "agents";
export const CLASSIFIER_PANEL_CONTEXT = "classifier";
export const EVIDENCE_PANEL_CONTEXT = "evidence";

/** The stage-report review dialog shares its footer and the dashboard's `?` help. */
export function stageReportReviewKeybinds(
	wikiUpdateAvailable: boolean,
): Keybind[] {
	return [
		{ key: "j/k", action: "Navigate report", standard: true },
		{ key: "Enter", action: "Read report" },
		{ key: "/", action: "Search report files" },
		{ key: "n/N", action: "Next/previous comment", standard: true },
		{ key: "v", action: "Select report lines", standard: true },
		{ key: "c", action: "Add follow-up comment" },
		{
			key: "f",
			action: wikiUpdateAvailable
				? "Approve and update wiki"
				: "Approve report",
		},
		...(wikiUpdateAvailable
			? [{ key: "Shift+F", action: "Approve report (skip wiki)" }]
			: []),
		{ key: "Esc", action: "Back or close report", short: "back" },
	];
}

/** The body of the stage report owns the screen once it is open: `Enter` and
 * `/` only drive the file list, so publishing them there would advertise keys
 * that do nothing. One helper so the footer and the `?` help agree. */
export function stageReportReviewKeybindsForView(
	wikiUpdateAvailable: boolean,
	view: "files" | "diff",
): Keybind[] {
	const keybinds = stageReportReviewKeybinds(wikiUpdateAvailable);
	return view === "diff"
		? keybinds.filter(({ key }) => key !== "Enter" && key !== "/")
		: keybinds;
}

export function stageReportReviewKeybindCatalog(
	wikiUpdateAvailable: boolean,
	view: "files" | "diff" = "files",
): KeybindSection[] {
	return [
		{
			title: "Stage report review",
			keybinds: stageReportReviewKeybindsForView(wikiUpdateAvailable, view),
		},
	];
}

/** The stage-test plan gate's own catalog: one synthetic plan document, no
 * file list to search, and `r` only while the engine offers plan rejection
 * (USAB-002/USAB-003). Esc closes the plan, matching the report review. */
export function stagePlanReviewKeybindsForView(
	rejectAvailable: boolean,
	view: "files" | "diff",
): Keybind[] {
	const keybinds: Keybind[] = [
		{ key: "j/k", action: "Navigate plan", standard: true },
		...(view === "files" ? [{ key: "Enter", action: "Read plan" }] : []),
		{ key: "v", action: "Select plan lines", standard: true },
		{ key: "c", action: "Add review comment" },
		{ key: "f", action: "Finish plan review" },
		...(rejectAvailable ? [{ key: "r", action: "Reject plan" }] : []),
		{ key: "Esc", action: "Close plan review", short: "close" },
	];
	return keybinds;
}

export function stagePlanReviewKeybindCatalog(
	rejectAvailable: boolean,
	view: "files" | "diff" = "diff",
): KeybindSection[] {
	return [
		{
			title: "Stage plan review",
			keybinds: stagePlanReviewKeybindsForView(rejectAvailable, view),
		},
	];
}

export function panelContext(panel: number): string {
	if (panel === EVIDENCE_PANEL) return EVIDENCE_PANEL_CONTEXT;
	if (panel === OPENSPEC_PANEL) return OPENSPEC_PANEL_CONTEXT;
	if (panel === CLASSIFIER_PANEL) return CLASSIFIER_PANEL_CONTEXT;
	if (panel === AGENTS_PANEL) return AGENTS_PANEL_CONTEXT;
	return CHANGE_PANEL_CONTEXT;
}

/**
 * Contextual workflow launch (`launch-workflows-from-project-and-wiki-pages`).
 * Published while the creation form is open, so the footer and `?` help name
 * what the form is doing instead of the page behind it.
 */
export function workflowLaunchKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Create workflow",
			keybinds: [
				{ key: "j/k", action: "Move in list", short: "move" },
				{ key: "Enter", action: "Select / create", short: "select" },
				{ key: "/", action: "Filter list", short: "filter" },
				{ key: "Esc", action: "Back / cancel", short: "back" },
			],
		},
	];
}

/**
 * Agent session view (`dashboard-agent-session-view`). The view is a page of
 * the dashboard body: while it is open its keys replace the panel keys, so it
 * publishes this catalog instead of the detail one.
 */
export function agentSessionKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Agent session",
			keybinds: [
				hostKeybind("ctrl+a"),
				{ key: "Esc", action: "Back to the dashboard panels", short: "back" },
				{
					key: "Enter",
					action: "Send message (steer if the run is busy)",
					short: "send",
				},
				{
					key: "Shift+Enter",
					action: "New line in the prompt",
					standard: true,
				},
				{ key: "PgUp/PgDn", action: "Scroll transcript", short: "scroll" },
				{ key: "Tab", action: "Complete command", standard: true },
				{
					key: "↑/↓",
					action: "Choose command or browse history (prompt edges)",
					standard: true,
				},
				{ key: "Ctrl+T", action: "Expand/collapse thinking", standard: true },
				{
					key: "Ctrl+O",
					action: "Expand/collapse tool output",
					standard: true,
				},
			],
		},
	];
}

/**
 * Evidence subview (`evidence-summary-subview`). The page replaces the panel grid
 * the way the agent session does, so it publishes its own catalog instead of the
 * detail one: what the sidebar selection is, the report scroll, the two file
 * actions, and — only when the workflow recorded a stage flow — the action that
 * opens its `stage-flow.html`. `Esc` is the only way back, so it is listed as an
 * action rather than a hidden standard key.
 */
export function evidenceSubviewKeybindCatalog(options: {
	/** Whether the open workflow has a stage flow journal, which is what makes the
	 * open-flow action reachable. */
	flow?: boolean;
}): KeybindSection[] {
	return [
		{
			title: "Evidence view",
			keybinds: [
				hostKeybind("ctrl+a"),
				{ key: "Esc", action: "Back to the dashboard panels", short: "back" },
				{ key: "Enter", action: "Open selected evidence", short: "open" },
				{ key: "y", action: "Copy selected evidence path", short: "copy" },
				{
					key: "j/k or ↑/↓",
					action: "Move in the evidence list",
					standard: true,
				},
				{ key: "PgUp/PgDn", action: "Scroll the report", short: "scroll" },
				{ key: "Ctrl+U/Ctrl+D", action: "Scroll the report", standard: true },
				...(options.flow
					? [
							{
								key: "f",
								action: "Open stage flow page",
								short: "flow",
							},
						]
					: []),
			],
		},
	];
}

/**
 * Workflow detail (`App`) catalog. Panel-specific actions carry a `context`
 * so the footer changes with the focused panel, while `?` still lists the
 * whole set.
 */
export function dashboardDetailKeybindCatalog(options: {
	artifactsVisible: boolean;
	/** The workflow's definition id, so the artifact panel's help section shares
	 * the panel's own surface name ("Debug report" for the debug family). */
	definitionId?: string;
}): KeybindSection[] {
	const sections: KeybindSection[] = [
		{
			title: "Navigation",
			keybinds: [
				{
					key: "J/K/H/L",
					action: "Move between panels",
					short: "panels",
				},
				hostKeybind("ctrl+s"),
				hostKeybind("ctrl+a"),
				{
					key: "j/k or ↑/↓",
					action: "Scroll focused panel",
					standard: true,
				},
				{
					key: "Esc",
					action: "Return to dashboard workspace",
					short: "back",
				},
			],
		},
		{
			title: "Change panel",
			keybinds: [
				{
					key: "Enter",
					action: "Approve gate / review changed files",
					short: "approve",
					context: CHANGE_PANEL_CONTEXT,
				},
				{
					key: "g",
					action: "Show workflow graph",
					short: "graph",
					context: CHANGE_PANEL_CONTEXT,
				},
			],
		},
	];
	if (options.artifactsVisible)
		sections.push({
			title: `${artifactSurfaceLabel(options.definitionId)} panel`,
			keybinds: [
				{
					key: "Enter",
					action: "Open selected artifact",
					short: "open",
					context: OPENSPEC_PANEL_CONTEXT,
				},
			],
		});
	// Always listed: the Classifications panel is always rendered, empty state
	// included, so its keybind is never advertising a panel the reader cannot
	// reach.
	sections.push({
		title: "Classifications panel",
		keybinds: [
			{
				key: "Enter",
				action: "View selected classification",
				short: "decision",
				context: CLASSIFIER_PANEL_CONTEXT,
			},
		],
	});
	sections.push(
		{
			title: "Agents panel",
			keybinds: [
				{
					key: "Enter",
					action: "Focus selected agent / open durable agent session",
					short: "focus",
					context: AGENTS_PANEL_CONTEXT,
				},
				{
					key: "v",
					action: "View selected verifier result",
					short: "verifier",
					context: AGENTS_PANEL_CONTEXT,
				},
			],
		},
		{
			title: "Evidence panel",
			keybinds: [
				{
					key: "Enter",
					action: "Open the evidence view",
					short: "evidence",
					context: EVIDENCE_PANEL_CONTEXT,
				},
			],
		},
		{
			title: "Global",
			keybinds: [
				{ key: "O", action: "Show safe repair guidance", short: "repair" },
				{ key: "c", action: "View agent cost breakdown", short: "cost" },
				{
					key: "d",
					action: "Show delegated debug requests",
					short: "debug",
				},
				{ key: "m", action: "Switch agent preset", short: "preset" },
				{ key: "T", action: "Theme picker", short: "theme" },
				{ key: "Ctrl+Shift+C", action: "Copy selection", standard: true },
				{ key: "r", action: "Refresh dashboard", short: "refresh" },
				// The workspace cycle stays live here: a dashboard is one of the
				// entries Ctrl+H/Ctrl+L walk.
				hostKeybind("ctrl+h"),
				hostKeybind("ctrl+l"),
				hostKeybind("ctrl+t"),
				hostKeybind("?"),
				hostKeybind("q"),
			],
		},
	);
	return sections;
}

import type { KeybindSection } from "@ui";
import { hostKeybind } from "../../../packages/devenv/cli/src/tui/keyboard/host-keys.ts";
import {
	AGENTS_PANEL,
	CLASSIFIER_PANEL,
	OPENSPEC_PANEL,
} from "./panel-grid.ts";

/**
 * Footer contexts for the dashboard detail panels. `Keybind.context` entries
 * are only shown in the footer while their panel is focused; the `?` help
 * modal lists every panel's keys regardless.
 */
export const CHANGE_PANEL_CONTEXT = "change";
export const OPENSPEC_PANEL_CONTEXT = "openspec";
export const AGENTS_PANEL_CONTEXT = "agents";
export const CLASSIFIER_PANEL_CONTEXT = "classifier";

export function panelContext(panel: number): string {
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
				{ key: "Esc", action: "Back to the dashboard panels", short: "back" },
				{
					key: "Enter",
					action: "Send message (steer if the run is busy)",
					short: "send",
				},
				{ key: "PgUp/PgDn", action: "Scroll transcript", short: "scroll" },
				{ key: "Tab", action: "Complete command", standard: true },
				{
					key: "↑/↓",
					action: "Choose command or browse history (empty prompt)",
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
 * Workflow detail (`App`) catalog. Panel-specific actions carry a `context`
 * so the footer changes with the focused panel, while `?` still lists the
 * whole set.
 */
export function dashboardDetailKeybindCatalog(options: {
	artifactsVisible: boolean;
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
			title: "OpenSpec panel",
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
			title: "Global",
			keybinds: [
				{ key: "O", action: "Show safe repair guidance", short: "repair" },
				{ key: "c", action: "View agent cost breakdown", short: "cost" },
				{ key: "m", action: "Switch agent preset", short: "preset" },
				{ key: "T", action: "Theme picker", short: "theme" },
				{ key: "Ctrl+Shift+C", action: "Copy selection", standard: true },
				{ key: "r", action: "Refresh dashboard", short: "refresh" },
				hostKeybind("ctrl+t"),
				hostKeybind("?"),
				hostKeybind("q"),
			],
		},
	);
	return sections;
}

import type { KeybindSection } from "../shared/keybinds";
import { AGENTS_PANEL, OPENSPEC_PANEL } from "./panel-grid";

/**
 * Footer contexts for the dashboard detail panels. `Keybind.context` entries
 * are only shown in the footer while their panel is focused; the `?` help
 * modal lists every panel's keys regardless.
 */
export const CHANGE_PANEL_CONTEXT = "change";
export const OPENSPEC_PANEL_CONTEXT = "openspec";
export const AGENTS_PANEL_CONTEXT = "agents";

export function panelContext(panel: number): string {
	if (panel === OPENSPEC_PANEL) return OPENSPEC_PANEL_CONTEXT;
	if (panel === AGENTS_PANEL) return AGENTS_PANEL_CONTEXT;
	return CHANGE_PANEL_CONTEXT;
}

/**
 * Workspace overview (`Home`) catalog. Standard navigation keys are marked so
 * the footer advertises only the special actions; `?` shows the full catalog.
 */
export function dashboardOverviewKeybindCatalog(): KeybindSection[] {
	return [
		{
			title: "Navigation",
			keybinds: [
				{ key: "j/k or ↑/↓", action: "Select workspace", standard: true },
			],
		},
		{
			title: "Actions",
			keybinds: [
				{ key: "Enter", action: "Switch active workspace", short: "switch" },
				{ key: "n", action: "New workflow", short: "new" },
				{
					key: "m",
					action: "Agent configuration (profiles / presets)",
					short: "config",
				},
				{ key: "f", action: "Open filter modal", short: "filter" },
				{ key: "o", action: "Open sort modal", short: "sort" },
				{ key: "T", action: "Theme picker", short: "theme" },
				{ key: "r", action: "Refresh", short: "refresh" },
				{ key: "?", action: "Open help", short: "help" },
				{ key: "q", action: "Quit", standard: true },
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
	sections.push(
		{
			title: "Agents panel",
			keybinds: [
				{
					key: "Enter",
					action: "Focus selected agent",
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
				{ key: "T", action: "Theme picker", short: "theme" },
				{ key: "Ctrl+Shift+C", action: "Copy selection", standard: true },
				{ key: "r", action: "Refresh dashboard", short: "refresh" },
				{ key: "?", action: "Open help", short: "help" },
				{ key: "q", action: "Quit", standard: true },
			],
		},
	);
	return sections;
}

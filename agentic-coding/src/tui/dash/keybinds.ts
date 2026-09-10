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
				{ key: "Enter", action: "Switch active workspace" },
				{ key: "n", action: "New workflow" },
				{ key: "m", action: "Agent configuration (profiles / presets)" },
				{ key: "f", action: "Open filter modal" },
				{ key: "o", action: "Open sort modal" },
				{ key: "Shift+T", action: "Theme picker" },
				{ key: "r", action: "Refresh" },
				{ key: "?", action: "Open help" },
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
				{ key: "Shift+J/K/H/L", action: "Move between panels" },
				{
					key: "j/k or ↑/↓",
					action: "Scroll focused panel",
					standard: true,
				},
				{ key: "Esc", action: "Return to dashboard workspace" },
			],
		},
		{
			title: "Change panel",
			keybinds: [
				{
					key: "Enter",
					action: "Approve gate / review changed files",
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
					context: AGENTS_PANEL_CONTEXT,
				},
				{
					key: "v",
					action: "View selected verifier result",
					context: AGENTS_PANEL_CONTEXT,
				},
			],
		},
		{
			title: "Global",
			keybinds: [
				{ key: "Shift+O", action: "Show safe repair guidance" },
				{ key: "c", action: "View agent cost breakdown" },
				{ key: "Shift+T", action: "Theme picker" },
				{ key: "Ctrl+Shift+C", action: "Copy selection", standard: true },
				{ key: "r", action: "Refresh dashboard" },
				{ key: "?", action: "Open help" },
				{ key: "q", action: "Quit", standard: true },
			],
		},
	);
	return sections;
}

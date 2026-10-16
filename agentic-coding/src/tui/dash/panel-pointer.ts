// The dashboard's pointer wiring for the panel grid (`dashboard-panel-navigation`).
//
// Extracted from the route so the two rules can be asserted directly: a tap
// focuses the panel the way `J/K/H/L` does (and only while the grid is the
// visible body), and activating a row selects the row the pointer resolved
// *before* dispatching the panel's own `Enter`, so one gesture can never act on
// a row the pointer did not name.

export interface PanelPointerOptions {
	/** The panel grid's own focus setter (the `J/K/H/L` target). */
	setActivePanel: (panel: number) => void;
	/** Push a key stroke through the renderer, exactly as typing it. */
	dispatchKey: (label: string) => boolean;
	/** True while the agent-session page replaced the grid. */
	agentSessionOpen: () => boolean;
}

export interface PanelPointerHandlers {
	/** A tap anywhere in a panel focuses it. */
	focusPanelFromPointer: (panel: number) => void;
	/** A tap on the selected row: select the resolved index, then run `Enter`. */
	activatePanelRow: (
		select: (index: number) => void,
	) => (index: number) => void;
}

export function panelPointerHandlers(
	options: PanelPointerOptions,
): PanelPointerHandlers {
	return {
		focusPanelFromPointer: (panel) => {
			if (options.agentSessionOpen()) return;
			options.setActivePanel(panel);
		},
		activatePanelRow: (select) => (index) => {
			select(index);
			options.dispatchKey("Enter");
		},
	};
}

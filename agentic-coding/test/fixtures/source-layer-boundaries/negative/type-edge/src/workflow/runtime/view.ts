// Negative fixture: a workflow core module imports a TUI presentation module
// even only for types. The ownership check must reject it without treating
// the type-only reference as a runtime cycle.
import type { Panel } from "../../tui/dash/panel.ts";

export interface TypedEngineView {
	panels?: Panel[];
	title: string;
}
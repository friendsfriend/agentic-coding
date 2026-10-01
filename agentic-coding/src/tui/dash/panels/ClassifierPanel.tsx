/** Classification history panel: every classification the engine recorded
 * (model-pool routing, verifier-role triage, stage gates, the per-file
 * judgment sweep) in the order it happened. The route owns selection and
 * activation; this component only renders the bounded selectable viewport.
 *
 * The panel is rendered for every workflow, including one that has not
 * classified anything yet: a fresh run (or a definition without pool-routed
 * steps) shows an explicit empty state rather than no panel at all, so the
 * place decisions will appear is always visible and focusable. */

import { TextAttributes } from "@opentui/core";
import { Panel, SelectableList, uiColors } from "@ui";
import { Show } from "solid-js";
import {
	type ClassificationEntry,
	classificationRows,
} from "../projections.ts";

export interface ClassifierPanelProps {
	readonly entries: readonly ClassificationEntry[];
	readonly active: boolean;
	readonly selectedIndex: number;
	readonly visibleRows?: number;
}

export function ClassifierPanel(props: ClassifierPanelProps) {
	// At least one body row even when the history is empty, so the panel keeps a
	// visible frame instead of collapsing to its border.
	const rows = () =>
		props.visibleRows ?? Math.max(1, Math.min(props.entries.length, 5));
	const items = () => classificationRows(props.entries);
	return (
		<Panel
			title="Classifications"
			accent={uiColors.accent}
			active={props.active}
			style={{ width: "100%", height: rows() + 1, flexShrink: 0 }}
		>
			<Show
				when={items().length > 0}
				fallback={
					<text fg={uiColors.textSecondary}>
						No classifications recorded yet
					</text>
				}
			>
				<SelectableList
					items={items()}
					availableLines={rows()}
					selectedIndex={props.active ? props.selectedIndex : -1}
					renderItem={(row, selected) => (
						<box height={1}>
							<text
								fg={selected ? uiColors.textPrimary : uiColors.textSecondary}
								attributes={selected ? TextAttributes.BOLD : 0}
							>
								{row}
							</text>
						</box>
					)}
				/>
			</Show>
		</Panel>
	);
}

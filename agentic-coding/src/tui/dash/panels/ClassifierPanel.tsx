/** Classification history panel: every classification the engine recorded
 * (model-pool routing, verifier-role triage, stage gates, the per-file
 * judgment sweep) in the order it happened. The route owns selection and
 * activation; this component only renders the bounded selectable viewport. */

import { TextAttributes } from "@opentui/core";
import { Panel, SelectableList, uiColors } from "@ui";
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
	const rows = () => props.visibleRows ?? Math.min(props.entries.length, 5);
	const items = () => classificationRows(props.entries);
	return (
		<Panel
			title="Classifications"
			accent={uiColors.accent}
			active={props.active}
			style={{ width: "100%", height: rows() + 1, flexShrink: 0 }}
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
		</Panel>
	);
}

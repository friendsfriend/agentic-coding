/** Classifier decision history panel. The route owns selection and activation;
 * this component only renders the bounded selectable viewport. */

import { TextAttributes } from "@opentui/core";
import { Panel, SelectableList, uiColors } from "@ui";
import type { ClassifierDecisionRecord } from "../../../contracts/workflow.ts";
import { classifierDecisionRows } from "../projections.ts";

export interface ClassifierPanelProps {
	readonly decisions: readonly ClassifierDecisionRecord[];
	readonly active: boolean;
	readonly selectedIndex: number;
	readonly visibleRows?: number;
}

export function ClassifierPanel(props: ClassifierPanelProps) {
	const rows = () => props.visibleRows ?? Math.min(props.decisions.length, 5);
	const items = () => classifierDecisionRows(props.decisions);
	return (
		<Panel
			title="Classifier"
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

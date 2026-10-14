/** OpenSpec artifacts panel (establish-opencode-boundaries, task 6.1).
 * Props-in: the artifact list and selection come from the route that owns
 * them; opening an artifact is a callback. */

import { TextAttributes } from "@opentui/core";
import { Panel, SelectableList, uiColors } from "@ui";

export interface OpenSpecPanelProps {
	readonly artifacts: readonly string[];
	readonly active: boolean;
	readonly selectedIndex: number;
	/** Rows the panel shows before it scrolls (bounded by the artifact count). */
	readonly visibleRows?: number;
	/** The surface name for the workflow's artifact list. Defaults to `OpenSpec`;
	 * the debug family's report is not an OpenSpec artifact, so its panel is
	 * titled for what it holds. */
	readonly title?: string;
}

export function OpenSpecPanel(props: OpenSpecPanelProps) {
	const rows = () => props.visibleRows ?? Math.min(props.artifacts.length, 5);
	return (
		<Panel
			title={props.title ?? "OpenSpec"}
			accent={uiColors.accent}
			active={props.active}
			style={{
				width: "100%",
				height: rows() + 1,
				flexShrink: 0,
			}}
		>
			<SelectableList
				items={[...props.artifacts]}
				availableLines={rows()}
				selectedIndex={props.active ? props.selectedIndex : -1}
				renderItem={(artifact, selected) => (
					<box height={1}>
						<text
							fg={selected ? uiColors.textPrimary : uiColors.textSecondary}
							attributes={selected ? TextAttributes.BOLD : 0}
						>
							{artifact}
						</text>
					</box>
				)}
			/>
		</Panel>
	);
}

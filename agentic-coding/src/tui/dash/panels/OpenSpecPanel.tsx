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
	/** Pointer: a tap selects a row (the keyboard's `j`/`k`). */
	readonly onSelectIndex?: (index: number) => void;
	/** Pointer: a tap on the selected row activates it (the keyboard's `Enter`). */
	readonly onActivateRow?: (index: number) => void;
	/** Pointer: a tap anywhere in the panel focuses it (`J/K/H/L`). */
	readonly onFocusRequest?: () => void;
}

export function OpenSpecPanel(props: OpenSpecPanelProps) {
	const rows = () => props.visibleRows ?? Math.min(props.artifacts.length, 5);
	return (
		<Panel
			title={props.title ?? "OpenSpec"}
			accent={uiColors.accent}
			active={props.active}
			{...(props.onFocusRequest
				? { onFocusRequest: props.onFocusRequest }
				: {})}
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
				{...(props.onSelectIndex ? { onSelect: props.onSelectIndex } : {})}
				{...(props.onActivateRow ? { onActivate: props.onActivateRow } : {})}
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

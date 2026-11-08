/** @jsxImportSource @opentui/solid */
// Original shared row component; list/window ownership stays with the native surface.
import type { JSX } from "solid-js";
import { uiColors } from "../theme/colors";
import { useHover } from "./mouse/useHover.ts";
import { type RowGestureState, useRowMouse } from "./mouse/useRowMouse.ts";

export function Selectable(props: {
	selected: boolean;
	children?: JSX.Element;
	backgroundColor?: string;
	hoverBackground?: string | false;
	indicatorColor?: string;
	height?: number;
	onMouseUp?: () => void;
	onActivate?: () => void;
	gesture?: RowGestureState;
}) {
	const mouse = useRowMouse({
		...(props.gesture ? { gesture: props.gesture } : {}),
		selectedIndex: () => (props.selected ? 0 : 1),
		activatable: () => props.onActivate !== undefined,
		onSelect: () => props.onMouseUp?.(),
		onActivate: () => (props.onActivate ?? props.onMouseUp)?.(),
	});
	const hover = useHover(mouse.onMouseOut);
	const hoverBackground = () =>
		props.hoverBackground === false
			? undefined
			: (props.hoverBackground ?? uiColors.bgHover);
	const background = () => {
		const hoverFill = hover.hovered() ? hoverBackground() : undefined;
		if (hoverFill !== undefined) return hoverFill;
		return props.selected
			? uiColors.bgSurface0
			: (props.backgroundColor ?? uiColors.bgMantle);
	};
	return (
		<box
			{...mouse}
			{...hover}
			width="100%"
			flexDirection="row"
			flexShrink={0}
			alignItems="stretch"
			backgroundColor={background()}
			style={props.height === undefined ? undefined : { height: props.height }}
		>
			<box
				border={["left"]}
				borderColor={
					props.selected
						? (props.indicatorColor ?? uiColors.highlight)
						: "transparent"
				}
				style={{ width: 1, height: "100%", flexShrink: 0 }}
			/>
			<box width={1} height="100%" flexShrink={0} />
			<box flexGrow={1} minWidth={0} flexDirection="column">
				{props.children}
			</box>
		</box>
	);
}

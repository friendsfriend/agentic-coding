/** @jsxImportSource @opentui/solid */
import { createEffect, For, type JSX, onCleanup, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import { type RowGestureState, useRowMouse } from "./mouse/useRowMouse.ts";
import { useWheelScroll } from "./mouse/useWheelScroll.ts";

/** Local original ScrollableList fixed-row read-only branch. The owner supplies
 * the bounded window and identity selection; this component owns no paging,
 * editor, native commands, modal chrome or selection persistence. */
export function ReadOnlyScrollableList<T>(props: {
	items: readonly T[];
	start: number;
	availableLines: number;
	selectedIndex: number;
	active: boolean;
	gesture: RowGestureState;
	selectedBackground?: string;
	onSelect: (index: number) => void;
	onActivate: (index: number) => void;
	renderItem: (item: T, selected: () => boolean) => JSX.Element;
	emptyContent: JSX.Element;
}) {
	const gesture = props.gesture;
	const retireGesture = () => {
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	createEffect(() => {
		// Mode pauses and replacement item sets retire a press; ordinary window
		// movement/selection deliberately does not. No global pointer state.
		props.active;
		props.items;
		props.availableLines;
		retireGesture();
	});
	onCleanup(retireGesture);
	const lines = () => Math.max(1, props.availableLines);
	const start = () =>
		Math.max(
			0,
			Math.min(props.start, Math.max(0, props.items.length - lines())),
		);
	const visible = () =>
		props.items
			.slice(start(), start() + lines())
			.map((item, offset) => ({ item, index: start() + offset }));
	const needsScrollbar = () => props.items.length > lines();
	const thumbTop = () =>
		props.items.length > 0
			? Math.floor((lines() * start()) / props.items.length)
			: 0;
	const thumbHeight = () =>
		props.items.length > 0
			? Math.max(
					1,
					Math.min(
						lines() - thumbTop(),
						Math.ceil((lines() * visible().length) / props.items.length),
					),
				)
			: 1;
	const wheel = useWheelScroll({
		enabled: () => props.active && needsScrollbar(),
		onScroll: (direction, delta) => {
			if (!props.active) return;
			props.onSelect(
				Math.max(
					0,
					Math.min(
						props.items.length - 1,
						props.selectedIndex + (direction === "up" ? -delta : delta),
					),
				),
			);
		},
	});
	return (
		<Show when={props.items.length > 0} fallback={props.emptyContent}>
			<box
				{...wheel}
				style={{
					width: "100%",
					height: lines(),
					flexGrow: 0,
					flexShrink: 0,
					minHeight: 0,
					flexDirection: "row",
					overflow: "hidden",
				}}
			>
				<box
					style={{
						flexGrow: 1,
						flexShrink: 1,
						minWidth: 0,
						minHeight: 0,
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<For each={visible()}>
						{(row) => {
							const item = row.item;
							const index = () => row.index;
							const selected = () =>
								index() >= 0 && index() === props.selectedIndex;
							const mouse = useRowMouse({
								gesture,
								index,
								selectedIndex: () => props.selectedIndex,
								activatable: () => props.active && index() >= 0,
								onSelect: (index) => {
									if (props.active && props.items[index] === item)
										props.onSelect(index);
								},
								onActivate: (index) => {
									if (props.active && props.items[index] === item)
										props.onActivate(index);
								},
							});
							const hover = useHover(mouse.onMouseOut);
							return (
								<box
									width="100%"
									flexDirection="row"
									flexShrink={0}
									height={1}
									{...mouse}
									{...hover}
									backgroundColor={
										hover.hovered()
											? uiColors.bgHover
											: selected()
												? props.selectedBackground
												: undefined
									}
								>
									{props.renderItem(item, selected)}
								</box>
							);
						}}
					</For>
				</box>
				<Show when={needsScrollbar()}>
					<box
						style={{
							width: 1,
							flexShrink: 0,
							flexDirection: "column",
							minHeight: 0,
							overflow: "hidden",
						}}
					>
						<Show when={thumbTop() > 0}>
							<box
								style={{ width: 1, height: thumbTop(), flexShrink: 0 }}
								backgroundColor={uiColors.scrollbarTrack}
							/>
						</Show>
						<box
							style={{ width: 1, height: thumbHeight(), flexShrink: 0 }}
							backgroundColor={uiColors.scrollbarThumb}
						/>
						<box
							style={{ width: 1, flexGrow: 1, minHeight: 0 }}
							backgroundColor={uiColors.scrollbarTrack}
						/>
					</box>
				</Show>
			</box>
		</Show>
	);
}

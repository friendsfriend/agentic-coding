/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, type JSX } from "solid-js";
import { type SCROLLBAR_OPTIONS, uiColors } from "./colors";
import { ScrollableContent } from "./ScrollableContent";

/** A value or a reactive getter for it; both dash (plain values) and
 * observability (accessors) callers are supported by read(). */
type Value<T> = T | (() => T);
const read = <T,>(value: Value<T> | undefined, fallback: T): T =>
	typeof value === "function" ? (value as () => T)() : (value ?? fallback);

export function Selectable(props: {
	selected: boolean;
	children?: JSX.Element;
	backgroundColor?: string;
	indicatorColor?: string;
	height?: number;
	ref?: (box: BoxRenderable) => void;
	onMouseUp?: () => void;
}) {
	const background = () =>
		props.selected
			? uiColors.bgSurface1
			: (props.backgroundColor ?? uiColors.bgMantle);
	return (
		<box
			ref={props.ref}
			onMouseUp={props.onMouseUp}
			width="100%"
			flexDirection="row"
			flexShrink={0}
			alignItems="stretch"
			backgroundColor={background()}
			style={props.height === undefined ? undefined : { height: props.height }}
		>
			<box
				width={1}
				height="100%"
				flexShrink={0}
				backgroundColor={
					props.selected
						? (props.indicatorColor ?? uiColors.accent)
						: background()
				}
			/>
			<box flexGrow={1} minWidth={0} flexDirection="column">
				{props.children}
			</box>
		</box>
	);
}

export interface SelectableListProps<T> {
	items: T[];
	selectedIndex: Value<number>;
	itemHeight?: number;
	renderItem: (item: T, selected: boolean, index: number) => JSX.Element;
	onSelect?: (index: number) => void;
	backgroundColor?: (item: T, index: number) => string | undefined;
	style?: Record<string, unknown>;
	/** Scrollbox focus participation; family wrappers pin their defaults. */
	focusable?: boolean;
	/** Scrollbar look; family wrappers pin their legacy colors. */
	scrollbarOptions?: typeof SCROLLBAR_OPTIONS;
}

export function SelectableList<T>(props: SelectableListProps<T>) {
	const cards: Array<BoxRenderable | undefined> = [];
	let scrollbox: ScrollBoxRenderable | undefined;
	const selectedIndex = () => read(props.selectedIndex, 0);
	createEffect(() => {
		const card = cards[selectedIndex()];
		if (card) scrollbox?.scrollChildIntoView(card.id);
	});
	return (
		<ScrollableContent
			style={props.style}
			focusable={props.focusable}
			scrollbarOptions={props.scrollbarOptions}
			onScrollBoxReady={(box) => {
				scrollbox = box;
			}}
		>
			<For each={props.items}>
				{(item, index) => (
					<Selectable
						ref={(card) => {
							cards[index()] = card;
						}}
						height={props.itemHeight}
						onMouseUp={() => props.onSelect?.(index())}
						selected={index() === selectedIndex()}
						backgroundColor={props.backgroundColor?.(item, index())}
					>
						{props.renderItem(item, index() === selectedIndex(), index())}
					</Selectable>
				)}
			</For>
		</ScrollableContent>
	);
}

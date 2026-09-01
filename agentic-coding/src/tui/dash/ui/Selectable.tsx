/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, type JSX } from "solid-js";
import { uiColors } from "./colors";
import { ScrollableContent } from "./ScrollableContent";

export function Selectable(props: {
	selected: boolean;
	children?: JSX.Element;
	backgroundColor?: string;
	indicatorColor?: string;
	height?: number;
	ref?: (box: BoxRenderable) => void;
}) {
	return (
		<box
			ref={props.ref}
			width="100%"
			height={props.height}
			flexDirection="row"
			flexShrink={0}
			alignItems="stretch"
			style={props.height === undefined ? undefined : { height: props.height }}
			backgroundColor={
				props.selected
					? uiColors.bgSurface1
					: (props.backgroundColor ?? uiColors.bgMantle)
			}
		>
			<box
				width={1}
				height="100%"
				flexShrink={0}
				backgroundColor={
					props.selected
						? (props.indicatorColor ?? uiColors.accent)
						: (props.backgroundColor ?? uiColors.bgMantle)
				}
			/>
			<box flexGrow={1} minWidth={0} flexDirection="column">
				{props.children}
			</box>
		</box>
	);
}

export function SelectableList<T>(props: {
	items: T[];
	selectedIndex: number;
	itemHeight?: number;
	renderItem: (item: T, selected: boolean, index: number) => JSX.Element;
	backgroundColor?: (item: T, index: number) => string | undefined;
	style?: Record<string, unknown>;
}) {
	const cards: Array<BoxRenderable | undefined> = [];
	let scrollbox: ScrollBoxRenderable | undefined;
	createEffect(() => {
		const card = cards[props.selectedIndex];
		if (card) scrollbox?.scrollChildIntoView(card.id);
	});
	return (
		<ScrollableContent
			style={props.style}
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
						selected={index() === props.selectedIndex}
						backgroundColor={props.backgroundColor?.(item, index())}
					>
						{props.renderItem(item, index() === props.selectedIndex, index())}
					</Selectable>
				)}
			</For>
		</ScrollableContent>
	);
}

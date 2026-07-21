/** @jsxImportSource @opentui/solid */
import type { BoxRenderable, ScrollBoxRenderable } from '@opentui/core';
import { For, createEffect, type JSX } from 'solid-js';
import { uiColors } from '../ui/colors';
import { ScrollableContent } from './ScrollableContent';

export function Selectable(props: { selected: boolean; children?: JSX.Element; height?: number; backgroundColor?: string; indicatorColor?: string; ref?: (box: BoxRenderable) => void; onMouseUp?: () => void }) {
  const background = () => props.selected ? uiColors.bgSurface1 : props.backgroundColor ?? uiColors.bgMantle;
  return <box ref={props.ref} onMouseUp={props.onMouseUp} width="100%" flexDirection="row" flexShrink={0} alignItems="stretch" backgroundColor={background()} style={props.height === undefined ? undefined : { height: props.height }}>
    <box width={1} height="100%" flexShrink={0} backgroundColor={props.selected ? props.indicatorColor ?? uiColors.accent : background()} />
    <box flexGrow={1} minWidth={0} flexDirection="column">{props.children}</box>
  </box>;
}

export function SelectableList<T>(props: { items: T[]; selectedIndex: () => number; itemHeight?: number; renderItem: (item: T, selected: boolean, index: number) => JSX.Element; onSelect?: (index: number) => void; backgroundColor?: (item: T, index: number) => string | undefined; style?: Record<string, unknown> }) {
  let cards: Array<BoxRenderable | undefined> = [];
  let scrollbox: ScrollBoxRenderable | undefined;
  createEffect(() => { const card = cards[props.selectedIndex()]; if (card) scrollbox?.scrollChildIntoView(card.id); });
  return <ScrollableContent style={props.style} onScrollBoxReady={box => { scrollbox = box; }}>
    <For each={props.items}>{(item, index) => <Selectable ref={card => { cards[index()] = card; }} height={props.itemHeight} onMouseUp={() => props.onSelect?.(index())} selected={index() === props.selectedIndex()} backgroundColor={props.backgroundColor?.(item, index())}>{props.renderItem(item, index() === props.selectedIndex(), index())}</Selectable>}</For>
  </ScrollableContent>;
}

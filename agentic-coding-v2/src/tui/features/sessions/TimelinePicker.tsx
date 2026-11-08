/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
	HelpText,
	wrapHelpEntries,
} from "../../presentation/components/HelpText.tsx";
import { useHover } from "../../presentation/components/mouse/useHover.ts";
import {
	type RowGestureState,
	useRowMouse,
} from "../../presentation/components/mouse/useRowMouse.ts";
import { useWheelScroll } from "../../presentation/components/mouse/useWheelScroll.ts";
import { ReadOnlyModalFrame } from "../../presentation/components/ReadOnlyModalFrame.tsx";
import { SearchHeader } from "../../presentation/components/SearchHeader.tsx";
import { SelectionMarker } from "../../presentation/components/SelectionMarker.tsx";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors.ts";

export type PromptTimelineRow = { key: string; label: string };
/** Original cap-sized ListViewModal read-only timeline branch. Supplied rows
 * are a bounded snapshot, not a transcript cursor or native admission target. */
export function TimelinePicker(props: {
	rows: readonly PromptTimelineRow[];
	active: boolean;
	choose: (key: string) => boolean;
	close: () => void;
}) {
	const dimensions = useTerminalDimensions();
	const [selected, setSelected] = createSignal(props.rows.at(-1)?.key);
	const [offset, setOffset] = createSignal(0);
	const [refused, setRefused] = createSignal(false);
	const width = () => Math.max(1, Math.floor(dimensions().width * 0.5));
	const height = () => Math.max(1, Math.floor(dimensions().height * 0.9));
	const help = [
		{ key: "j/k", action: "Navigate" },
		{ key: "Enter", action: "Select" },
		{ key: "Esc", action: "Cancel" },
	];
	const footer = createMemo(() =>
		wrapHelpEntries(help, Math.max(1, width() - 4)),
	);
	const lines = () => Math.max(1, height() - 3 - footer().length);
	const selection = () => props.rows.findIndex((row) => row.key === selected());
	const start = () =>
		Math.min(
			Math.max(0, props.rows.length - lines()),
			Math.max(0, offset(), selection() - lines() + 1),
		);
	const select = (index: number) => {
		if (!props.active) return;
		const row = props.rows[index];
		if (!row) return;
		setSelected(row.key);
		setRefused(false);
		setOffset(Math.max(0, Math.min(start(), index)));
	};
	const move = (delta: number) =>
		select(Math.max(0, Math.min(props.rows.length - 1, selection() + delta)));
	const choose = () => {
		const key = selected();
		if (props.active && key && props.rows.some((row) => row.key === key))
			setRefused(!props.choose(key));
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.timeline-picker",
		priority: 50,
		enabled: () => props.active,
		bindings: [
			...["j", "down"].map((key) => ({ key, cmd: () => move(1) })),
			...["k", "up"].map((key) => ({ key, cmd: () => move(-1) })),
			{ key: "return", cmd: choose },
			{ key: "escape", cmd: () => props.close() },
		],
	});
	onCleanup(unregister);
	const wheel = useWheelScroll({
		enabled: () => props.active && props.rows.length > lines(),
		onScroll: (direction, delta) => move(direction === "up" ? -delta : delta),
	});
	const gesture: RowGestureState = {};
	return (
		<ReadOnlyModalFrame
			width={width()}
			height={height()}
			close={props.close}
			footerHeight={footer().length}
			header={
				<SearchHeader>
					<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
						Jump to message
					</text>
				</SearchHeader>
			}
			footer={
				<For each={footer()}>{(entries) => <HelpText entries={entries} />}</For>
			}
		>
			<box
				width="100%"
				flexDirection="column"
				flexGrow={1}
				flexShrink={1}
				minHeight={0}
				overflow="hidden"
				{...wheel}
			>
				<Show
					when={props.rows.length > 0}
					fallback={
						<text fg={uiColors.textMuted}>No user messages to show.</text>
					}
				>
					<For each={props.rows.slice(start(), start() + lines())}>
						{(row) => {
							const hover = useHover();
							const mouse = useRowMouse({
								index: () => props.rows.indexOf(row),
								selectedIndex: selection,
								gesture,
								activatable: () => props.active,
								onSelect: select,
								onActivate: (index) => {
									select(index);
									choose();
								},
							});
							return (
								<box
									width="100%"
									flexDirection="row"
									flexShrink={0}
									height={1}
									{...hover}
									{...mouse}
									backgroundColor={
										hover.hovered()
											? uiColors.bgHover
											: selected() === row.key
												? uiColors.bgSurface0
												: undefined
									}
								>
									<SelectionMarker selected={selected() === row.key} />
									<box flexGrow={1} minWidth={0} overflow="hidden">
										<text
											fg={
												selected() === row.key
													? uiColors.primary
													: uiColors.textSecondary
											}
											flexGrow={1}
											minWidth={0}
											wrapMode="none"
											truncate
										>
											{row.label}
										</text>
									</box>
								</box>
							);
						}}
					</For>
				</Show>
				<Show when={refused()}>
					<text fg={uiColors.textMuted} wrapMode="word">
						Prompt unavailable in this native window; selection was not
						replaced.
					</text>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}

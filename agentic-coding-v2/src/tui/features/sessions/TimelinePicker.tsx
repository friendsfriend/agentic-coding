/** @jsxImportSource @opentui/solid */
import { type KeyEvent, TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
	type HelpEntry,
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
import { formatClock } from "../../presentation/components/transcriptFormat.ts";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors.ts";

export type PromptTimelineRow = {
	key: string;
	label: string;
	timestamp?: number;
};
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
	const [filtering, setFiltering] = createSignal(false);
	const [query, setQuery] = createSignal("");
	const gesture: RowGestureState = {};
	// Original timeline order and label budget; never mutate the captured rows.
	const source = createMemo(() =>
		props.rows
			.slice()
			.reverse()
			.map((row) => {
				const label = Array.from(row.label);
				const timestamp = row.timestamp;
				const detail =
					typeof timestamp === "number" &&
					Number.isFinite(timestamp) &&
					timestamp >= 0 &&
					Number.isFinite(new Date(timestamp).getTime())
						? formatClock(timestamp)
						: "";
				return {
					...row,
					detail,
					label:
						label.length > 160 ? `${label.slice(0, 159).join("")}…` : row.label,
				};
			}),
	);
	const rows = createMemo(() => {
		const filter = query().trim().toLowerCase();
		return filter
			? source().filter(
					(row) =>
						row.label.toLowerCase().includes(filter) ||
						row.detail.toLowerCase().includes(filter),
				)
			: source();
	});
	const changeQuery = (value: string) => {
		setQuery(Array.from(value).slice(0, 256).join(""));
		setOffset(0);
		setRefused(false);
		gesture.down = undefined;
		gesture.lastTap = undefined;
	};
	const width = () => Math.max(1, Math.floor(dimensions().width * 0.5));
	const height = () => Math.max(1, Math.floor(dimensions().height * 0.9));
	const footer = createMemo(() =>
		wrapHelpEntries(
			filtering()
				? [
						{ key: "Type", action: "Filter query" },
						{ key: "Enter", action: "Done filtering" },
						{ key: "Esc", action: "Dismiss filter" },
					]
				: [
						{ key: "j/k", action: "Navigate" },
						{ key: "/", action: "Filter" },
						{ key: "Enter", action: "Select" },
						{ key: "Esc", action: "Cancel" },
					],
			Math.max(1, width() - 4),
		),
	);
	const showIndicator = () => rows().length > 0;
	const footerHeight = () =>
		footer().length + Number(refused()) + Number(showIndicator());
	const lines = () => Math.max(1, height() - 3 - footerHeight());
	const selection = () => rows().findIndex((row) => row.key === selected());
	const start = () =>
		Math.min(
			Math.max(0, rows().length - lines()),
			Math.max(0, offset(), selection() - lines() + 1),
		);
	const select = (index: number) => {
		if (!props.active) return;
		const row = rows()[index];
		if (!row) return;
		setSelected(row.key);
		setRefused(false);
		setOffset(Math.max(0, Math.min(start(), index)));
	};
	const move = (delta: number) =>
		select(Math.max(0, Math.min(rows().length - 1, selection() + delta)));
	const choose = () => {
		const key = selected();
		if (!props.active) return;
		setRefused(
			!key || !rows().some((row) => row.key === key) || !props.choose(key),
		);
	};
	const control = (name: string) => {
		if (!props.active) return;
		if (filtering()) {
			if (name === "escape") {
				changeQuery("");
				setFiltering(false);
			} else if (name === "enter" || name === "return") setFiltering(false);
			return;
		}
		if (name === "escape") props.close();
		else if (name === "j" || name === "down") move(1);
		else if (name === "k" || name === "up") move(-1);
		else if (name === "/") {
			changeQuery("");
			setFiltering(true);
		} else if (name === "enter" || name === "return") choose();
	};
	const footerControl = (entry: HelpEntry) => {
		// A press begun on a previous mode/width must not acquire a different
		// meaning on release. Combined navigation and typing hints are inert.
		if (!props.active || !footer().some((line) => line.includes(entry)))
			return undefined;
		return entry.key === "Enter"
			? "return"
			: entry.key === "Esc"
				? "escape"
				: entry.key === "/"
					? "/"
					: undefined;
	};
	// Original finite picker key alphabet. No editor, paste listener or global
	// keyboard hook: keys belong only to this active modal layer.
	const handleKey = (event: KeyEvent) => {
		if (!props.active) return;
		const name = event.name.toLowerCase();
		if (
			filtering() &&
			name !== "escape" &&
			name !== "enter" &&
			name !== "return"
		) {
			if (name === "backspace")
				changeQuery(Array.from(query()).slice(0, -1).join(""));
			else if (event.name.length === 1 && !event.ctrl && !event.meta)
				changeQuery(query() + event.name);
			return;
		}
		control(name);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.timeline-picker",
		priority: 50,
		enabled: () => props.active,
		bindings: [
			...new Set([
				"j",
				"k",
				"up",
				"down",
				"enter",
				"return",
				"escape",
				"/",
				"backspace",
				..."abcdefghijklmnopqrstuvwxyz".split(""),
			]),
		].map((key) => ({ key, cmd: ({ event }) => handleKey(event) })),
	});
	onCleanup(unregister);
	const wheel = useWheelScroll({
		enabled: () => props.active && rows().length > lines(),
		onScroll: (direction, delta) => move(direction === "up" ? -delta : delta),
	});
	return (
		<ReadOnlyModalFrame
			width={width()}
			height={height()}
			close={props.close}
			footerHeight={footerHeight()}
			header={
				<SearchHeader
					searchMode={filtering}
					searchQuery={query}
					resultCount={() => rows().length}
				>
					<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
						Jump to message
					</text>
				</SearchHeader>
			}
			footer={
				<>
					<Show when={showIndicator()}>
						<box
							style={{
								width: "100%",
								height: 1,
								justifyContent: "center",
								flexShrink: 0,
							}}
						>
							<text fg={uiColors.textMuted}>
								Showing {start() + 1}–
								{Math.min(rows().length, start() + lines())} of {rows().length}
							</text>
						</box>
					</Show>
					<For each={footer()}>
						{(entries) => (
							<HelpText
								entries={entries}
								activatable={(entry) => footerControl(entry) !== undefined}
								onActivate={(entry) => {
									const name = footerControl(entry);
									if (name) control(name);
								}}
							/>
						)}
					</For>
					<Show when={refused()}>
						<text fg={uiColors.textMuted} wrapMode="none" truncate>
							Selected prompt unavailable in this view; choose a visible prompt
							explicitly.
						</text>
					</Show>
				</>
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
					when={rows().length > 0}
					fallback={
						<text fg={uiColors.textMuted}>No user messages to show.</text>
					}
				>
					<For each={rows().slice(start(), start() + lines())}>
						{(row) => {
							const hover = useHover();
							const mouse = useRowMouse({
								index: () => rows().indexOf(row),
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
									<box
										flexDirection="row"
										flexGrow={1}
										minWidth={0}
										overflow="hidden"
									>
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
										<Show when={row.detail}>
											{(detail) => (
												<text fg={uiColors.textMuted} flexShrink={0}>
													{detail()}
												</text>
											)}
										</Show>
									</box>
								</box>
							);
						}}
					</For>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}

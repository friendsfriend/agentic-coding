/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Card } from "../presentation/components/Card.tsx";
import { HelpText } from "../presentation/components/HelpText.tsx";
import { ReadOnlyModalFrame } from "../presentation/components/ReadOnlyModalFrame.tsx";
import { SearchHeader } from "../presentation/components/SearchHeader.tsx";
import { useTerminalDimensions } from "../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../presentation/theme/colors.ts";
import {
	filterLocations,
	type LocationEntry,
	locationEntries,
} from "../shell/locations.ts";

/** Two rows per destination plus the frame's title, search and footer rows. */
const ROW_HEIGHT = 2;
const CHROME_ROWS = 5;

/** The v1 location picker: a jump list over the shell's destinations. It holds
 * no gateway command, draft or approval state — choosing a row navigates, and
 * nothing is ever prefilled into the prompt. */
export function LocationPicker(props: {
	/** Locations a feature published (its loaded resources). The shell owns the
	 * copy this picker reads. */
	resources?: () => LocationEntry[];
	close: () => void;
	open: (entry: LocationEntry) => void;
	current: () => { page: string; resource: string | null };
}) {
	const dimensions = useTerminalDimensions();
	const entries = createMemo(() => [
		...locationEntries(),
		...(props.resources?.() ?? []),
	]);
	const [query, setQuery] = createSignal("");
	const [index, setIndex] = createSignal(0);
	const [searching, setSearching] = createSignal(false);
	let disposed = false;
	const enabled = () => !disposed;
	const rows = createMemo(() => filterLocations(entries(), query()));
	/** Rows the frame can show; the selection window follows the cursor instead
	 * of the list growing past the modal. */
	const framedHeight = () =>
		Math.max(
			8,
			Math.min(dimensions().height - 2, Math.round(dimensions().height * 0.6)),
		);
	const visible = () =>
		Math.max(1, Math.floor((framedHeight() - CHROME_ROWS) / ROW_HEIGHT));
	const listing = createMemo(() => {
		const count = rows().length;
		const size = Math.min(visible(), count);
		const start = Math.max(0, Math.min(count - size, index() - size + 1));
		return { start, size };
	});
	const visibleRows = createMemo(() =>
		rows().slice(listing().start, listing().start + listing().size),
	);
	const selected = () =>
		rows()[Math.min(index(), Math.max(0, rows().length - 1))];
	const isCurrent = (entry: LocationEntry) =>
		props.current().page === entry.page &&
		props.current().resource === entry.resource;
	const move = (delta: number) => {
		const total = rows().length;
		if (!total) return;
		setIndex((value) => Math.max(0, Math.min(total - 1, value + delta)));
	};
	const choose = (entry: LocationEntry | undefined) => {
		if (!enabled() || !entry) return;
		queueMicrotask(() => {
			if (!enabled()) return;
			props.open(entry);
			props.close();
		});
	};
	const queryInput = (text: string) => {
		setQuery((value) => (value + text).slice(0, 64));
		setIndex(0);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.locationPicker",
		priority: 185,
		enabled,
		bindings: [
			{ key: "j", cmd: () => move(1) },
			{ key: "down", cmd: () => move(1) },
			{ key: "k", cmd: () => move(-1) },
			{ key: "up", cmd: () => move(-1) },
			{ key: "pagedown", cmd: () => move(10) },
			{ key: "pageup", cmd: () => move(-10) },
			{ key: "g", cmd: () => setIndex(0) },
			{ key: "return", cmd: () => choose(selected()) },
			{ key: "escape", cmd: () => props.close() },
			// The picker's own toggle closes it, exactly as it opened it.
			{ key: "ctrl+p", cmd: () => props.close() },
			{ key: "/", cmd: () => setSearching(true) },
			{
				key: "backspace",
				cmd: () => {
					setQuery((value) => value.slice(0, -1));
					setIndex(0);
				},
			},
		],
	});
	// Typed characters filter the list while search mode holds; the navigation
	// layer above keeps j/k/Enter/Escape, exactly as the shell's other lists.
	const unregisterTyping = useKeymap().registerLayer({
		id: "v2.locationPickerQuery",
		priority: 186,
		enabled: () => enabled() && searching(),
		commands: [],
		bindings: [
			...`abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.`
				.split("")
				.map((key) => ({ key, cmd: () => queryInput(key) })),
			{ key: "space", cmd: () => queryInput(" ") },
		],
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		unregisterTyping();
	});
	const height = () => framedHeight();
	return (
		<ReadOnlyModalFrame
			width={Math.max(
				24,
				Math.min(dimensions().width - 2, Math.round(dimensions().width * 0.6)),
			)}
			height={height()}
			active={enabled()}
			close={props.close}
			footerHeight={1}
			header={
				<box flexDirection="column" width="100%" flexShrink={0}>
					<text fg={uiColors.textPrimary} attributes={TextAttributes.BOLD}>
						Locations
					</text>
					<SearchHeader
						searchMode={searching}
						searchQuery={() => query()}
						resultCount={() => rows().length}
					/>
				</box>
			}
			footer={
				<HelpText
					entries={[
						{ key: "Enter", action: "go" },
						{ key: "/", action: "search" },
						{ key: "Esc", action: "close" },
					]}
					activatable={() => true}
					onActivate={(entry) => {
						if (entry.key === "/") setSearching(true);
						else if (entry.key === "Enter") choose(selected());
						else props.close();
					}}
				/>
			}
		>
			<box flexGrow={1} flexDirection="column" width="100%" overflow="hidden">
				<Show
					when={visibleRows().length > 0}
					fallback={
						<box paddingLeft={1}>
							<text fg={uiColors.textMuted}>No destination matches.</text>
						</box>
					}
				>
					<For each={visibleRows()}>
						{(entry, position) => (
							<Card
								height={ROW_HEIGHT}
								selected={() => listing().start + position() === index()}
								title={entry.label}
								cells={[
									<text fg={uiColors.textMuted}>
										{entry.group} · {entry.description}
										{isCurrent(entry) ? " · current" : ""}
									</text>,
								]}
								onMouseUp={() => {
									setIndex(listing().start + position());
									choose(entry);
								}}
								onActivate={() => choose(entry)}
							/>
						)}
					</For>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}

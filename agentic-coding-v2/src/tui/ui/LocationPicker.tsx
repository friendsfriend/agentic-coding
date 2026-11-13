/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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

/** Two rows per destination plus the frame's own header/footer rows. */
const ROW_HEIGHT = 2;
const CHROME_ROWS = 4;

/** The v1 location picker: a jump list over the shell's destinations. It holds
 * no gateway command, draft or approval state — choosing a row navigates, and
 * nothing is ever prefilled into the prompt. */
export function LocationPicker(props: {
	close: () => void;
	open: (entry: LocationEntry) => void;
	current: () => { page: string; resource: string | null };
}) {
	const dimensions = useTerminalDimensions();
	const entries = createMemo(() => locationEntries());
	const [query, setQuery] = createSignal("");
	const [index, setIndex] = createSignal(0);
	const [searching, setSearching] = createSignal(false);
	let disposed = false;
	const enabled = () => !disposed;
	const rows = createMemo(() => filterLocations(entries(), query()));
	/** Rows the frame can show; the selection window follows the cursor instead
	 * of the list growing past the modal. */
	const visible = () =>
		Math.max(
			1,
			Math.floor(
				(Math.min(dimensions().height - 2, 24) - CHROME_ROWS) / ROW_HEIGHT,
			),
		);
	const window = createMemo(() => {
		const count = rows().length;
		const size = Math.min(visible(), count);
		const start = Math.max(0, Math.min(count - size, index() - size + 1));
		return { start, size };
	});
	const visibleRows = createMemo(() =>
		rows().slice(window().start, window().start + window().size),
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
	const height = () =>
		Math.max(
			1,
			Math.min(
				dimensions().height - 2,
				Math.max(6, window().size * ROW_HEIGHT + CHROME_ROWS),
			),
		);
	return (
		<ReadOnlyModalFrame
			width={Math.max(1, Math.min(dimensions().width - 2, 72))}
			height={height()}
			active={enabled()}
			close={props.close}
			footerHeight={1}
			header={
				<SearchHeader
					searchMode={searching}
					searchQuery={() => query()}
					resultCount={() => rows().length}
				/>
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
							<box
								height={ROW_HEIGHT}
								width="100%"
								flexShrink={0}
								flexDirection="column"
								backgroundColor={
									window().start + position() === index()
										? uiColors.bgSurface1
										: uiColors.bgMantle
								}
							>
								<text
									fg={
										window().start + position() === index()
											? uiColors.textPrimary
											: uiColors.textMuted
									}
									attributes={
										window().start + position() === index()
											? TextAttributes.BOLD
											: undefined
									}
								>
									{entry.label}
									{isCurrent(entry) ? " · current" : ""}
								</text>
								<text fg={uiColors.textMuted}>{entry.description}</text>
							</box>
						)}
					</For>
				</Show>
			</box>
		</ReadOnlyModalFrame>
	);
}

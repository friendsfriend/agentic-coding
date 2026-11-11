/** @jsxImportSource @opentui/solid */
// v1's Home page (src/tui/shared/navigation/DestinationPage.tsx +
// destinations.ts homeDestinations): a page is a list of child destinations,
// not a tab row. The shell chrome (badge + breadcrumb) names the location, the
// body renders cards, and Enter opens the selected destination. Keybind hints
// belong to the footer and `?` help, never to the body.
import type { KeyEvent } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
	Card,
	hostBodyLines,
	type KeybindSection,
	ScrollableList,
	uiColors,
	useTerminalDimensions,
} from "../../ui/index.ts";

export type Destination = {
	id: string;
	label: string;
	description: string;
};

export function HomeView(props: {
	destinations: Destination[];
	title?: string;
	active: () => boolean;
	open: (id: string) => void;
	catalog: (catalog: KeybindSection[]) => void;
	selected: number;
	select: (index: number) => void;
}) {
	const dimensions = useTerminalDimensions();
	const [index, setIndex] = createSignal(props.selected);
	createEffect(() => {
		if (props.selected !== index()) setIndex(props.selected);
	});
	createEffect(() => {
		if (index() !== props.selected) props.select(index());
	});
	createEffect(() => {
		if (props.destinations.length && index() >= props.destinations.length)
			setIndex(props.destinations.length - 1);
	});
	const open = () => {
		const entry = props.destinations[index()];
		if (entry) props.open(entry.id);
	};
	const handle = (event: KeyEvent): boolean => {
		const key = event.name.toLowerCase();
		if (event.ctrl || event.meta || event.option) return false;
		if (key === "j" || key === "down") {
			setIndex((value) =>
				Math.min(Math.max(0, props.destinations.length - 1), value + 1),
			);
			return true;
		}
		if (key === "k" || key === "up") {
			setIndex((value) => Math.max(0, value - 1));
			return true;
		}
		if (key === "g") {
			setIndex(0);
			return true;
		}
		if (key === "enter" || key === "return") {
			open();
			return true;
		}
		return false;
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.home",
		priority: 80,
		enabled: props.active,
		commands: [{ name: "home.handle", run: ({ event }) => handle(event) }],
		bindings: ["j", "k", "g", "up", "down", "enter", "return"].map((key) => ({
			key,
			cmd: "home.handle",
		})),
	});
	createEffect(() => {
		props.catalog([
			{
				title: props.title ?? "Home",
				keybinds: [
					{ key: "j/k or ↑/↓", action: "Move selection", standard: true },
					{ key: "Enter", action: "Open destination", standard: true },
					{ key: "g", action: "First destination", standard: true },
				],
			},
		]);
	});
	onCleanup(() => {
		unregister();
		props.catalog([]);
	});
	return (
		<box
			backgroundColor={uiColors.bgBase}
			style={{ width: "100%", height: "100%", flexDirection: "column" }}
		>
			<ScrollableList
				items={props.destinations}
				itemKey={(entry) => entry.id}
				selectedIndex={index()}
				availableLines={hostBodyLines(dimensions().height)}
				estimatedItemHeight={2}
				showScrollIndicator={false}
				onSelect={setIndex}
				onActivate={(position) => {
					setIndex(position);
					const entry = props.destinations[position];
					if (entry) props.open(entry.id);
				}}
				renderItem={(entry, selected) => (
					<Card
						height={2}
						selected={selected()}
						title={entry.label}
						cells={[<text fg={uiColors.textMuted}>{entry.description}</text>]}
					/>
				)}
			/>
			<box style={{ height: 1 }} />
		</box>
	);
}

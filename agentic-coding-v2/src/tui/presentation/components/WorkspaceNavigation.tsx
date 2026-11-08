/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	onCleanup,
	Show,
} from "solid-js";
import { bindings, type Keybind } from "../../ui/keybinds.ts";
import { useTerminalDimensions } from "../hooks/useTerminalDimensions.ts";
import { uiColors } from "../theme/colors.ts";
import { useHover } from "./mouse/useHover.ts";
import { useTap } from "./mouse/useTap.ts";
import { Panel } from "./Panel.tsx";
import { PinRow } from "./PinRow.tsx";

export const workspaceNavigationKeybinds: Keybind[] = [
	{
		key: "up",
		cmd: "workspace.previous",
		action: "Previous workspace entry",
		standard: true,
	},
	{
		key: "down",
		cmd: "workspace.next",
		action: "Next workspace entry",
		standard: true,
	},
	{
		key: "k",
		cmd: "workspace.previous",
		action: "Previous workspace entry",
		standard: true,
	},
	{
		key: "j",
		cmd: "workspace.next",
		action: "Next workspace entry",
		standard: true,
	},
	{
		key: "enter",
		cmd: "workspace.open",
		action: "Open workspace entry",
		standard: true,
	},
];
/** Original workspace pin-row presentation and expanding/permanent geometry,
 * adapted to native navigation entries. Focus/activation never dispatch a task. */
export function WorkspaceNavigation(props: {
	active: boolean;
	entries: { name: string; description: string; value: string }[];
	/** Fixed leading UI pins, rendered outside the scrolling resource list. */
	pinCount?: number;
	selected: string;
	open: (value: string) => void;
	focus: () => void;
	onWidth: (width: number) => void;
}) {
	const dimensions = useTerminalDimensions();
	const [permanent, setPermanent] = createSignal(false);
	const [cursorValue, setCursorValue] = createSignal(props.selected);
	let scroll: ScrollBoxRenderable | undefined;
	const expanded = () => permanent() || props.active;
	const width = () =>
		expanded() ? Math.min(34, Math.max(6, dimensions().width - 30)) : 6;
	createEffect(() => props.onWidth(width()));
	const entries = createMemo(() => props.entries);
	const pinCount = () =>
		Math.min(entries().length, Math.max(0, Math.floor(props.pinCount ?? 0)));
	const cursor = createMemo(() =>
		entries().findIndex((entry) => entry.value === cursorValue()),
	);
	createEffect(
		on(
			() => props.selected,
			(selected) => setCursorValue(selected),
		),
	);
	const open = () => {
		// A removed identity is deliberately not replaced by its old row index.
		const entry = entries().find((entry) => entry.value === cursorValue());
		if (entry) props.open(entry.value);
	};
	const move = (direction: number) => {
		const count = entries().length;
		if (!count) return;
		const index = cursor();
		const next =
			index < 0
				? direction < 0
					? count - 1
					: 0
				: (index + direction + count) % count;
		const entry = entries()[next];
		if (entry) setCursorValue(entry.value);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.workspace-navigation",
		priority: 15,
		enabled: () => props.active,
		commands: [
			{
				id: "workspace.previous",
				name: "Previous workspace entry",
				run: () => move(-1),
			},
			{
				id: "workspace.next",
				name: "Next workspace entry",
				run: () => move(1),
			},
			{ id: "workspace.open", name: "Open workspace entry", run: open },
		],
		bindings: bindings(workspaceNavigationKeybinds),
	});
	onCleanup(unregister);
	createEffect(() => {
		const index = cursor() - pinCount();
		if (!scroll || index < 0) return;
		const height = expanded() ? 2 : 1;
		const top = index * height;
		if (top < scroll.scrollTop) scroll.scrollTo(top);
		else if (top + height > scroll.scrollTop + scroll.viewport.height)
			scroll.scrollTo(Math.max(0, top + height - scroll.viewport.height));
	});
	const toggle = useTap(
		() => {
			props.focus();
			setPermanent(!permanent());
		},
		{ stopPropagation: true },
	);
	const hover = useHover(toggle.onMouseOut);
	const glyph = (index: number) =>
		index < 4 ? (["󱚞", "π", "∞", "⌂"][index] ?? "·") : "·";
	const renderRow = (
		entry: { name: string; description: string; value: string },
		index: () => number,
	) => (
		<PinRow
			pin={{
				glyph: glyph(index()),
				label: entry.name,
				meta: entry.description,
			}}
			selected={cursorValue() === entry.value}
			height={expanded() ? 2 : 1}
			onActivate={() => {
				props.focus();
				setCursorValue(entry.value);
				// Recheck identity before navigating from a retained pointer callback.
				if (entries().some((current) => current.value === entry.value))
					props.open(entry.value);
			}}
		/>
	);
	const rows = () => (
		<>
			<For each={entries().slice(0, pinCount())}>{renderRow}</For>
			<Show when={pinCount() > 0}>
				<box height={1} flexShrink={0} paddingLeft={2}>
					<text fg={uiColors.border}>
						{"─".repeat(Math.max(0, width() - 4))}
					</text>
				</box>
			</Show>
			<scrollbox
				ref={(value) => {
					scroll = value;
				}}
				flexGrow={1}
				minHeight={0}
				scrollY={true}
			>
				<For each={entries().slice(pinCount())}>
					{(entry, index) => renderRow(entry, () => index() + pinCount())}
				</For>
			</scrollbox>
		</>
	);
	return (
		<box
			width={width()}
			flexShrink={0}
			backgroundColor={uiColors.bgMantle}
			flexDirection="column"
			minHeight={0}
			overflow="hidden"
		>
			<Show
				when={expanded()}
				fallback={
					<>
						<box height={1} paddingLeft={1} {...toggle} {...hover}>
							<text fg={uiColors.textMuted}>»</text>
						</box>
						{rows()}
					</>
				}
			>
				<Panel
					title="Workspaces"
					active={props.active}
					style={{ flexGrow: 1, minHeight: 0 }}
					accessory={
						<text fg={uiColors.textMuted} {...toggle} {...hover}>
							{permanent() ? "«" : "»"}
						</text>
					}
				>
					{rows()}
				</Panel>
			</Show>
		</box>
	);
}

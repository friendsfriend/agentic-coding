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
	selected: string;
	open: (value: string) => void;
	focus: () => void;
	onWidth: (width: number) => void;
}) {
	const dimensions = useTerminalDimensions();
	const [permanent, setPermanent] = createSignal(false);
	const [cursor, setCursor] = createSignal(0);
	let scroll: ScrollBoxRenderable | undefined;
	const expanded = () => permanent() || props.active;
	const width = () =>
		expanded() ? Math.min(34, Math.max(6, dimensions().width - 30)) : 6;
	createEffect(() => props.onWidth(width()));
	const entries = createMemo(() => props.entries);
	createEffect(
		on(
			() => props.selected,
			(selected) => {
				const index = entries().findIndex((entry) => entry.value === selected);
				if (index >= 0) setCursor(index);
			},
		),
	);
	createEffect(() => {
		const count = entries().length;
		setCursor((value) => Math.max(0, Math.min(value, count - 1)));
	});
	const open = () => {
		const entry = entries()[cursor()];
		if (entry) props.open(entry.value);
	};
	const move = (direction: number) =>
		setCursor((value) =>
			Math.max(0, Math.min(entries().length - 1, value + direction)),
		);
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
		const top = cursor() * (expanded() ? 2 : 1);
		if (!scroll) return;
		if (top < scroll.scrollTop) scroll.scrollTo(top);
		else if (top + 2 > scroll.scrollTop + scroll.viewport.height)
			scroll.scrollTo(Math.max(0, top + 2 - scroll.viewport.height));
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
	const rows = () => (
		<scrollbox
			ref={(value) => {
				scroll = value;
			}}
			flexGrow={1}
			minHeight={0}
			scrollY={true}
		>
			<For each={entries()}>
				{(entry, index) => (
					<PinRow
						pin={{
							glyph: glyph(index()),
							label: entry.name,
							meta: entry.description,
						}}
						selected={cursor() === index()}
						height={expanded() ? 2 : 1}
						onActivate={() => {
							props.focus();
							setCursor(index());
							props.open(entry.value);
						}}
					/>
				)}
			</For>
		</scrollbox>
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

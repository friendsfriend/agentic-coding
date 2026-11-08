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
	untrack,
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
		key: "e",
		cmd: "workspace.size",
		action: "Toggle expanding/permanent sidebar",
		short: "size",
	},
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
		short: "open",
	},
];
/** Original workspace pin-row presentation and expanding/permanent geometry,
 * adapted to native navigation entries. Focus/activation never dispatch a task. */
export function WorkspaceNavigation(props: {
	active: boolean;
	/** Covered surfaces must not accept focus taps or retained activations. */
	interactive?: boolean;
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
	const interactive = () => props.interactive !== false;
	const focus = () => {
		if (interactive()) props.focus();
	};
	const toggleSize = () => {
		if (interactive()) setPermanent((value) => !value);
	};
	const [cursorValue, setCursorValue] = createSignal(props.selected);
	let scroll: ScrollBoxRenderable | undefined;
	const expandedByState = () => permanent() || props.active;
	const targetWidth = () => Math.min(34, Math.max(6, dimensions().width - 30));
	const [animatedWidth, setAnimatedWidth] = createSignal(
		expandedByState() ? targetWidth() : 6,
	);
	let timer: ReturnType<typeof setInterval> | undefined;
	const stopAnimation = () => {
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
	};
	const animateTo = (target: number) => {
		stopAnimation();
		// The frame writes this signal; reading it untracked avoids restarting
		// the tween on its own frames or leaving several competing intervals.
		const start = untrack(animatedWidth);
		if (start === target) return;
		const startedAt = Date.now();
		timer = setInterval(() => {
			const progress = Math.min(1, (Date.now() - startedAt) / 150);
			const eased = 1 - (1 - progress) ** 3;
			setAnimatedWidth(Math.round(start + (target - start) * eased));
			if (progress >= 1) stopAnimation();
		}, 16);
	};
	createEffect(() => {
		if (!expandedByState()) {
			stopAnimation();
			setAnimatedWidth(6);
			return;
		}
		animateTo(targetWidth());
	});
	onCleanup(stopAnimation);
	// State gates both surfaces: a delayed frame can never keep full rows or
	// an expanded width on screen after focus/mode asks for the compact strip.
	const width = () =>
		expandedByState() ? Math.min(animatedWidth(), targetWidth()) : 6;
	const expanded = () => expandedByState() && width() >= 14;
	createEffect(() => props.onWidth(width()));
	const entries = createMemo(() => props.entries);
	const entriesByKey = createMemo(
		() =>
			new Map(entries().map((entry, index) => [entry.value, { entry, index }])),
	);
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
		if (!props.active || !interactive()) return;
		// A removed identity is deliberately not replaced by its old row index.
		const entry = entries().find((entry) => entry.value === cursorValue());
		if (entry) props.open(entry.value);
	};
	const move = (direction: number) => {
		if (!props.active || !interactive()) return;
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
		enabled: () => props.active && interactive(),
		commands: [
			{
				id: "workspace.size",
				name: "Toggle sidebar size",
				run: () => {
					if (props.active) toggleSize();
				},
			},
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
		const height = expanded() ? 2 : 1;
		if (!scroll || index < 0) return;
		const top = index * height;
		if (top < scroll.scrollTop) scroll.scrollTo(top);
		else if (top + height > scroll.scrollTop + scroll.viewport.height)
			scroll.scrollTo(Math.max(0, top + height - scroll.viewport.height));
	});
	const toggle = useTap(
		() => {
			if (!interactive()) return;
			focus();
			toggleSize();
		},
		{ stopPropagation: true },
	);
	const hover = useHover(toggle.onMouseOut);
	const glyph = (index: number) =>
		index < 4 ? (["󱚞", "π", "∞", "⌂"][index] ?? "·") : "·";
	const renderRow = (key: string) => (
		<Show when={entriesByKey().get(key)}>
			{(slot) => (
				<PinRow
					pin={{
						glyph: glyph(slot().index),
						label: slot().entry.name,
						meta: slot().entry.description,
					}}
					selected={cursorValue() === key}
					height={expanded() ? 2 : 1}
					onActivate={() => {
						// Stable presentation identity, but always read current membership.
						if (!interactive() || !entriesByKey().has(key)) return;
						focus();
						setCursorValue(key);
						props.open(key);
					}}
				/>
			)}
		</Show>
	);
	const rows = () => (
		<>
			<For
				each={entries()
					.slice(0, pinCount())
					.map((entry) => entry.value)}
			>
				{renderRow}
			</For>
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
				<For
					each={entries()
						.slice(pinCount())
						.map((entry) => entry.value)}
				>
					{renderRow}
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
			{...useTap(focus)}
		>
			<Show
				when={expanded()}
				fallback={
					<>
						<box
							height={1}
							flexShrink={0}
							paddingLeft={1}
							backgroundColor={hover.hovered() ? uiColors.bgHover : undefined}
							{...toggle}
							{...hover}
						>
							<text
								fg={hover.hovered() ? uiColors.textPrimary : uiColors.textMuted}
							>
								{permanent() ? "«" : "»"}
							</text>
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
						<text
							fg={
								props.active
									? uiColors.primary
									: hover.hovered()
										? uiColors.textPrimary
										: uiColors.textMuted
							}
							bg={hover.hovered() ? uiColors.bgHover : undefined}
							{...toggle}
							{...hover}
						>
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

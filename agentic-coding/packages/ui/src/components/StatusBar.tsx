/** @jsxImportSource @opentui/solid */
// Footer bar — one implementation for every surface.
//
// The shell keeps it one row high: special keybinds fill a clipping left column
// and `?` help is pinned right so it stays visible however many keys precede it.
// A surface that spreads keybinds over several rows (the env surface reserves
// three footer lines) asks for more lines and the entries wrap into them.
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, Show } from "solid-js";
import { uiColors } from "../theme/colors";
import { HelpText } from "./HelpText.tsx";
import type { Keybind } from "./keybinds.ts";
import {
	activeKeybindCatalog,
	activeKeybindContext,
	footerKeybinds,
} from "./keybinds.ts";
import { RunningText } from "./RunningText.tsx";

export type { Keybind };

/** Fallback right-anchored entry so `?` help is advertised on every surface. */
const FALLBACK_HELP: Keybind = { key: "?", action: "help" };

export interface StatusBarProps {
	/** Text shown before the keybinds (e.g. a filter prompt). */
	prompt?: string;
	/** Explicit keybinds; defaults to the active catalog's special keys. */
	keybinds?: readonly Keybind[];
	/** Left/centre/right text cells, as the env surface's footer uses them. */
	left?: string;
	center?: string;
	right?: string;
	/** Rows the footer may use. Default 1 (the shell footer). */
	lines?: number;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

export function StatusBar(props: StatusBarProps) {
	const dimensions = useTerminalDimensions();
	const lines = () => Math.max(1, props.lines ?? 1);
	const keybinds = () =>
		props.keybinds
			? [...props.keybinds]
			: footerKeybinds(activeKeybindCatalog(), activeKeybindContext());
	const help = () =>
		keybinds().find((keybind) => keybind.key === "?") ?? FALLBACK_HELP;
	const entries = () => keybinds().filter((keybind) => keybind.key !== "?");

	/**
	 * Wrap the keybinds into the available rows, keeping each `key action` pair
	 * whole. Only used when the surface asked for more than one row.
	 */
	const wrapped = createMemo(() => {
		const all = entries();
		if (all.length === 0) return [[]];
		const width = Math.max(1, dimensions().width - 2);
		const rows: Keybind[][] = [];
		let row: Keybind[] = [];
		let used = 0;
		for (const entry of all) {
			const chunk = entry.key.length + 1 + entry.action.length + 2;
			if (row.length > 0 && used + chunk > width) {
				rows.push(row);
				row = [];
				used = 0;
			}
			row.push(entry);
			used += chunk;
		}
		if (row.length > 0) rows.push(row);
		return rows.slice(0, lines());
	});

	/** The env surface's footer: one cells row, then the keybind rows. */
	if (props.left !== undefined || props.center !== undefined) {
		const cell = (
			value: string | undefined,
			align: "left" | "center" | "right",
		) =>
			value === undefined || value === "" ? null : (
				<box
					style={{
						flexGrow: 1,
						flexShrink: 1,
						minWidth: 0,
						justifyContent:
							align === "left"
								? "flex-start"
								: align === "center"
									? "center"
									: "flex-end",
					}}
				>
					<RunningText
						text={value}
						align={align === "right" ? "right" : "left"}
						fg={
							align === "center" ? uiColors.textMuted : uiColors.textSecondary
						}
						enabled={props.runningTextEnabled}
						offset={props.runningTextOffset}
					/>
				</box>
			);
		const keybindRows = () => wrapped().slice(0, Math.max(0, lines() - 1));
		return (
			<box
				backgroundColor={uiColors.bgMantle}
				style={{ width: "100%", height: lines(), flexDirection: "column" }}
			>
				<box
					style={{
						width: "100%",
						height: 1,
						flexShrink: 0,
						flexDirection: "row",
						alignItems: "center",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					{cell(props.left, "left")}
					{cell(props.center, "center")}
					{cell(props.right, "right")}
				</box>
				{keybindRows().map((row) => (
					<box
						style={{
							width: "100%",
							height: 1,
							flexShrink: 0,
							flexDirection: "row",
							alignItems: "center",
							paddingLeft: 1,
							paddingRight: 1,
						}}
					>
						<HelpText entries={row} />
					</box>
				))}
			</box>
		);
	}

	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: lines(),
				flexDirection: "row",
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<box
				style={{
					flexGrow: 1,
					flexShrink: 1,
					minWidth: 0,
					overflow: "hidden",
					flexDirection: lines() > 1 ? "column" : "row",
				}}
			>
				<Show when={props.prompt}>
					<text fg={uiColors.textMuted} attributes={TextAttributes.DIM}>
						{props.prompt}
					</text>
				</Show>
				{lines() === 1 ? (
					<HelpText entries={entries()} />
				) : (
					wrapped().map((row) => <HelpText entries={row} />)
				)}
			</box>
			<box style={{ flexShrink: 0, marginLeft: 1 }}>
				<HelpText entries={[help()]} />
			</box>
		</box>
	);
}

/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For, type JSX } from "solid-js";
import { uiColors } from "./colors";
import { type Keybind, keybindFooterLabel } from "./keybinds";

/** A help entry is a keybind; kept as an alias for existing imports. */
export type HelpEntry = Keybind;

export interface HelpTextProps {
	/** Keybinds to display. The component owns colors and separation. */
	entries: readonly Keybind[];
}

/**
 * HelpText Component - Displays formatted keybinding help text
 *
 * Single footer renderer for every surface. Entries are pure data; colors and
 * the bullet separator live here so callers cannot restyle individual keys.
 */
export function HelpText(props: HelpTextProps): JSX.Element {
	return (
		<text style={{ fg: uiColors.textMuted }}>
			<For each={props.entries}>
				{(entry, index) => (
					<>
						<span
							style={{ fg: uiColors.primary, attributes: TextAttributes.BOLD }}
						>
							{entry.key}
						</span>{" "}
						{keybindFooterLabel(entry)}
						{index() < props.entries.length - 1 ? "  •  " : ""}
					</>
				)}
			</For>
		</text>
	);
}

/**
 * Group keybinds into footer rows no wider than `maxWidth`, keeping each entry
 * atomic so a key and its action are never split across lines.
 */
export function wrapHelpEntries(
	entries: readonly Keybind[],
	maxWidth: number,
	separator: string = "  •  ",
): Keybind[][] {
	if (maxWidth <= 0) return entries.length ? [[entries[0]]] : [[]];

	const lines: Keybind[][] = [];
	let current: Keybind[] = [];
	let currentLength = 0;

	for (const entry of entries) {
		const chunkLength = entry.key.length + 1 + keybindFooterLabel(entry).length;
		const candidate =
			current.length === 0
				? chunkLength
				: currentLength + separator.length + chunkLength;
		if (current.length > 0 && candidate > maxWidth) {
			lines.push(current);
			current = [entry];
			currentLength = chunkLength;
		} else {
			current.push(entry);
			currentLength = candidate;
		}
	}

	if (current.length) lines.push(current);
	return lines.length ? lines : [[]];
}

/**
 * Helper function to create help text string from entries
 * Useful for components that need a plain string (e.g., GenericModal helpText prop)
 */
export function formatHelpText(
	entries: readonly Keybind[],
	separator: string = "  •  ",
): string {
	return entries
		.map((entry) => `${entry.key} ${keybindFooterLabel(entry)}`)
		.join(separator);
}

export function formatHelpTextLines(
	entries: readonly Keybind[],
	maxWidth: number,
	separator: string = "  •  ",
): string[] {
	if (maxWidth <= 0) return [""];

	const chunks = entries.map(
		(chunk) => `${chunk.key} ${keybindFooterLabel(chunk)}`,
	);
	const lines: string[] = [];
	let current = "";

	for (const chunk of chunks) {
		const candidate = current ? `${current}${separator}${chunk}` : chunk;
		if (current && candidate.length > maxWidth) {
			lines.push(current);
			current = chunk;
		} else {
			current = candidate;
		}
	}

	if (current) lines.push(current);
	return lines.length ? lines : [""];
}

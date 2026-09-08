/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { For, type JSX } from "solid-js";
import { uiColors } from "./colors";

export interface HelpEntry {
	/** Keybinding (e.g., "j/k", "Enter", "Ctrl+S") */
	key: string;
	/** Action description (e.g., "Navigate", "Select", "Save") */
	action: string;
}

export interface HelpTextProps {
	/** Array of help entries to display */
	entries: HelpEntry[];
	/** Text color for actions (default: textMuted) */
	textColor?: string;
	/** Color for keybindings (default: primary) */
	keyColor?: string;
	/** Separator between entries (default: "  •  ") */
	separator?: string;
}

/**
 * HelpText Component - Displays formatted keybinding help text
 *
 * Provides consistent formatting for help text across all components.
 * Matches the style used in StatusBar component.
 *
 * Features:
 * - Keys displayed in bold with primary color
 * - Actions in muted text color
 * - Bullet separator between entries
 * - Customizable colors and separator
 */
export function HelpText(props: HelpTextProps): JSX.Element {
	const textColor = () => props.textColor ?? uiColors.textMuted;
	const keyColor = () => props.keyColor ?? uiColors.primary;
	const separator = () => props.separator ?? "  •  ";

	return (
		<text style={{ fg: textColor() }}>
			<For each={props.entries}>
				{(entry, index) => (
					<>
						<span style={{ fg: keyColor(), attributes: TextAttributes.BOLD }}>
							{entry.key}
						</span>{" "}
						{entry.action}
						{index() < props.entries.length - 1 ? separator() : ""}
					</>
				)}
			</For>
		</text>
	);
}

/**
 * Helper function to create help text string from entries
 * Useful for components that need a plain string (e.g., GenericModal helpText prop)
 */
export function formatHelpText(
	entries: HelpEntry[],
	separator: string = "  •  ",
): string {
	return entries.map((entry) => `${entry.key} ${entry.action}`).join(separator);
}

export function formatHelpTextLines(
	entries: HelpEntry[],
	maxWidth: number,
	separator: string = "  •  ",
): string[] {
	if (maxWidth <= 0) return [""];

	const chunks = entries.map((chunk) => `${chunk.key} ${chunk.action}`);
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

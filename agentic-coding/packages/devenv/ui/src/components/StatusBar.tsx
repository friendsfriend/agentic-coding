/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo } from "solid-js";
import { uiColors } from "../colors";

export interface StatusBarProps {
	left?: string;
	center?: string;
	right?: string;
	keybinds?: Array<{ key: string; action: string }>;
	runningTextEnabled?: boolean;
	runningTextOffset?: number;
}

/**
 * Status bar at the bottom with keybind hints
 * Automatically truncates keybinds if they exceed terminal width
 */
export function StatusBar(props: StatusBarProps) {
	const dimensions = useTerminalDimensions();

	// Calculate how many keybinds can fit on three lines based on terminal width
	const keybindLines = createMemo(() => {
		if (!props.keybinds) return { line1: [], line2: [], line3: [] };

		const termWidth = dimensions().width;
		const padding = 2; // left and right padding
		const separatorLength = 5; // "  •  "

		const line1: Array<{ key: string; action: string }> = [];
		const line2: Array<{ key: string; action: string }> = [];
		const line3: Array<{ key: string; action: string }> = [];

		let usedWidthLine1 = padding;
		let usedWidthLine2 = padding;
		let usedWidthLine3 = padding;
		let currentLine = 1;

		for (const bind of props.keybinds) {
			// Estimate width: key + space + action + separator
			const bindWidth =
				bind.key.length + 1 + bind.action.length + separatorLength;

			if (currentLine === 1) {
				if (usedWidthLine1 + bindWidth > termWidth - 5) {
					// Move to second line
					currentLine = 2;
					line2.push(bind);
					usedWidthLine2 += bindWidth;
				} else {
					line1.push(bind);
					usedWidthLine1 += bindWidth;
				}
			} else if (currentLine === 2) {
				if (usedWidthLine2 + bindWidth > termWidth - 5) {
					// Move to third line
					currentLine = 3;
					line3.push(bind);
					usedWidthLine3 += bindWidth;
				} else {
					line2.push(bind);
					usedWidthLine2 += bindWidth;
				}
			} else {
				if (usedWidthLine3 + bindWidth > termWidth - 5) {
					// Out of space, add help indicator if not present
					if (
						!line3.some((b) => b.key === "?") &&
						!line2.some((b) => b.key === "?") &&
						!line1.some((b) => b.key === "?")
					) {
						line3.push({ key: "?", action: "Help" });
					}
					break;
				} else {
					line3.push(bind);
					usedWidthLine3 += bindWidth;
				}
			}
		}

		return { line1, line2, line3 };
	});

	return (
		<box
			backgroundColor={uiColors.bgMantle}
			style={{
				width: "100%",
				height: 3,
				flexDirection: "column",
			}}
		>
			{/* Keybinds line 1 */}
			{props.keybinds && keybindLines().line1.length > 0 && (
				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						alignItems: "center",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					{keybindLines().line1.map((bind, idx) => (
						<text style={{ fg: uiColors.textMuted }}>
							<span
								style={{
									fg: uiColors.primary,
									attributes: TextAttributes.BOLD,
								}}
							>
								{bind.key}
							</span>{" "}
							{bind.action}
							{idx < keybindLines().line1.length - 1 ? "  •  " : ""}
						</text>
					))}
				</box>
			)}

			{/* Keybinds line 2 */}
			{props.keybinds && keybindLines().line2.length > 0 && (
				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						alignItems: "center",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					{keybindLines().line2.map((bind, idx) => (
						<text style={{ fg: uiColors.textMuted }}>
							<span
								style={{
									fg: uiColors.primary,
									attributes: TextAttributes.BOLD,
								}}
							>
								{bind.key}
							</span>{" "}
							{bind.action}
							{idx < keybindLines().line2.length - 1 ? "  •  " : ""}
						</text>
					))}
				</box>
			)}

			{/* Keybinds line 3 */}
			{props.keybinds && keybindLines().line3.length > 0 && (
				<box
					style={{
						width: "100%",
						height: 1,
						flexDirection: "row",
						alignItems: "center",
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					{keybindLines().line3.map((bind, idx) => (
						<text style={{ fg: uiColors.textMuted }}>
							<span
								style={{
									fg: uiColors.primary,
									attributes: TextAttributes.BOLD,
								}}
							>
								{bind.key}
							</span>{" "}
							{bind.action}
							{idx < keybindLines().line3.length - 1 ? "  •  " : ""}
						</text>
					))}
				</box>
			)}
		</box>
	);
}

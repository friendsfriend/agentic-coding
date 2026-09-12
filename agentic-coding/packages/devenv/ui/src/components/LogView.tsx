/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createSignal, For } from "solid-js";
import { uiColors } from "../colors";

export interface LogViewProps {
	/** Log content to display */
	logs: string;
	/** Callback when user presses ESC to close */
	onClose: () => void;
	/** Current scroll position (0-1, where 1 is bottom) */
	scrollPosition?: number;
	/** Callback when scroll position changes */
	onScroll?: (position: number) => void;
}

/**
 * LogView - Displays scrollable runtime logs in a bordered panel
 *
 * Based on Go's tui/logView.go but adapted for OpenTUI/SolidJS.
 *
 * Features:
 * - Scrollable viewport with wide content (prevents wrapping)
 * - Keyboard navigation handled by parent-level keyboard router
 * - ESC to close (handled by parent)
 * - Auto-scroll to bottom when opened
 * - Uses Layout header for title, footer (StatusBar) for keybindings
 *
 * @example
 * ```tsx
 * <LogView
 *   logs={containerLogs}
 *   onClose={() => setShowLogs(false)}
 * />
 * ```
 */
export function LogView(props: LogViewProps) {
	const dimensions = useTerminalDimensions();

	// Split logs into lines for scrolling
	const lines = () => props.logs.split("\n");
	const [scrollOffset, setScrollOffset] = createSignal(0);
	const [_isAtBottom, setIsAtBottom] = createSignal(true);

	// Calculate viewport height (total height - borders - padding - margins)
	// Total height minus: outer padding (2), border (2), inner padding (2), header space (1), footer space (1) = -8
	const viewportHeight = () => Math.max(5, dimensions().height - 8);

	// Calculate maximum scroll offset to prevent scrolling past the last line
	const maxScrollOffset = () => Math.max(0, lines().length - viewportHeight());

	// Auto-scroll to bottom when logs first load or change
	createEffect(() => {
		const _totalLines = lines().length;
		// Start at the bottom - scroll to show the last viewportHeight lines
		const maxOffset = maxScrollOffset();
		setScrollOffset(maxOffset);
		setIsAtBottom(true);
	});

	const lineStyle = (
		line: string,
	): { fg: string; bg?: string; attributes?: number } => {
		const normalized = line.toLowerCase();
		const isCommandEnd =
			/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ---\s*$/.test(line.trim());
		const isSuccess =
			/\b(build successful|tests passed|run successful|start successful|completed)\b/.test(
				normalized,
			);
		const isFailure =
			/\b(error:|failed|exit status [1-9]|command failed)\b/.test(normalized);

		if (isCommandEnd) {
			return {
				fg: uiColors.highlight,
				bg: uiColors.bgSurface0,
				attributes: TextAttributes.BOLD,
			};
		}
		if (isFailure) {
			return {
				fg: uiColors.error,
				bg: uiColors.diffRemovedBg,
				attributes: TextAttributes.BOLD,
			};
		}
		if (isSuccess) {
			return {
				fg: uiColors.success,
				bg: uiColors.diffAddedBg,
				attributes: TextAttributes.BOLD,
			};
		}
		return { fg: uiColors.textPrimary };
	};

	const decoratedLine = (line: string): string => {
		if (/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] ---\s*$/.test(line.trim())) {
			return `${line}  execution finished`;
		}
		return line;
	};

	// Get visible lines - return array of individual lines for rendering
	const visibleLines = () => {
		const allLines = lines();
		const offset = scrollOffset();
		const height = viewportHeight();
		// Return array of lines (from offset to offset + height)
		return allLines.slice(offset, offset + height);
	};

	return (
		<box
			style={{
				width: "100%",
				height: "100%",
				flexDirection: "column",
				padding: 1,
			}}
		>
			{/* Log content container with border */}
			<box
				style={{
					width: "100%",
					height: "100%",
					flexDirection: "column",
					backgroundColor: uiColors.bgMantle,
					padding: 1,
				}}
			>
				{/* Scrollable log content - maintains full height */}
				<box
					style={{
						width: "100%",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<For each={visibleLines()}>
						{(line) => {
							const style = () => lineStyle(line);
							return (
								<box
									style={{
										width: "100%",
										height: 1,
										flexShrink: 0,
										backgroundColor: style().bg,
									}}
								>
									<text
										style={{ fg: style().fg }}
										attributes={style().attributes}
									>
										{decoratedLine(line)}
									</text>
								</box>
							);
						}}
					</For>
				</box>
			</box>
		</box>
	);
}

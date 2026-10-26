/** @jsxImportSource @opentui/solid */
import { uiColors } from "@agentic-coding/ui";
import { createMemo, createSignal } from "solid-js";
import type { ToolViewRow } from "./tool-views.ts";
import { estimateTextRows, VirtualToolBody } from "./transcript-viewport.tsx";

/** OpenCode reserves ten compact rows for command, separator and output. Keep
 * the tail rather than the head, so each streamed chunk is visible immediately. */
export function shellOutputPreview(
	command: string,
	output: string,
	width: number,
): string {
	const columns = Math.max(20, width);
	const commandLines = Math.min(
		2,
		Math.max(
			1,
			command
				.split("\n")
				.reduce(
					(total, line) =>
						total + Math.max(1, Math.ceil(Array.from(line).length / columns)),
					0,
				),
		),
	);
	const maxLines = 10 - commandLines - 1;
	const maxChars = maxLines * columns;
	const lines = output.split("\n");
	if (lines.length <= maxLines && Array.from(output).length <= maxChars)
		return output;
	const count = Math.max(1, lines.length - (maxLines - 1));
	const label = `(${count} earlier ${count === 1 ? "line" : "lines"})`;
	const tail = Array.from(lines.slice(-(maxLines - 1)).join("\n"));
	return `${label}\n${tail.slice(-Math.max(0, maxChars - label.length - 1)).join("")}`;
}

export function TranscriptShellOutput(props: {
	command: string;
	rows: readonly ToolViewRow[];
	expanded: boolean;
	failed: boolean;
}) {
	const [width, setWidth] = createSignal(80);
	const output = createMemo(() => props.rows.map((row) => row.text).join("\n"));
	const preview = createMemo(() =>
		props.expanded
			? ""
			: shellOutputPreview(props.command, output().trimEnd(), width()),
	);
	return (
		<box
			paddingTop={props.rows.length > 0 ? 1 : 0}
			flexDirection="column"
			onSizeChange={function () {
				setWidth(this.width);
			}}
		>
			<VirtualToolBody
				cacheKey={props.expanded ? output() : preview()}
				estimateHeight={(columns) =>
					estimateTextRows(props.expanded ? output() : preview(), columns)
				}
			>
				<text
					fg={props.failed ? uiColors.error : uiColors.textMuted}
					wrapMode="char"
					maxHeight={props.expanded ? undefined : 8}
				>
					{props.expanded ? output() : preview()}
				</text>
			</VirtualToolBody>
		</box>
	);
}

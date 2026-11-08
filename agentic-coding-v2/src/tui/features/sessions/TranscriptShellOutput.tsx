/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal } from "solid-js";
import { uiColors } from "../../presentation/theme/colors.ts";

/** Original compact shell tail: ten rows shared by command, separator and
 * output. This is a display window, not another native capture/truncation. */
function shellOutputPreview(
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

/** Original TranscriptShellOutput presentation with native text input instead
 * of legacy ToolViewRow/viewport state. Expansion displays every supplied byte;
 * error color is supplied only from an observed native result. */
export function TranscriptShellOutput(props: {
	command: string;
	output: string;
	expanded: boolean;
	failed: boolean;
}) {
	const [width, setWidth] = createSignal(80);
	const preview = createMemo(() =>
		props.expanded
			? ""
			: shellOutputPreview(props.command, props.output.trimEnd(), width()),
	);
	return (
		<box
			paddingTop={props.output.length > 0 ? 1 : 0}
			flexDirection="column"
			onSizeChange={function () {
				setWidth(this.width);
			}}
		>
			<text
				fg={props.failed ? uiColors.error : uiColors.textMuted}
				wrapMode="char"
				maxHeight={props.expanded ? undefined : 8}
			>
				{props.expanded ? props.output : preview()}
			</text>
		</box>
	);
}

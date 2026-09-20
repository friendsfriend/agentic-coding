import { TextAttributes } from "@opentui/core";
import {
	HighlightedText,
	ScrollableContent,
	SearchHeader,
	uiColors,
} from "@ui";
import type { TreeNode } from "../../../contracts/telemetry.ts";

const duration = (node: TreeNode) =>
	`${Math.max(0, Number((BigInt(node.span.endTimeUnixNano) - BigInt(node.span.startTimeUnixNano)) / 1_000_000n))}ms`;
const title = (key: string) =>
	key === "herdr.content.input"
		? "Message input"
		: key === "herdr.content.output"
			? "Message output"
			: key === "herdr.content.tool_input"
				? "Tool input"
				: key === "herdr.content.tool_output"
					? "Tool output"
					: key;

/** Captured session content: rendered wrapped, not as one clipped row, because
 * the whole point of the capture is reading the prompt, command or output. */
const CONTENT_PREFIX = "herdr.content.";

/** JSON payloads (tool arguments and results) are indented so a command and
 * its output stay readable; plain text is shown as captured. */
export function prettyContent(value: unknown): string {
	const text = String(value);
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		return text;
	}
}

export function SpanDetailView(props: { node: () => TreeNode | undefined }) {
	const node = () => props.node();
	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box height={1} flexShrink={0} paddingLeft={1}>
				<text fg={uiColors.textMuted}>
					{(() => {
						const current = node();
						return current
							? `${current.span.serviceName} · ${duration(current)} · ${current.span.status.code === 2 ? "ERROR" : "OK"}`
							: "No span selected";
					})()}
				</text>
			</box>
			<SearchHeader>
				<HighlightedText text="Attributes" highlight="secondary" />
			</SearchHeader>
			<ScrollableContent focusable={false}>
				{(node()?.span.attributes ?? []).map((attribute) =>
					attribute.key.startsWith(CONTENT_PREFIX) ? (
						<box
							flexShrink={0}
							flexDirection="column"
							paddingLeft={1}
							paddingRight={1}
						>
							<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
								{title(attribute.key)}
							</text>
							<text fg={uiColors.textSecondary} wrapMode="word">
								{prettyContent(attribute.value)}
							</text>
						</box>
					) : (
						<box
							height={1}
							flexShrink={0}
							flexDirection="row"
							paddingLeft={1}
							paddingRight={1}
						>
							<box style={{ width: 24, flexShrink: 0 }} overflow="hidden">
								<text fg={uiColors.primary}>{title(attribute.key)}</text>
							</box>
							<box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden">
								<text fg={uiColors.textSecondary}>
									{String(attribute.value)}
								</text>
							</box>
						</box>
					),
				)}
			</ScrollableContent>
		</box>
	);
}

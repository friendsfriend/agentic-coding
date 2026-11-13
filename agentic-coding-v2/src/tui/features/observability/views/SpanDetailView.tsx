import { TextAttributes } from "@opentui/core";
import { For, Show } from "solid-js";
import type { SpanData, TreeNode } from "../../../../telemetry/contracts.ts";
import {
	HighlightedText,
	ScrollableContent,
	SearchHeader,
	uiColors,
} from "../../../ui/index.ts";

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

function AttributeRows(props: {
	attributes: () => SpanData["attributes"];
	wrap?: boolean;
}) {
	return (
		<For each={props.attributes()}>
			{(attribute) =>
				props.wrap || attribute.key.startsWith(CONTENT_PREFIX) ? (
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
						<box width={24} flexShrink={0} overflow="hidden">
							<text fg={uiColors.primary}>{title(attribute.key)}</text>
						</box>
						<box flexGrow={1} minWidth={0} overflow="hidden">
							<text fg={uiColors.textSecondary}>{String(attribute.value)}</text>
						</box>
					</box>
				)
			}
		</For>
	);
}

export function SpanDetailView(props: { node: () => TreeNode | undefined }) {
	const node = props.node;
	const identity = () => {
		const span = node()?.span;
		if (!span) return [];
		return [
			{ key: "Trace ID", value: span.traceId },
			{ key: "Span ID", value: span.spanId },
			{ key: "Parent span ID", value: span.parentSpanId || "(none)" },
			{
				key: "Kind",
				value:
					[
						"UNSPECIFIED",
						"INTERNAL",
						"SERVER",
						"CLIENT",
						"PRODUCER",
						"CONSUMER",
					][span.kind] ?? String(span.kind),
			},
		];
	};
	return (
		<box width="100%" height="100%" flexDirection="column">
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
			<Show when={node()?.relation}>
				<box flexShrink={0} paddingLeft={1} paddingRight={1}>
					<text fg={uiColors.warning} wrapMode="word">
						Tree edge break: {node()?.relation}. Displayed as a root; original
						parent {node()?.span.parentSpanId || "(none)"} is retained.
					</text>
				</box>
			</Show>
			<ScrollableContent focusable={false}>
				<Show when={node()?.span.status.message}>
					<SearchHeader>
						<HighlightedText text="Status message" highlight="secondary" />
					</SearchHeader>
					<box flexShrink={0} paddingLeft={1} paddingRight={1}>
						<text
							fg={
								node()?.span.status.code === 2
									? uiColors.error
									: uiColors.textSecondary
							}
							wrapMode="word"
						>
							{String(node()?.span.status.message ?? "")}
						</text>
					</box>
				</Show>
				<SearchHeader>
					<HighlightedText text="Attributes" highlight="secondary" />
				</SearchHeader>
				<AttributeRows attributes={() => node()?.span.attributes ?? []} />
				<Show when={(node()?.span.events?.length ?? 0) > 0}>
					<SearchHeader>
						<HighlightedText text="Events" highlight="secondary" />
					</SearchHeader>
					<For each={node()?.span.events ?? []}>
						{(event) => (
							<box flexShrink={0} flexDirection="column">
								<box
									height={1}
									flexShrink={0}
									paddingLeft={1}
									flexDirection="row"
								>
									<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
										{event.name}
									</text>
									<text fg={uiColors.textMuted}>
										{" "}
										·{" "}
										{new Date(
											Number(BigInt(event.timeUnixNano) / 1_000_000n),
										).toISOString()}
									</text>
								</box>
								<AttributeRows attributes={() => event.attributes} wrap />
							</box>
						)}
					</For>
				</Show>
				<SearchHeader>
					<HighlightedText text="Identity" highlight="secondary" />
				</SearchHeader>
				<AttributeRows attributes={identity} />
				<Show when={(node()?.span.resource.attributes.length ?? 0) > 0}>
					<SearchHeader>
						<HighlightedText text="Resource" highlight="secondary" />
					</SearchHeader>
					<AttributeRows
						attributes={() => node()?.span.resource.attributes ?? []}
					/>
				</Show>
				<Show when={node()?.span.scope.name || node()?.span.scope.version}>
					<SearchHeader>
						<HighlightedText
							text="Instrumentation scope"
							highlight="secondary"
						/>
					</SearchHeader>
					<AttributeRows
						attributes={() => [
							{ key: "Name", value: node()?.span.scope.name ?? "" },
							{ key: "Version", value: node()?.span.scope.version ?? "" },
						]}
					/>
				</Show>
			</ScrollableContent>
		</box>
	);
}

/** @jsxImportSource @opentui/solid */

import { TextAttributes } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import {
	createKeyedItems,
	HighlightedText,
	ScrollableContent,
	SearchHeader,
	uiColors,
} from "../../../ui/index.ts";
import type { LogStore } from "../model/logStore.ts";

export function LogDetailView(props: {
	store: LogStore;
	index: number;
	onTraceLink?: (traceId: string) => void;
}) {
	const log = createMemo(() => props.store.getLogs()[props.index]);
	const attributes = createKeyedItems(
		() => log()?.attributes ?? [],
		(attribute) => attribute.key,
	);

	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box height={1} flexShrink={0} paddingLeft={1}>
				<text fg={uiColors.textMuted}>
					{log()?.severity ?? "UNKNOWN"} · {log()?.serviceName} ·{" "}
					{log()?.timeUnixNano
						? new Date(
								Number(BigInt(log()?.timeUnixNano) / 1_000_000n),
							).toLocaleString()
						: "—"}
				</text>
			</box>

			{/* Body */}
			<box
				height={3}
				flexShrink={0}
				paddingLeft={1}
				paddingRight={1}
				flexDirection="column"
			>
				<text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>
					Body
				</text>
				<text fg={uiColors.textPrimary}>{log()?.body ?? ""}</text>
			</box>

			{/* Trace/span link */}
			<Show when={log()?.traceId}>
				{(traceId) => (
					<box height={1} flexDirection="row" paddingLeft={1}>
						<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
							Trace:{" "}
						</text>
						<text fg={uiColors.accent}>{traceId()}</text>
						<Show when={log()?.spanId}>
							{(spanId) => (
								<>
									<text fg={uiColors.primary}> Span: </text>
									<text fg={uiColors.accent}>{spanId()}</text>
								</>
							)}
						</Show>
					</box>
				)}
			</Show>

			{/* Attributes */}
			<SearchHeader>
				<HighlightedText text="Attributes" highlight="secondary" />
			</SearchHeader>
			<ScrollableContent focusable={false}>
				<For each={attributes()}>
					{(slot) => (
						<box
							height={1}
							flexShrink={0}
							flexDirection="row"
							paddingLeft={1}
							paddingRight={1}
						>
							<box style={{ width: 24, flexShrink: 0 }} overflow="hidden">
								<text fg={uiColors.primary}>{slot.value().key}</text>
							</box>
							<box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden">
								<text fg={uiColors.textSecondary}>{slot.value().value}</text>
							</box>
						</box>
					)}
				</For>
			</ScrollableContent>
		</box>
	);
}

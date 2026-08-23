/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import { TraceStore } from "../../otel/model/traceStore.ts";
import type { SpanData, TreeNode } from "../../otel/model/types.ts";
import { uiColors } from "./colors";

function duration(span: SpanData): string {
	return `${Math.max(0, Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n))}ms`;
}

function flatten(nodes: TreeNode[]): TreeNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Embedded read-only trace viewer for a single change's workflow spans, backed by
 * the shared otel-tui TraceStore (same parsing/grouping otel-tui's own binary uses). */
export function TraceBrowser(props: {
	spans: SpanData[];
	filter?: string;
	change?: string;
}) {
	const store = createMemo(() => {
		const traceStore = new TraceStore(props.spans);
		if (props.filter) traceStore.applyFilter(props.filter);
		return traceStore;
	});
	const rows = createMemo(() =>
		flatten(store().getSpanTree(props.change ?? "")),
	);
	return (
		<box flexDirection="column" width="100%" height="100%">
			<Show
				when={rows().length}
				fallback={<text fg={uiColors.textMuted}>No traces yet</text>}
			>
				<text fg={uiColors.textMuted}>{props.spans.length} spans</text>
				{rows().map((row) => (
					<box flexDirection="column">
						<text
							fg={
								row.span.status.code === 2
									? uiColors.error
									: uiColors.textSecondary
							}
						>
							{"  ".repeat(row.depth)}
							{row.span.name} · {duration(row.span)}
							{row.span.status.code === 2 ? " · ERROR" : ""}
						</text>
						<text fg={uiColors.textMuted}>
							{"  ".repeat(row.depth + 1)}
							{row.span.serviceName} ·{" "}
							{row.span.attributes
								.map((a) => `${a.key}=${a.value}`)
								.join(" · ")
								.slice(0, 240)}
						</text>
					</box>
				))}
			</Show>
		</box>
	);
}

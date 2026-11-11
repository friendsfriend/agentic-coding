/** @jsxImportSource @opentui/solid */

import { createMemo, For } from "solid-js";
import {
	HighlightedText,
	ScrollableContent,
	SearchHeader,
	uiColors,
} from "../../../ui/index.ts";
import type { TopologyStore } from "../model/topologyStore.ts";

export function ServiceDetailView(props: { store: TopologyStore; id: string }) {
	const service = createMemo(() =>
		props.store.getServices().find((s) => s.id === props.id),
	);
	// Summary fields are fixed structure; only their values are live data.
	const rows = [
		{ label: "Spans", value: () => String(service()?.spanCount ?? 0) },
		{ label: "Errors", value: () => String(service()?.errorCount ?? 0) },
		{
			label: "Avg duration",
			value: () => `${(service()?.avgDurationMs ?? 0).toFixed(1)}ms`,
		},
	];
	const dependencyRows = () => service()?.parentIds ?? [];
	const dependentRows = () => service()?.childIds ?? [];

	return (
		<box width="100%" height="100%" flexDirection="column">
			<SearchHeader>
				<HighlightedText text={props.id} highlight="highlight" />
			</SearchHeader>
			<ScrollableContent focusable={false}>
				<For each={rows}>
					{(row) => (
						<box
							height={1}
							flexDirection="row"
							paddingLeft={1}
							paddingRight={1}
						>
							<box style={{ width: 16, flexShrink: 0 }}>
								<HighlightedText text={row.label} highlight="secondary" />
							</box>
							<text
								fg={
									row.label === "Errors" && Number(row.value()) > 0
										? uiColors.error
										: uiColors.textPrimary
								}
							>
								{row.value()}
							</text>
						</box>
					)}
				</For>
				<SearchHeader>
					<HighlightedText text="Dependencies" highlight="secondary" />
				</SearchHeader>
				<For
					each={dependencyRows()}
					fallback={
						<box paddingLeft={1}>
							<text fg={uiColors.textMuted}>No upstream dependencies</text>
						</box>
					}
				>
					{(id) => (
						<box height={1} paddingLeft={1}>
							<text fg={uiColors.textSecondary}>{id}</text>
						</box>
					)}
				</For>
				<SearchHeader>
					<HighlightedText text="Dependents" highlight="secondary" />
				</SearchHeader>
				<For
					each={dependentRows()}
					fallback={
						<box paddingLeft={1}>
							<text fg={uiColors.textMuted}>No downstream dependents</text>
						</box>
					}
				>
					{(id) => (
						<box height={1} paddingLeft={1}>
							<text fg={uiColors.textSecondary}>{id}</text>
						</box>
					)}
				</For>
			</ScrollableContent>
		</box>
	);
}

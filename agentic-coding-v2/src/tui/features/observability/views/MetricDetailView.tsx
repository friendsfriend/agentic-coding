import { createMemo, For, Index, Show } from "solid-js";
import {
	createKeyedItems,
	HighlightedText,
	ScrollableContent,
	SearchHeader,
	uiColors,
} from "../../../ui/index.ts";
import { AutoscalingSparkline } from "../components/AutoscalingSparkline.tsx";
import type { MetricStore } from "../model/metricStore.ts";

const barChars = ["░", "▒", "▓", "█"];

export function MetricDetailView(props: {
	store: MetricStore;
	name: string;
	serviceName: string;
	streamId?: string;
}) {
	const stream = createMemo(() =>
		props.store.getStream(props.name, props.serviceName, props.streamId),
	);
	const agg = createMemo(() => {
		const current = stream();
		return current ? props.store.aggregate(current) : undefined;
	});
	const latest = () => stream()?.dataPoints.at(-1);
	const buckets = () => latest()?.bucketCounts ?? [];
	const maxCount = createMemo(() => Math.max(...buckets(), 0));
	// A sample's value is mutable payload. Timestamp/series coordinates own its
	// row; canonical attributes avoid resets when a snapshot changes their order.
	const points = createKeyedItems(
		() => stream()?.dataPoints ?? [],
		(point) =>
			JSON.stringify([
				props.serviceName,
				props.name,
				point.startTimeUnixNano,
				point.timeUnixNano,
				point.attributes
					.map(({ key, value }) => ({ key, value }))
					.sort(
						(a, b) =>
							a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
					),
			]),
	);

	return (
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box height={1} flexShrink={0} paddingLeft={1}>
				<text fg={uiColors.textMuted}>
					{props.serviceName} · {stream()?.type} · {stream()?.unit || "no unit"}
				</text>
			</box>
			<Show when={agg()}>
				{(current) => (
					<box height={3} flexDirection="row" paddingLeft={1} paddingRight={1}>
						<box style={{ width: "25%", flexDirection: "column" }}>
							<text fg={uiColors.textMuted}>Avg</text>
							<text fg={uiColors.textPrimary}>{current().avg.toFixed(2)}</text>
						</box>
						<box style={{ width: "25%", flexDirection: "column" }}>
							<text fg={uiColors.textMuted}>Min</text>
							<text fg={uiColors.success}>{current().min.toFixed(2)}</text>
						</box>
						<box style={{ width: "25%", flexDirection: "column" }}>
							<text fg={uiColors.textMuted}>Max</text>
							<text fg={uiColors.error}>{current().max.toFixed(2)}</text>
						</box>
						<box style={{ width: "25%", flexDirection: "column" }}>
							<text fg={uiColors.textMuted}>Data points</text>
							<text fg={uiColors.textPrimary}>{current().count}</text>
						</box>
					</box>
				)}
			</Show>
			<box height={3} paddingLeft={1} paddingRight={1}>
				<AutoscalingSparkline
					values={stream()?.dataPoints.map((dp) => dp.value) ?? []}
				/>
			</box>

			{/* Histogram bar chart (if histogram) */}
			<Show
				when={
					stream()?.type === "histogram" && latest()?.bucketCounts !== undefined
				}
			>
				<box height={4} flexDirection="column">
					<SearchHeader>
						<HighlightedText text="Bucket distribution" highlight="secondary" />
					</SearchHeader>
					<box
						height={3}
						flexDirection="row"
						alignItems="flex-end"
						paddingLeft={1}
						paddingRight={1}
					>
						<Index each={buckets()}>
							{(count, index) => {
								const barHeight = () =>
									maxCount() > 0
										? Math.max(1, Math.round((count() / maxCount()) * 3))
										: 1;
								const label = () => {
									const bound = latest()?.explicitBounds?.[index];
									return bound === undefined ? "+Inf" : String(bound);
								};
								return (
									<box
										style={{
											flexDirection: "column",
											alignItems: "center",
											width: Math.max(
												3,
												60 / (latest()?.bucketCounts?.length ?? 1),
											),
										}}
									>
										<text fg={uiColors.primary}>
											{barChars[barHeight() - 1] ?? "█".repeat(barHeight())}
										</text>
										<text fg={uiColors.textMuted}>{label()}</text>
									</box>
								);
							}}
						</Index>
					</box>
				</box>
			</Show>

			<ScrollableContent focusable={false}>
				<Show when={stream()?.description}>
					<SearchHeader>
						<HighlightedText text="Description" highlight="secondary" />
					</SearchHeader>
					<box flexShrink={0} paddingLeft={1} paddingRight={1}>
						<text fg={uiColors.textSecondary} wrapMode="word">
							{stream()?.description}
						</text>
					</box>
				</Show>
				<Show when={(stream()?.resource.attributes.length ?? 0) > 0}>
					<SearchHeader>
						<HighlightedText text="Resource" highlight="secondary" />
					</SearchHeader>
					<For each={stream()?.resource.attributes ?? []}>
						{(attribute) => (
							<box
								flexShrink={0}
								flexDirection="row"
								paddingLeft={1}
								paddingRight={1}
							>
								<box width={24} flexShrink={0}>
									<text fg={uiColors.primary} wrapMode="word">
										{attribute.key}
									</text>
								</box>
								<box flexGrow={1} minWidth={0}>
									<text fg={uiColors.textSecondary} wrapMode="word">
										{attribute.value}
									</text>
								</box>
							</box>
						)}
					</For>
				</Show>
				<Show when={stream()?.scope.name || stream()?.scope.version}>
					<SearchHeader>
						<HighlightedText
							text="Instrumentation scope"
							highlight="secondary"
						/>
					</SearchHeader>
					<box flexShrink={0} paddingLeft={1} paddingRight={1}>
						<text fg={uiColors.textSecondary} wrapMode="word">
							{stream()?.scope.name || "(unspecified)"}
							{stream()?.scope.version ? `@${stream()?.scope.version}` : ""}
						</text>
					</box>
				</Show>
				<SearchHeader>
					<HighlightedText text="Data points" highlight="secondary" />
				</SearchHeader>
				<For each={points()}>
					{(slot, index) => {
						const dp = slot.value;
						return (
							<box
								height={1}
								flexShrink={0}
								flexDirection="row"
								paddingLeft={1}
								paddingRight={1}
							>
								<box style={{ width: 4, flexShrink: 0 }}>
									<text fg={uiColors.textMuted}>
										{String(index() + 1).padEnd(3)}
									</text>
								</box>
								<box style={{ width: 25, flexShrink: 0 }} overflow="hidden">
									<text fg={uiColors.textSecondary}>
										{new Date(
											Number(BigInt(dp().timeUnixNano) / 1_000_000n),
										).toISOString()}
									</text>
								</box>
								<box
									style={{ width: 12, flexShrink: 0 }}
									justifyContent="flex-end"
								>
									<text fg={uiColors.textPrimary}>{dp().value.toFixed(2)}</text>
								</box>
								<box style={{ flexGrow: 1, minWidth: 0 }} overflow="hidden">
									<text fg={uiColors.textMuted}>
										{dp()
											.attributes.map((a) => `${a.key}=${a.value}`)
											.join(" ")}
									</text>
								</box>
							</box>
						);
					}}
				</For>
			</ScrollableContent>
		</box>
	);
}

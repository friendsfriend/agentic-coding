import { createMemo, For, Show } from "solid-js";
import {
	createKeyedItems,
	HighlightedText,
	type RowGestureState,
	ScrollableContent,
	SearchHeader,
	uiColors,
	useHover,
	useRowMouse,
} from "../../../ui/index.ts";
import { AutoscalingSparkline } from "../components/AutoscalingSparkline.tsx";
import type { MetricStore } from "../model/metricStore.ts";

const metricColor = (type: string) =>
	type === "histogram"
		? uiColors.accent
		: type === "sum"
			? uiColors.success
			: uiColors.primary;

export function MetricsView(props: {
	store: MetricStore;
	selectedIndex: () => number;
	onSelectIndex: (index: number) => void;
	onOpen: (name: string, serviceName: string) => void;
}) {
	/** One holder per list: a row the store replaced still completes its press. */
	const gesture: RowGestureState = {};
	const streams = createMemo(() => props.store.getStreams());
	const streamSlots = createKeyedItems(streams, (stream) =>
		JSON.stringify([stream.serviceName, stream.name]),
	);

	return (
		<box flexDirection="column" width="100%" height="100%">
			<SearchHeader>
				<text fg={uiColors.textMuted}>({props.store.filteredCount_})</text>
			</SearchHeader>
			<Show
				when={streams().length > 0}
				fallback={
					<box paddingLeft={1}>
						<text fg={uiColors.textMuted}>No metrics loaded</text>
					</box>
				}
			>
				<ScrollableContent focusable={false}>
					<For each={streamSlots()}>
						{(slot, index) => {
							const stream = slot.value;
							const selected = () => index() === props.selectedIndex();
							const agg = createMemo(() => props.store.aggregate(stream()));
							// Shared tap rule: a tap selects the stream, a tap on the selected
							// one opens its detail (a drag or another button does neither).
							const mouse = useRowMouse({
								gesture,
								// The stream list re-sorts under stable instances.
								index,
								selectedIndex: () => props.selectedIndex(),
								activatable: () => true,
								onSelect: (row: number) => props.onSelectIndex(row),
								onActivate: (row: number) => {
									props.onSelectIndex(row);
									props.onOpen(stream().name, stream().serviceName);
								},
							});
							const hover = useHover(mouse.onMouseOut);
							return (
								<box
									height={3}
									width="100%"
									flexShrink={0}
									flexDirection="row"
									backgroundColor={
										selected() ? uiColors.bgSurface1 : uiColors.bgMantle
									}
									{...mouse}
									{...hover}
								>
									<box
										width={1}
										height={3}
										flexShrink={0}
										backgroundColor={
											hover.hovered()
												? uiColors.borderFocus
												: selected()
													? uiColors.accent
													: uiColors.bgMantle
										}
									/>
									<box
										height={3}
										flexGrow={1}
										minWidth={0}
										flexDirection="column"
										paddingRight={1}
									>
										<box height={1} width="100%" flexDirection="row">
											<box width="60%" flexShrink={0} overflow="hidden">
												<HighlightedText
													text={stream().name}
													highlight={selected() ? "highlight" : "secondary"}
												/>
											</box>
											<box width="40%" flexShrink={0} overflow="hidden">
												<text fg={uiColors.textMuted}>
													{stream().serviceName} · {stream().type} ·{" "}
													{stream().unit || "—"} · {agg().avg.toFixed(2)}
												</text>
											</box>
										</box>
										<box height={2} width="100%">
											<AutoscalingSparkline
												values={stream().dataPoints.map((point) => point.value)}
												color={metricColor(stream().type)}
												backgroundColor={
													selected() ? uiColors.bgSurface1 : uiColors.bgMantle
												}
											/>
										</box>
									</box>
								</box>
							);
						}}
					</For>
				</ScrollableContent>
			</Show>
		</box>
	);
}

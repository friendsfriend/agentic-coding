/** @jsxImportSource @opentui/solid */
import type { ScrollBoxRenderable } from "@opentui/core";
import { createEffect, For, Show } from "solid-js";
import type { UiActionDescriptor } from "../../../src/ui/capability-api.ts";
import type { UiTraceSummary } from "../../../src/ui/controller.ts";
import { shortTraceId } from "../catalog.ts";
import type { Theme } from "../opencode-types.ts";

export function TraceView(props: {
	theme: Theme;
	action: UiActionDescriptor;
	summary: string;
	traces: readonly UiTraceSummary[];
	traceIndex: number;
	onSelect(index: number): void;
	onOpen(): void;
}) {
	let scroll: ScrollBoxRenderable | undefined;

	createEffect(() => {
		const trace = props.traces[props.traceIndex];
		if (!scroll || !trace) return;
		queueMicrotask(() => scroll?.scrollChildIntoView(`trace-${trace.traceId}`));
	});

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
			<box flexDirection="row" gap={1} alignItems="center" minWidth={0}>
				<text fg={props.theme.text.base} wrapMode="none" truncate flexGrow={1}>
					<b>{props.action.label}</b>
				</text>
				<text fg={props.theme.text.muted} wrapMode="none" flexShrink={0}>
					{props.traces.length} trace
					{props.traces.length === 1 ? "" : "s"}
				</text>
			</box>
			<scrollbox
				height={Math.min(12, Math.max(4, props.summary.split("\n").length))}
				flexShrink={0}
				verticalScrollbarOptions={{ visible: false }}
				horizontalScrollbarOptions={{ visible: false }}
			>
				<text fg={props.theme.text.muted} wrapMode="word" selectable>
					{props.summary}
				</text>
			</scrollbox>
			<box flexDirection="column" flexGrow={1} minHeight={0}>
				<text fg={props.theme.text.feedback.info.base} paddingBottom={1}>
					<b>Traces</b>
				</text>
				<scrollbox
					ref={(value: ScrollBoxRenderable) => {
						scroll = value;
					}}
					flexGrow={1}
					minHeight={0}
					verticalScrollbarOptions={{ visible: false }}
					horizontalScrollbarOptions={{ visible: false }}
				>
					<For each={props.traces}>
						{(trace, index) => {
							const selected = () => index() === props.traceIndex;
							return (
								<box
									id={`trace-${trace.traceId}`}
									flexDirection="column"
									paddingLeft={2}
									paddingRight={2}
									paddingTop={1}
									paddingBottom={1}
									backgroundColor={
										selected() ? props.theme.background.raised.high : undefined
									}
									onMouseUp={() => {
										props.onSelect(index());
										props.onOpen();
									}}
								>
									<box flexDirection="row" gap={1} minWidth={0}>
										<text
											fg={
												selected()
													? props.theme.text.action.primary.base
													: props.theme.text.muted
											}
											flexShrink={0}
										>
											{selected() ? "›" : " "}
										</text>
										<text
											fg={
												selected()
													? props.theme.text.base
													: props.theme.text.muted
											}
											wrapMode="none"
											truncate
											flexGrow={1}
											minWidth={0}
										>
											<b>{trace.root || "(unnamed)"}</b>
										</text>
										<Show when={trace.errors > 0}>
											<text
												fg={props.theme.text.feedback.error.base}
												wrapMode="none"
												flexShrink={0}
											>
												{trace.errors} error
												{trace.errors === 1 ? "" : "s"}
											</text>
										</Show>
									</box>
									<text
										fg={props.theme.text.muted}
										wrapMode="none"
										truncate
										paddingLeft={2}
									>
										{shortTraceId(trace.traceId)} · {trace.spanCount} span
										{trace.spanCount === 1 ? "" : "s"}
									</text>
								</box>
							);
						}}
					</For>
				</scrollbox>
			</box>
		</box>
	);
}

/** @jsxImportSource @opentui/solid */
import { MarkdownViewer, uiColors } from "@agentic-coding/ui";
import { TextAttributes } from "@opentui/core";
import { createMemo, For, Show } from "solid-js";
import { ToolTable } from "../dash/ui/ToolTable.tsx";
import {
	parseToolJson,
	record,
	safeToolValue,
	scalar,
	statusRow,
	title,
	valueRows,
} from "../dash/ui/tool-content.ts";

function tone(value: unknown): string {
	const status = statusRow("", value).tone;
	return status === "error"
		? uiColors.error
		: status === "warning"
			? uiColors.warning
			: status === "success"
				? uiColors.success
				: uiColors.textPrimary;
}

/** Use the transcript's loss-preserving projection and responsive tables.
 * Sections share their parent's viewport: no clipped values or nested scrolls. */
function DetailValue(props: { value: unknown; label?: string; width: number }) {
	const object = () => record(props.value);
	const table = createMemo(() =>
		Array.isArray(props.value) ? valueRows(props.value)[0]?.table : undefined,
	);
	return (
		<Show
			when={object()}
			fallback={
				<Show
					when={table()}
					fallback={
						<Show
							when={Array.isArray(props.value)}
							fallback={
								<Show
									when={
										typeof props.value === "string" &&
										/^(prompt|description|context|result|output)$/i.test(
											props.label ?? "",
										)
									}
									fallback={
										<text
											fg={
												/state|status|outcome/i.test(props.label ?? "")
													? tone(props.value)
													: uiColors.textPrimary
											}
											wrapMode="word"
										>
											{scalar(props.value)}
										</text>
									}
								>
									<MarkdownViewer
										content={String(props.value)}
										width={props.width}
									/>
								</Show>
							}
						>
							<For each={Array.isArray(props.value) ? props.value : []}>
								{(value) => <DetailValue value={value} width={props.width} />}
							</For>
							<Show
								when={Array.isArray(props.value) && props.value.length === 0}
							>
								<text fg={uiColors.textMuted}>None</text>
							</Show>
						</Show>
					}
				>
					{(value) => <ToolTable table={value()} />}
				</Show>
			}
		>
			{(value) => (
				<For each={Object.entries(value())}>
					{([key, item]) => (
						<Show
							when={
								(item !== null && typeof item === "object") ||
								(typeof item === "string" &&
									/^(prompt|description|context|result|output)$/i.test(key))
							}
							fallback={
								<text fg={uiColors.textMuted} wrapMode="word">
									{title(key)}:{" "}
									<span
										style={{
											fg: /state|status|outcome/i.test(key)
												? tone(item)
												: uiColors.textPrimary,
										}}
									>
										{scalar(item)}
									</span>
								</text>
							}
						>
							<box
								flexDirection="column"
								flexShrink={0}
								marginTop={1}
								marginBottom={1}
								border={["left"]}
								borderColor={uiColors.bgMantle}
								paddingLeft={1}
							>
								<text fg={uiColors.textMuted} attributes={TextAttributes.BOLD}>
									{title(key)}
								</text>
								<DetailValue
									value={item}
									label={key}
									width={Math.max(1, props.width - 2)}
								/>
							</box>
						</Show>
					)}
				</For>
			)}
		</Show>
	);
}

export function ScheduleDetails(props: { content: string; width: number }) {
	const parsed = createMemo(() => parseToolJson(props.content));
	const value = createMemo(() => safeToolValue(parsed()));
	return (
		<box
			width="100%"
			flexDirection="column"
			flexShrink={0}
			paddingLeft={1}
			paddingRight={1}
		>
			<Show
				when={parsed() !== undefined}
				fallback={
					<text fg={uiColors.textPrimary} wrapMode="word">
						{props.content}
					</text>
				}
			>
				<DetailValue value={value()} width={Math.max(1, props.width - 2)} />
			</Show>
		</box>
	);
}

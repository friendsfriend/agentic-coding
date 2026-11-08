/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { StructuredData } from "../../ui/StructuredData.tsx";
import { color } from "../../ui/theme/index.ts";

const record = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const clip = (value: unknown, max = 2000) => {
	const text =
		typeof value === "string" ? value : JSON.stringify(value ?? null);
	return text.length > max ? `${text.slice(0, max)} … [display clipped]` : text;
};
const stamp = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value)
		? new Date(value).toISOString()
		: "not recorded";
/** Observation-only presentation of one explicit native telemetry read.
 * Absence, retention loss and clipping are stated; nothing is fetched or replayed. */
export function TelemetryView(props: { value: unknown }) {
	const [raw, setRaw] = createSignal(false);
	const data = createMemo(() => record(props.value));
	const records = createMemo(() => dataList(data().records));
	const mode = () => String(data().mode ?? "unrecorded");
	const tree = createMemo(() => dataList(data().tree));
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Native telemetry observation · {mode()} · {records().length} retained
				record(s)
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Source {String(data().source ?? "not recorded")} ·{" "}
				{String(data().completeness ?? "completeness not recorded")} · time
				basis {String(data().timeBasis ?? "not recorded")} · scope{" "}
				{clip(data().scope, 240)}
			</text>
			<text wrapMode="word" fg={color("warning")}>
				Retained observations only, not a complete capture, frozen snapshot or
				execution authority. Loss: {clip(data().loss, 400)} · paging{" "}
				{clip(data().paging, 400)} · selection {clip(data().selection, 400)}
			</text>
			<Show when={data().availability !== undefined}>
				<text wrapMode="word">
					Lookup {clip(data().availability, 240)} ·{" "}
					{clip(data().unknownMeaning, 400)}
				</text>
			</Show>
			<Show when={tree().length}>
				<text fg={color("primary")}>Reported trace tree (preorder nodes)</text>
				<For each={tree()}>
					{(node) => (
						<text wrapMode="word">
							{"  ".repeat(Math.min(12, Number(node.depth ?? 0)))}
							{Number(node.depth ?? 0) > 12 ? "… " : ""}
							{String(node.name ?? node.spanId ?? "unidentified")} ·{" "}
							{String(node.status ?? "status not recorded")} ·{" "}
							{String(node.durationMs ?? "duration not recorded")} ms
							{node.missingParent === true ? " · missing reported parent" : ""}
						</text>
					)}
				</For>
			</Show>
			<Show when={!tree().length && mode() === "traces" && data().traceId}>
				<text fg={color("textMuted")}>
					This single-trace read returned no tree; see the flat records below.
				</text>
			</Show>
			<For each={records()}>
				{(item, index) => (
					<box
						flexDirection="column"
						border={true}
						borderColor={color("border")}
						padding={1}
						gap={1}
					>
						<text fg={color("primary")} wrapMode="word">
							{index() + 1}. {String(item.name ?? item.body ?? "unidentified")}
						</text>
						<text wrapMode="word">
							trace {String(item.traceId ?? "not recorded")} · span{" "}
							{String(item.spanId ?? "not recorded")} · parent{" "}
							{String(item.parentSpanId ?? "not reported")}
						</text>
						<text wrapMode="word">
							status {String(item.status ?? "not recorded")} · duration{" "}
							{String(item.durationMs ?? "not recorded")} ms · spans{" "}
							{String(item.spanCount ?? "not recorded")} · errors{" "}
							{String(item.errorCount ?? "not recorded")}
						</text>
						<text wrapMode="word">
							started {stamp(item.startedAt)} · service{" "}
							{String(item.service ?? "not recorded")} · severity{" "}
							{String(item.severity ?? "not recorded")}
						</text>
						<Show when={item.body !== undefined}>
							<text wrapMode="word">{clip(item.body)}</text>
						</Show>
						<Show when={item.rootKind !== undefined || item.http !== undefined}>
							<text wrapMode="word">
								kind {String(item.rootKind ?? "not recorded")} · http{" "}
								{clip(item.http, 240)}
							</text>
						</Show>
					</box>
				)}
			</For>
			<Show when={!records().length}>
				<text fg={color("textMuted")} wrapMode="word">
					No retained matching observations in this window. That is not proof of
					no activity and not a successful-cleanup claim.
				</text>
			</Show>
			<Show when={data().nextCursor}>
				<text wrapMode="word" fg={color("accent")}>
					Older page available: place nextCursor {clip(data().nextCursor, 128)}{" "}
					in the selection cursor field. The cursor expires and refuses on an
					evicted boundary; it is never kept in history or a viewpoint.
				</text>
			</Show>
			<ActionHeader onActivate={() => setRaw(!raw())}>
				<text fg={color("accent")}>
					{raw() ? "▾" : "▸"} Complete observed native response
				</text>
			</ActionHeader>
			<Show when={raw()}>
				<StructuredData value={props.value} label="Native telemetry response" />
			</Show>
		</box>
	);
}

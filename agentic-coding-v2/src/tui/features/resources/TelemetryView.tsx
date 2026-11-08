/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import type { Data } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import { ActionHeader } from "../../ui/ActionHeader.tsx";
import { SuppliedObservation } from "../../ui/SuppliedObservation.tsx";
import { SuppliedRecordWindow } from "../../ui/SuppliedRecordWindow.tsx";
import { color } from "../../ui/theme/index.ts";

const record = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const clip = (value: unknown, max = 200) => {
	const text =
		typeof value === "string"
			? value
			: (JSON.stringify(value) ?? "not supplied");
	const points = Array.from(text);
	return points.length > max
		? `${points.slice(0, max).join("")} … [summary clipped; full supplied record below]`
		: text;
};
const stamp = (value: unknown) => {
	if (value === undefined) return "not supplied";
	if (typeof value !== "number" || !Number.isFinite(value))
		return "unrecognized supplied epoch; see raw record";
	const date = new Date(value);
	return Number.isFinite(date.getTime())
		? date.toISOString()
		: "invalid supplied epoch; see raw record";
};
/** One explicit observation. All paging/disclosures below are local; even a
 * supplied cursor/trace/owner never starts a new read or confers authority. */
export function TelemetryView(props: { value: unknown }) {
	const [raw, setRaw] = createSignal(false);
	const [expanded, setExpanded] = createSignal<string[]>([]);
	const source = createMemo(() => ({ value: props.value }));
	const data = createMemo(() => record(source().value));
	const records = createMemo(() => dataList(data().records));
	const tree = createMemo(() => dataList(data().tree));
	const mode = () => String(data().mode ?? "unrecorded");
	createEffect(() => {
		source();
		setRaw(false);
		setExpanded([]);
	});
	const details = (kind: string, item: Data, ordinal: () => number) => {
		const key = () => `${kind}:${ordinal()}`;
		return (
			<box flexDirection="column" gap={1}>
				<ActionHeader
					scope={source()}
					onActivate={() =>
						setExpanded((keys) =>
							keys.includes(key())
								? keys.filter((value) => value !== key())
								: [...keys, key()],
						)
					}
				>
					<text fg={color("accent")}>
						{expanded().includes(key()) ? "▾" : "▸"} Supplied {kind} record (
						{ordinal() + 1}; display ordinal only)
					</text>
				</ActionHeader>
				<Show when={expanded().includes(key())}>
					<SuppliedObservation
						value={item}
						label={`Supplied ${kind} record`}
						scope={source()}
					/>
				</Show>
			</box>
		);
	};
	return (
		<box flexDirection="column" gap={1}>
			<text fg={color("primary")}>
				Native telemetry observation · {mode()} · {records().length} retained
				record(s)
			</text>
			<text wrapMode="word" fg={color("textMuted")}>
				Source {clip(data().source)} · {clip(data().completeness)} · time basis{" "}
				{clip(data().timeBasis)} · scope {clip(data().scope)}
			</text>
			<text wrapMode="word" fg={color("warning")}>
				Retained observations only, not complete capture, frozen snapshot or
				execution authority. Loss: {clip(data().loss)} · paging{" "}
				{clip(data().paging)} · selection {clip(data().selection)}
			</text>
			<Show when={data().availability !== undefined}>
				<text wrapMode="word">
					Lookup {clip(data().availability)} · {clip(data().unknownMeaning)}
				</text>
			</Show>
			<Show when={tree().length}>
				<text fg={color("primary")}>
					Reported trace tree (supplied preorder; each local window may start
					mid-tree)
				</text>
				<SuppliedRecordWindow
					rows={tree()}
					scope={source()}
					label="reported tree nodes"
					title={(node) => clip(node.name ?? node.spanId ?? "unidentified")}
					search={(node) => JSON.stringify(node)}
				>
					{(node, index) => (
						<box flexDirection="column" gap={1}>
							<text wrapMode="word">
								{Number.isSafeInteger(node.depth) && Number(node.depth) >= 0
									? "  ".repeat(Math.min(12, Number(node.depth)))
									: ""}
								{Number(node.depth) > 12 ? "… [indent bounded] " : ""}
								{clip(node.name ?? node.spanId ?? "unidentified")} ·{" "}
								{clip(node.status)} · {clip(node.durationMs)} ms
								{node.missingParent === true
									? " · missing reported parent"
									: ""}
								{!Number.isSafeInteger(node.depth) || Number(node.depth) < 0
									? " · depth not usable; no inferred parentage"
									: ""}
							</text>
							{details("tree", node, index)}
						</box>
					)}
				</SuppliedRecordWindow>
			</Show>
			<Show when={!tree().length && mode() === "traces" && data().traceId}>
				<text fg={color("textMuted")}>
					This supplied single-trace response has no tree; see retained flat
					records below. No tree is synthesized.
				</text>
			</Show>
			<SuppliedRecordWindow
				rows={records()}
				scope={source()}
				label="telemetry records"
				title={(item) => clip(item.name ?? item.body ?? "unidentified")}
				search={(item) => JSON.stringify(item)}
			>
				{(item, index) => (
					<box
						flexDirection="column"
						border={true}
						borderColor={color("border")}
						padding={1}
						gap={1}
					>
						<text fg={color("primary")} wrapMode="word">
							{index() + 1}. {clip(item.name ?? item.body ?? "unidentified")}
						</text>
						<text wrapMode="word">
							Trace {clip(item.traceId)} · span {clip(item.spanId)} · reported
							parent {clip(item.parentSpanId)}
						</text>
						<text wrapMode="word">
							Status {clip(item.status)} · duration {clip(item.durationMs)} ms ·
							spans {clip(item.spanCount)} · errors {clip(item.errorCount)}
						</text>
						<text wrapMode="word">
							Started {stamp(item.startedAt)} · service {clip(item.service)} ·
							severity {clip(item.severity)}
						</text>
						<Show when={item.body !== undefined}>
							<text wrapMode="word">{clip(item.body)}</text>
						</Show>
						<Show when={item.rootKind !== undefined || item.http !== undefined}>
							<text wrapMode="word">
								Kind {clip(item.rootKind)} · HTTP {clip(item.http)}
							</text>
						</Show>
						{details("telemetry", item, index)}
					</box>
				)}
			</SuppliedRecordWindow>
			<Show when={!records().length}>
				<text fg={color("textMuted")} wrapMode="word">
					No retained matching observations in this supplied window. Not proof
					of no activity or successful cleanup.
				</text>
			</Show>
			<Show
				when={data().nextCursor !== undefined && data().nextCursor !== null}
			>
				<text wrapMode="word" fg={color("accent")}>
					Supplied older-page cursor: copy into a separately prepared explicit
					read. Never saved in history/viewpoints, automatically followed or
					treated as a current run identity; an expired/evicted boundary
					refuses.
				</text>
				<SuppliedObservation
					value={data().nextCursor}
					label="Supplied nextCursor"
					scope={source()}
				/>
			</Show>
			<ActionHeader scope={source()} onActivate={() => setRaw(!raw())}>
				<text fg={color("accent")}>
					{raw() ? "▾" : "▸"} Retained native response in bounded local source
					windows
				</text>
			</ActionHeader>
			<Show when={raw()}>
				<SuppliedObservation
					value={source().value}
					label="Supplied native telemetry response"
					scope={source()}
				/>
			</Show>
		</box>
	);
}

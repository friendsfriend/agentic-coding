/** @jsxImportSource @opentui/solid */
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Data, Transcript } from "../../../protocol/index.ts";
import { dataList } from "../../client/connection.ts";
import {
	HelpText,
	wrapHelpEntries,
} from "../../presentation/components/HelpText.tsx";
import type { RowGestureState } from "../../presentation/components/mouse/useRowMouse.ts";
import { ReadOnlyModalFrame } from "../../presentation/components/ReadOnlyModalFrame.tsx";
import { ReadOnlyScrollableList } from "../../presentation/components/ReadOnlyScrollableList.tsx";
import { SearchHeader } from "../../presentation/components/SearchHeader.tsx";
import { SelectionMarker } from "../../presentation/components/SelectionMarker.tsx";
import {
	formatCost,
	formatTokenCount,
} from "../../presentation/components/transcriptFormat.ts";
import { useTerminalDimensions } from "../../presentation/hooks/useTerminalDimensions.ts";
import { uiColors } from "../../presentation/theme/colors.ts";

const record = (value: unknown): Data =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Data)
		: {};
const number = (value: unknown, cost = false) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? cost
			? formatCost(value)
			: formatTokenCount(value)
		: "—";

/** Original CostModal overview/detail geometry over ONE supplied native window.
 * No grouping into invented agents, billing totals, context occupancy or reads. */
export function ReportedUsageModal(props: {
	snapshot: Transcript;
	active: boolean;
	close: () => void;
}) {
	const snapshot = props.snapshot;
	const dimensions = useTerminalDimensions();
	const width = () => Math.max(1, Math.floor(dimensions().width * 0.72));
	const height = () => Math.max(1, Math.floor(dimensions().height * 0.78));
	const rows = snapshot.entries.flatMap((entry) =>
		dataList(entry.model).flatMap((message, index) =>
			message.role === "assistant"
				? [
						{
							key: JSON.stringify([entry.id, index]),
							label: `Entry #${String(entry.id)} · response ${index + 1}`,
							message,
						},
					]
				: [],
		),
	);
	const [selected, setSelected] = createSignal(0);
	const [detail, setDetail] = createSignal(false);
	let disposed = false;
	let scroll: ScrollBoxRenderable | undefined;
	const enabled = () =>
		!disposed && props.active && props.snapshot === snapshot;
	const gesture: RowGestureState = {};
	const footer = createMemo(() =>
		wrapHelpEntries(
			detail()
				? [
						{ key: "j/k", action: "Scroll" },
						{ key: "PgUp/PgDn", action: "Page" },
						{ key: "Home/End", action: "First/last" },
						{ key: "Esc", action: "Back" },
					]
				: [
						{ key: "j/k", action: "Navigate" },
						{ key: "PgUp/PgDn", action: "Page" },
						{ key: "Enter", action: "Response detail" },
						{ key: "Esc", action: "Close" },
					],
			Math.max(1, width() - 4),
		),
	);
	const lines = () => Math.max(1, height() - 7 - footer().length);
	const start = () =>
		Math.max(0, Math.min(rows.length - lines(), selected() - lines() + 1));
	const pick = (index: number) => {
		if (enabled() && rows[index]) setSelected(index);
	};
	const close = () => {
		if (enabled()) props.close();
	};
	const control = (key: string) => {
		if (!enabled()) return;
		if (key === "escape") {
			if (detail()) setDetail(false);
			else close();
			return;
		}
		if (detail()) {
			const page = Math.max(1, scroll?.viewport.height ?? lines());
			if (key === "home" || key === "end")
				scroll?.scrollTo(
					key === "home"
						? 0
						: Math.max(0, scroll.scrollHeight - scroll.viewport.height),
				);
			else
				scroll?.scrollBy(
					key === "pageup"
						? -page
						: key === "pagedown"
							? page
							: key === "up" || key === "k"
								? -1
								: key === "down" || key === "j"
									? 1
									: 0,
				);
			return;
		}
		if (key === "enter" || key === "return") {
			if (rows[selected()]) setDetail(true);
			return;
		}
		pick(
			key === "home"
				? 0
				: key === "end"
					? rows.length - 1
					: Math.max(
							0,
							Math.min(
								rows.length - 1,
								selected() +
									(key === "pageup"
										? -lines()
										: key === "pagedown"
											? lines()
											: key === "up" || key === "k"
												? -1
												: 1),
							),
						),
		);
	};
	const unregister = useKeymap().registerLayer({
		id: "v2.reported-usage",
		priority: 190,
		enabled,
		bindings: [
			"j",
			"k",
			"up",
			"down",
			"pageup",
			"pagedown",
			"home",
			"end",
			"enter",
			"return",
			"escape",
		].map((key) => ({ key, cmd: () => control(key) })),
	});
	onCleanup(() => {
		disposed = true;
		unregister();
		scroll = undefined;
	});
	const current = () => rows[selected()];
	const usage = (message: Data) => record(message.usage);
	const cost = (message: Data) =>
		number(record(usage(message).cost).total, true);
	const tokens = (message: Data) =>
		`${number(usage(message).input)}/${number(usage(message).output)}`;
	const metadata = () =>
		Object.fromEntries(
			[
				"provider",
				"model",
				"responseModel",
				"timestamp",
				"durationMs",
				"stopReason",
				"usage",
			]
				.filter((key) => Object.hasOwn(current()?.message ?? {}, key))
				.map((key) => [key, current()?.message[key]]),
		);
	return (
		<ReadOnlyModalFrame
			width={width()}
			height={height()}
			active={enabled()}
			close={() => control("escape")}
			footerHeight={footer().length + 2}
			header={
				<SearchHeader>
					<text fg={uiColors.primary} attributes={TextAttributes.BOLD}>
						{detail()
							? `Reported usage · ${current()?.label ?? "unavailable"}`
							: `Reported usage · conversation #${snapshot.id}`}
					</text>
				</SearchHeader>
			}
			footer={
				<>
					<For each={footer()}>
						{(entries) => (
							<HelpText
								entries={entries}
								activatable={(entry) =>
									enabled() && (entry.key === "Esc" || entry.key === "Enter")
								}
								onActivate={(entry) =>
									control(entry.key === "Esc" ? "escape" : "enter")
								}
							/>
						)}
					</For>
					<text fg={uiColors.textMuted} truncate>
						Window only · {rows.length} supplied responses ·{" "}
						{snapshot.truncated
							? "native history clipped"
							: "supplied retained window"}
					</text>
					<text fg={uiColors.textMuted} truncate>
						Read-only cached observation; not billing, context capacity,
						completion or a lifetime total.
					</text>
				</>
			}
		>
			<Show
				when={!detail()}
				fallback={
					<scrollbox
						ref={(node) => {
							scroll = node;
						}}
						flexGrow={1}
						minHeight={0}
						width="100%"
					>
						<text fg={uiColors.textMuted} wrapMode="word">
							Exact supplied response fields. Missing fields stay absent; zero
							is reported, not proof of free billing. Reasoning and 1h
							cache-write counts are subsets, not added totals. Recorded
							duration is not a running clock.
						</text>
						<text fg={uiColors.textPrimary} wrapMode="word">
							{JSON.stringify(metadata(), null, 2)}
						</text>
					</scrollbox>
				}
			>
				<box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
					<box flexDirection="row" height={1} paddingLeft={2}>
						<text fg={uiColors.textMuted} flexGrow={1}>
							Response
						</text>
						<text
							fg={uiColors.textMuted}
							width={Math.min(24, Math.max(8, Math.floor(width() * 0.3)))}
						>
							Tokens (in/out)
						</text>
						<text fg={uiColors.textMuted} width={10}>
							Cost
						</text>
					</box>
					<ReadOnlyScrollableList
						items={rows}
						start={start()}
						availableLines={lines()}
						selectedIndex={selected()}
						active={enabled()}
						gesture={gesture}
						selectedBackground={uiColors.bgSurface0}
						onSelect={pick}
						onActivate={(index) => {
							pick(index);
							if (enabled() && rows[index]) setDetail(true);
						}}
						emptyContent={
							<text fg={uiColors.textMuted}>
								No supplied assistant responses in this window; no history is
								fetched.
							</text>
						}
						renderItem={(row, selected) => (
							<>
								<SelectionMarker selected={selected()} />
								<text
									fg={selected() ? uiColors.primary : uiColors.textSecondary}
									flexGrow={1}
									minWidth={0}
									truncate
									wrapMode="none"
								>
									{row.label}
								</text>
								<text
									fg={uiColors.textSecondary}
									width={Math.min(24, Math.max(8, Math.floor(width() * 0.3)))}
									truncate
									wrapMode="none"
								>
									{tokens(row.message)}
								</text>
								<text
									fg={selected() ? uiColors.primary : uiColors.textSecondary}
									width={10}
								>
									{cost(row.message)}
								</text>
							</>
						)}
					/>
					<text fg={uiColors.textMuted} truncate>
						Supplied window total {number(snapshot.usage.cost, true)} ·{" "}
						{number(snapshot.usage.input)} → {number(snapshot.usage.output)}
					</text>
				</box>
			</Show>
		</ReadOnlyModalFrame>
	);
}

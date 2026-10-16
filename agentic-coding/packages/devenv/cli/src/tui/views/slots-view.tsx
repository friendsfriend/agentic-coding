/** @jsxImportSource @opentui/solid */
// The Slots section of the Environments feature (show-environment-instances).
//
// One row per app that is agent-held or has waiters: the holder, its status,
// the declared endpoints, how long it has been idle (with the agent TTL
// remaining) and the waiting workflows in queue order with their wait time.
// Idle or human-held apps with nobody waiting stay in the normal app list, so
// this section stays small.
import {
	type RowGestureState,
	uiColors,
	useKeyDispatch,
	useRowMouse,
} from "@ui";
import { For, Show } from "solid-js";
import { type SlotRow, slotRowFields } from "../stores/slot-store.ts";

export interface SlotsViewProps {
	rows: SlotRow[];
	selectedIndex: number;
	/** Wall clock for wait/idle arithmetic, read reactively. */
	nowMs: number;
	height: number;
	loading: boolean;
	error: string | null;
	/** Pointer: a tap selects a slot row. */
	onSelectIndex?: (index: number) => void;
}

/**
 * One slot row. It carries the shared tap rule rather than a bare handler: a
 * tap selects the row, a tap on the already-selected row opens the owning
 * workflow by dispatching the table's own `Enter`, and a drag or a non-primary
 * button does nothing.
 */
function SlotRowView(props: {
	row: SlotRow;
	index: number;
	selectedIndex: number;
	nowMs: number;
	onSelectIndex?: (index: number) => void;
	/** One holder per list: a row the store replaced still completes its tap. */
	gesture: RowGestureState;
}) {
	const dispatch = useKeyDispatch();
	const mouse = useRowMouse({
		gesture: props.gesture,
		// The row's position can move when the list re-syncs.
		index: () => props.index,
		selectedIndex: () => props.selectedIndex,
		activatable: () => props.onSelectIndex !== undefined,
		onSelect: (index) => props.onSelectIndex?.(index),
		onActivate: (index) => {
			props.onSelectIndex?.(index);
			dispatch("Enter");
		},
	});
	const fields = () => slotRowFields(props.row, props.nowMs);
	return (
		<box {...mouse} style={{ width: "100%", height: 1, overflow: "hidden" }}>
			<text
				style={{
					fg:
						props.index === props.selectedIndex ? uiColors.primary : undefined,
				}}
			>
				{`${props.row.app.padEnd(19)} ${fields().holder.padEnd(13)} ${fields().status.padEnd(9)} ${fields().endpoints.padEnd(23)} ${fields().idle.padEnd(15)} ${fields().waiting}`}
			</text>
		</box>
	);
}

export function SlotsView(props: SlotsViewProps) {
	const rows = () => props.rows.slice(0, Math.max(0, props.height - 2));
	/** The slot store replaces row objects, so the press belongs to the list. */
	const gesture: RowGestureState = {};

	return (
		<box
			style={{
				width: "100%",
				flexGrow: 1,
				minHeight: 0,
				flexDirection: "column",
				overflow: "hidden",
			}}
		>
			<text style={{ fg: uiColors.textSecondary }}>
				{
					"APP                 HOLDER        STATUS    ENDPOINTS               IDLE / TTL      WAITING"
				}
			</text>
			<Show when={props.error}>
				{(message) => (
					<text style={{ fg: uiColors.error }}>
						{`Slots unavailable: ${message()}`}
					</text>
				)}
			</Show>
			<Show when={!props.error && props.loading && props.rows.length === 0}>
				<text style={{ fg: uiColors.textSecondary }}>Loading slots…</text>
			</Show>
			<Show when={!props.error && !props.loading && props.rows.length === 0}>
				<text style={{ fg: uiColors.textSecondary }}>
					No app is agent-held and no workflow is waiting.
				</text>
			</Show>
			<For each={rows()}>
				{(row, index) => (
					<SlotRowView
						row={row}
						index={index()}
						selectedIndex={props.selectedIndex}
						nowMs={props.nowMs}
						gesture={gesture}
						{...(props.onSelectIndex
							? { onSelectIndex: props.onSelectIndex }
							: {})}
					/>
				)}
			</For>
		</box>
	);
}

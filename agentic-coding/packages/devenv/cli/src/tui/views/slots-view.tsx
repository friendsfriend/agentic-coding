/** @jsxImportSource @opentui/solid */
// The Slots section of the Environments feature (show-environment-instances).
//
// One row per app that is agent-held or has waiters: the holder, its status,
// the declared endpoints, how long it has been idle (with the agent TTL
// remaining) and the waiting workflows in queue order with their wait time.
// Idle or human-held apps with nobody waiting stay in the normal app list, so
// this section stays small.
import { uiColors } from "@ui";
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
}

export function SlotsView(props: SlotsViewProps) {
	const rows = () => props.rows.slice(0, Math.max(0, props.height - 2));

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
				{(row, index) => {
					const fields = () => slotRowFields(row, props.nowMs);
					const selected = () => index() === props.selectedIndex;
					return (
						<text style={{ fg: selected() ? uiColors.primary : undefined }}>
							{`${row.app.padEnd(19)} ${fields().holder.padEnd(13)} ${fields().status.padEnd(9)} ${fields().endpoints.padEnd(23)} ${fields().idle.padEnd(15)} ${fields().waiting}`}
						</text>
					);
				}}
			</For>
		</box>
	);
}

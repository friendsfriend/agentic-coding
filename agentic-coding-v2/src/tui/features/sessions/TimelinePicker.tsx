/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { ReadOnlyChoicePicker } from "../../presentation/components/ReadOnlyChoicePicker.tsx";
import { formatClock } from "../../presentation/components/transcriptFormat.ts";

export type PromptTimelineRow = {
	key: string;
	label: string;
	timestamp?: number;
};
/** Timeline projection only. Exact mounted target/registry fences stay in App. */
export function TimelinePicker(props: {
	rows: readonly PromptTimelineRow[];
	active: boolean;
	choose: (key: string) => boolean;
	close: () => void;
}) {
	const rows = createMemo(() =>
		props.rows
			.slice()
			.reverse()
			.map((row) => {
				const label = Array.from(row.label);
				const timestamp = row.timestamp;
				const detail =
					typeof timestamp === "number" &&
					Number.isFinite(timestamp) &&
					timestamp >= 0 &&
					Number.isFinite(new Date(timestamp).getTime())
						? formatClock(timestamp)
						: "";
				return {
					key: row.key,
					detail,
					label:
						label.length > 160 ? `${label.slice(0, 159).join("")}…` : row.label,
				};
			}),
	);
	return (
		<ReadOnlyChoicePicker
			rows={rows()}
			title="Jump to message"
			empty="No user messages to show."
			refusal="Selected prompt unavailable in this view; choose a visible prompt explicitly."
			layerId="v2.timeline-picker"
			initialKey={props.rows.at(-1)?.key}
			active={props.active}
			choose={props.choose}
			close={props.close}
		/>
	);
}

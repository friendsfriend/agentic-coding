/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";
import { uiColors } from "../theme/colors.ts";
import {
	formatCallDuration,
	formatClock,
	SLOW_CALL_MS,
} from "./transcriptFormat.ts";

/** Original right-edge timing composition. Callers supply recorded fields only;
 * no timer, elapsed-time inference, seconds conversion or timestamp fallback. */
export function Stamp(props: {
	timestamp?: unknown;
	durationMs?: unknown;
	/** Native result timestamps are completion records, not call start times. */
	clockLabel?: string;
}) {
	const duration = createMemo(() => {
		const value = props.durationMs;
		return typeof value === "number" && Number.isFinite(value) && value >= 0
			? { value, label: formatCallDuration(value) }
			: null;
	});
	const clock = createMemo(() => {
		const value = props.timestamp;
		return typeof value === "number" &&
			Number.isFinite(value) &&
			value >= 0 &&
			Number.isFinite(new Date(value).getTime())
			? formatClock(value)
			: "";
	});
	return (
		<>
			<Show when={duration()}>
				{(reported) => (
					<text
						fg={
							reported().value >= SLOW_CALL_MS
								? uiColors.warning
								: uiColors.textMuted
						}
						flexShrink={0}
					>
						{` ${reported().label}`}
					</text>
				)}
			</Show>
			<Show when={clock()}>
				{(label) => (
					<text fg={uiColors.textMuted} flexShrink={0}>
						{` ${props.clockLabel ? `${props.clockLabel} ` : ""}${label()}`}
					</text>
				)}
			</Show>
		</>
	);
}

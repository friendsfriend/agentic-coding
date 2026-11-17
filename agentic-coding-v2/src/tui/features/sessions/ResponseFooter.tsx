/** @jsxImportSource @opentui/solid */
import { createMemo } from "solid-js";
import { Stamp } from "../../presentation/components/Stamp.tsx";
import {
	formatCost,
	formatTokenCount,
} from "../../presentation/components/transcriptFormat.ts";
import { color } from "../../ui/theme/index.ts";
import { modelLabel, type TurnStats, usable } from "./turn-stats.ts";

/** Original right-edge recorded stamp/footer composition. Request start and
 * monotonic recorded duration only; no ticking, inferred finish or speed. */
export function ResponseFooter(props: { stats: TurnStats }) {
	// The one-line summary the developer reads: the model(s), the summed recorded
	// cost and the summed recorded input→output tokens of this input's exchange.
	// Reasoning is a subset of output and cacheWrite1h a subset of cacheWrite, so
	// neither is added again; a partial group reports only what it already holds.
	const summary = createMemo(() => {
		const { cost, input, output } = props.stats,
			segments: string[] = [];
		if (usable(cost)) segments.push(formatCost(cost));
		if (usable(input) || usable(output))
			segments.push(
				`${usable(input) ? formatTokenCount(input) : "—"}→${
					usable(output) ? formatTokenCount(output) : "—"
				} tok`,
			);
		return segments;
	});
	return (
		<box flexDirection="column" paddingLeft={3} paddingRight={1} flexShrink={0}>
			<box flexDirection="row">
				<text fg={color("textMuted")} flexGrow={1} wrapMode="word">
					{`${modelLabel(props.stats.models)}${summary()
						.map((segment) => ` · ${segment}`)
						.join("")}`}
				</text>
				<Stamp
					timestamp={props.stats.last.timestamp}
					durationMs={
						props.stats.last.nativePartial === true ||
						props.stats.last.stopReason === "pending"
							? undefined
							: props.stats.last.durationMs
					}
					clockLabel="request"
				/>
			</box>
		</box>
	);
}

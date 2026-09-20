/** Finding counts as one line, or three lines when the terminal is narrow
 * (establish-opencode-boundaries, task 6.1). Props-in: counts and the compact
 * rule are supplied by the caller. */
import { uiColors } from "@ui";
import type { FindingCounts } from "../../../contracts/workflow.ts";

export interface FindingCountSummaryProps {
	readonly counts: FindingCounts;
	readonly compact: boolean;
}

export function FindingCountSummary(props: FindingCountSummaryProps) {
	const entries = () => (
		<>
			<text fg={uiColors.error}>critical {props.counts.critical}</text>
			<text fg={uiColors.textMuted}> · </text>
			<text fg={uiColors.warning}>warning {props.counts.warning}</text>
			<text fg={uiColors.textMuted}> · </text>
			<text fg={uiColors.info}>info {props.counts.info}</text>
		</>
	);
	return props.compact ? (
		<box
			width="100%"
			minWidth={0}
			height={3}
			flexDirection="column"
			overflow="hidden"
		>
			<text fg={uiColors.error}>critical {props.counts.critical}</text>
			<text fg={uiColors.warning}>warning {props.counts.warning}</text>
			<text fg={uiColors.info}>info {props.counts.info}</text>
		</box>
	) : (
		<box
			width="100%"
			minWidth={0}
			height={1}
			flexDirection="row"
			overflow="hidden"
		>
			{entries()}
		</box>
	);
}

/** Evidence panel (`add-dashboard-evidence-panel`, reworked into the summary by
 * `evidence-summary-subview`).
 *
 * The developer's one-glance answer to *what did this run keep?*: the manifest
 * counted by kind on a single line, with a `report` marker when the run attached
 * a markdown report and a `flow` marker when it recorded a stage flow. The
 * listing — and the reading surface beside it — now lives in the evidence subview
 * (`Enter`), so this panel never grows with the manifest and the agents list above
 * it keeps its rows.
 *
 * Props-in: the manifest and the workflow's stage flow journal. The panel issues
 * no read itself and, per its requirement, offers no mutating action: the route
 * owns every read and `Enter` is a key the key handler dispatches. */

import { TextAttributes } from "@opentui/core";
import { Panel, uiColors } from "@ui";
import { createMemo, Show } from "solid-js";
import type { EvidenceEntry } from "../../../contracts/environment.ts";
import type { StageJournal } from "../../../contracts/stages.ts";
import {
	EVIDENCE_EMPTY_LINES,
	EVIDENCE_PANEL_LINES,
	type EvidenceReadState,
	evidenceHasReport,
	evidenceKindSummary,
	evidenceReadFailureMarker,
} from "../evidence-panel.ts";

/** What the manifest read is doing. Only a read that actually succeeded with no
 * entries renders the neutral empty state: "this run produced no evidence" is a
 * fact the dashboard has to have established, not the default. */
export type EvidencePanelState = EvidenceReadState;

export interface EvidencePanelProps {
	readonly entries: readonly EvidenceEntry[];
	/** The workflow's stage step journal, when it has one: the summary then
	 * carries the `flow` marker for the subview's grouped sidebar and its flow
	 * page action. */
	readonly journal?: StageJournal;
	readonly active: boolean;
	/** Panel height in lines: the full-width bottom row of the detail grid. */
	readonly height?: number;
	readonly state?: EvidencePanelState;
	/** The reason to show when `state` is "error". */
	readonly error?: string;
	/** Pointer: a tap anywhere in the panel focuses it (`J/K/H/L`). */
	readonly onFocusRequest?: () => void;
}

export function EvidencePanel(props: EvidencePanelProps) {
	// One summary line and one title row: the manifest's length is the subview's
	// problem, never this row's.
	const height = () =>
		Math.max(EVIDENCE_EMPTY_LINES, props.height ?? EVIDENCE_PANEL_LINES);
	const collapsed = () => height() <= EVIDENCE_EMPTY_LINES;
	const hasEntries = () => props.entries.length > 0;
	const summary = createMemo(() => evidenceKindSummary(props.entries));
	const hasReport = createMemo(() => evidenceHasReport(props.entries));
	const hasFlow = () =>
		props.journal !== undefined && props.journal.entries.length > 0;
	/** Why the panel has no summary to paint. Only a read that succeeded with no
	 * entries may say "no evidence": a read in flight or one that failed is a
	 * different fact. */
	const bodyMessage = () => {
		if (props.state === "error")
			return props.error
				? `Evidence could not be read: ${props.error}`
				: "Evidence could not be read";
		if (props.state === "loading") return "Loading evidence…";
		return "No evidence attached yet";
	};
	const body = () => (hasEntries() ? summary() : bodyMessage());
	/** What the title row carries beside the title: the markers that describe the
	 * manifest without a listing, and — on the collapsed empty state — the message
	 * the body would otherwise have painted. */
	const markers = () => [
		...(hasReport() ? [{ text: "report", failure: false }] : []),
		...(hasFlow() ? [{ text: "flow", failure: false }] : []),
		// A listing-free summary must still not pass a stale read off as a live one.
		...(hasEntries() && props.state !== undefined
			? [evidenceReadFailureMarker(props.state)].filter(
					(marker) => marker !== undefined,
				)
			: []),
		...(collapsed() && !hasEntries()
			? [{ text: bodyMessage(), failure: props.state === "error" }]
			: []),
	];
	return (
		<Panel
			title="Evidence"
			accent={uiColors.accent}
			active={props.active}
			style={{ width: "100%", height: height(), flexShrink: 0 }}
			{...(props.onFocusRequest
				? { onFocusRequest: props.onFocusRequest }
				: {})}
			accessory={
				<Show when={markers().length > 0}>
					<box style={{ flexDirection: "row", gap: 1 }}>
						{markers().map((marker) => (
							<text fg={marker.failure ? uiColors.error : uiColors.textMuted}>
								{marker.text}
							</text>
						))}
					</box>
				</Show>
			}
		>
			<Show when={!collapsed()}>
				<box
					style={{
						width: "100%",
						height: 1,
						overflow: "hidden",
						flexDirection: "row",
					}}
				>
					<text
						fg={
							hasEntries()
								? uiColors.textPrimary
								: props.state === "error"
									? uiColors.error
									: uiColors.textSecondary
						}
						attributes={hasEntries() ? TextAttributes.BOLD : 0}
					>
						{body()}
					</text>
				</box>
			</Show>
		</Panel>
	);
}

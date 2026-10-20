/** @jsxImportSource @opentui/solid */
// The stage picker (`open-stage-from-environments`).
//
// One dialog over the table, two steps: the allow-listed stages the server
// answered (display name, ident, environment and the stage's own access marker),
// then — for a stage with several UI applications — the application to open. The
// picker only ever shows what the catalog returned, so an excluded or invalid
// stage file is absent rather than greyed out; a failed read is the dialog's own
// message, because this is where "the server did not answer" is said.
//
// The rows carry no credential, no login recipe and no session: the app URL is
// the configured one, and Enter hands exactly that URL to the browser.

import type { StageAppStatus, StageStatus } from "@devenv/core";
import { TextAttributes } from "@opentui/core";
import { formatHelpText, ListViewModal, MatchedText, uiColors } from "@ui";
import { createMemo, Show } from "solid-js";
import {
	stageAppRowText,
	stageRowText,
} from "../actions/stage-picker-model.ts";

export interface StagePickerModalProps {
	/** Which step is showing: the stage list or the chosen stage's apps. */
	step: "stages" | "apps";
	/** Display name of the chosen stage, for the second step's title. */
	stageName?: string;
	/** The stages to offer (already filtered by the caller). */
	stages: StageStatus[];
	/** The second step's applications (already filtered by the caller). */
	apps: StageAppStatus[];
	selectedIndex: number;
	appIndex: number;
	filterQuery: string;
	filterActive: boolean;
	loading: boolean;
	/** The catalog read's failure, shown instead of the list. */
	error: string | null;
	/** A tap on a row selects it (the keyboard's `j`/`k`). */
	onSelectIndex?: (index: number) => void;
	onSelectAppIndex?: (index: number) => void;
	onFilterChange?: (query: string) => void;
	/** A tap on the selected row (the keyboard's `Enter`). */
	onActivate?: () => void;
	onBackdropClick?: () => void;
}

const WIDTH_PERCENT = 0.7;
const HEIGHT_PERCENT = 0.7;

export function StagePickerModal(props: StagePickerModalProps) {
	const appsStep = () => props.step === "apps";
	const rows = createMemo(() =>
		appsStep() ? props.apps.length : props.stages.length,
	);
	const clampedIndex = createMemo(() =>
		Math.max(
			0,
			Math.min(appsStep() ? props.appIndex : props.selectedIndex, rows() - 1),
		),
	);

	const helpText = () =>
		formatHelpText([
			{ key: "j/k", action: "Navigate" },
			{ key: "/", action: "Filter" },
			{ key: "Enter", action: appsStep() ? "Open in browser" : "Select" },
			{ key: "Esc", action: "Close" },
		]);

	/** Empty list: a failed read, an unconfigured catalog or a filter miss. */
	const empty = () => (
		<Show
			when={props.error !== null}
			fallback={
				<Show
					when={rows() === 0 && props.filterQuery !== ""}
					fallback={
						<text fg={uiColors.textSecondary}>
							No stages configured — see Settings → Stages / docs
						</text>
					}
				>
					<text fg={uiColors.textSecondary}>No stages match filter</text>
				</Show>
			}
		>
			<text fg={uiColors.error}>{props.error}</text>
		</Show>
	);

	return (
		<Show
			when={!appsStep()}
			fallback={
				<ListViewModal<StageAppStatus>
					title={`Open Stage · ${props.stageName ?? ""}`}
					helpText={helpText()}
					widthPercent={WIDTH_PERCENT}
					heightPercent={HEIGHT_PERCENT}
					items={props.apps}
					selectedIndex={clampedIndex()}
					filterPlaceholder="filter applications..."
					scrollIndicatorLabel="applications"
					filterQuery={props.filterQuery}
					filterActive={props.filterActive}
					{...(props.onFilterChange
						? { onFilterChange: props.onFilterChange }
						: {})}
					{...(props.onSelectAppIndex
						? { onSelect: props.onSelectAppIndex }
						: {})}
					{...(props.onActivate
						? { onActivate: () => props.onActivate?.() }
						: {})}
					{...(props.onBackdropClick
						? { onBackdropClick: props.onBackdropClick }
						: {})}
					emptyContent={empty()}
					renderItem={(app, isSelected) => (
						<box
							style={{
								width: "100%",
								height: 1,
								flexDirection: "row",
								flexShrink: 0,
								paddingLeft: 1,
							}}
						>
							<MatchedText
								text={stageAppRowText(app)}
								query={props.filterQuery}
								fg={
									isSelected() ? uiColors.textPrimary : uiColors.textSecondary
								}
								attributes={isSelected() ? TextAttributes.BOLD : undefined}
							/>
						</box>
					)}
				/>
			}
		>
			<ListViewModal<StageStatus>
				title="Open Stage"
				helpText={helpText()}
				widthPercent={WIDTH_PERCENT}
				heightPercent={HEIGHT_PERCENT}
				items={props.stages}
				selectedIndex={clampedIndex()}
				loading={props.loading}
				loadingText="reading stages..."
				filterPlaceholder="filter stages..."
				scrollIndicatorLabel="stages"
				filterQuery={props.filterQuery}
				filterActive={props.filterActive}
				{...(props.onFilterChange
					? { onFilterChange: props.onFilterChange }
					: {})}
				{...(props.onSelectIndex ? { onSelect: props.onSelectIndex } : {})}
				{...(props.onActivate
					? { onActivate: () => props.onActivate?.() }
					: {})}
				{...(props.onBackdropClick
					? { onBackdropClick: props.onBackdropClick }
					: {})}
				emptyContent={empty()}
				renderItem={(stage, isSelected) => (
					<box
						style={{
							width: "100%",
							height: 1,
							flexDirection: "row",
							flexShrink: 0,
							paddingLeft: 1,
						}}
					>
						<MatchedText
							text={stageRowText(stage)}
							query={props.filterQuery}
							fg={isSelected() ? uiColors.textPrimary : uiColors.textSecondary}
							attributes={isSelected() ? TextAttributes.BOLD : undefined}
						/>
					</box>
				)}
			/>
		</Show>
	);
}

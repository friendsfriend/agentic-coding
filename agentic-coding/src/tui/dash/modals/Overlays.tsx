/** Dashboard overlays (establish-opencode-boundaries, tasks 6.1/6.5).
 *
 * Every dialog the workflow-detail route can open above its panel grid:
 * repair targets, the completed-workflow action picker, the required user
 * action, the keybind help, the theme picker, verifier findings, plan
 * rejection, the cost breakdown, the preset switcher and the verdict reader.
 *
 * Props-in/callbacks-out. Each dialog's props object is `undefined` while the
 * dialog is closed, so presence *is* visibility; the route owns the state, the
 * modal stack and the focus restoration.
 */

import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import {
	HelpModal,
	ListViewModal,
	ThemePickerModal,
	uiColors,
	useKeyDispatch,
	useModalBackdrop,
	VerdictModal,
} from "@ui";
import { Show } from "solid-js";
import type { DebugRequestView } from "../../../contracts/environment.ts";
import type {
	WorkflowDefinitionGraph,
	WorkflowDefinitionOrigin,
} from "../../../contracts/workflow.ts";
import type {
	AgentSessionBlock,
	AgentSessionMetadata,
} from "../agent-session.ts";
import type { DebugRequestsReadState } from "../debug-requests-panel.ts";
import { CostModal } from "../ui/CostModal.tsx";
import { DebugRequestsModal } from "../ui/DebugRequestsModal.tsx";
import { FindingsModal } from "../ui/FindingsModal.tsx";
import { NotificationOverlay } from "../ui/Notification.tsx";
import type { PresetChoice } from "../ui/PresetSwitcherModal.tsx";
import { PresetSwitcherModal } from "../ui/PresetSwitcherModal.tsx";
import { WorkflowGraphModal } from "./WorkflowGraphModal.tsx";

export interface RepairOverlay {
	readonly revision: number;
	readonly items: readonly string[];
}

export interface PickerOverlay {
	readonly items: readonly string[];
	readonly reason: string;
	readonly followUp: boolean;
}

export interface UserActionOverlay {
	readonly title: string;
	readonly prompt: string;
	readonly items: readonly { readonly label: string }[];
}

export interface ThemeOverlay {
	readonly active: string;
	readonly themes: readonly string[];
}

export interface FindingsOverlay {
	readonly title: string;
	readonly events: Parameters<typeof FindingsModal>[0]["events"];
	readonly onDetailScrollBoxReady: (scrollBox: ScrollBoxRenderable) => void;
}

export interface PlanRejectionOverlay {
	readonly reasons: readonly string[];
	readonly selected: number;
	/** Pointer: a tap selects a reason (the keyboard's `j`/`k`). */
	readonly onSelectIndex: (index: number) => void;
}

export interface CostOverlay {
	readonly rows: Parameters<typeof CostModal>[0]["rows"];
}

export interface PresetSwitcherOverlay {
	readonly choices: readonly PresetChoice[];
	readonly selectedPreset?: string;
	readonly onKeyReady: (handler: (event: KeyEvent) => boolean) => void;
	readonly onCancel: () => void;
	readonly onSelect: (preset: string | undefined) => void;
}

export interface VerdictOverlay {
	readonly title: string;
	readonly content: string;
	readonly lines: number;
}

/** The workflow graph dialog (`g` on the Change panel). The definition is the
 * pinned one the Change panel names, and the graph may be absent when the pin
 * could not be resolved. */
export interface WorkflowGraphOverlay {
	readonly definition: { readonly label: string; readonly version: number };
	readonly origin?: WorkflowDefinitionOrigin;
	readonly graph?: WorkflowDefinitionGraph;
	readonly currentStep: string;
	readonly lines: number;
}

/** The overlay values and selections owned by `dash/state.ts`. */
export interface OverlaysState {
	readonly repairSelection: () => number;
	readonly completedSelection: () => number;
	readonly actionReason: () => string;
	readonly userActionSelection: () => number;
	readonly helpOffset: () => number;
	/** Pointer: the help modal's wheel moves this offset. */
	readonly setHelpOffset: (offset: number) => void;
	readonly workflowGraphOffset: () => number;
	/** Pointer: the graph dialog's wheel moves this offset. */
	readonly setWorkflowGraphOffset: (offset: number) => void;
	readonly themeIndex: () => number;
	/** Pointer: a tap on a theme row selects it. */
	readonly setThemeIndex: (index: number) => void;
	readonly themeQuery: () => string;
	readonly themeFiltering: () => boolean;
	readonly selectedFinding: () => number;
	readonly costSelection: () => number;
	readonly costAgent: () => string | null;
	readonly costOffset: () => number;
	readonly debugRequestsSelection: () => number;
	readonly debugRequestsOffset: () => number;
	/** Pointer: the debug-request report pane's wheel moves this offset. */
	readonly setDebugRequestsOffset: (offset: number) => void;
	/** Pointer selection setters, next to the accessors above. */
	readonly setRepairSelection: (index: number) => void;
	readonly setCompletedSelection: (index: number) => void;
	readonly setUserActionSelection: (index: number) => void;
	readonly setSelectedFinding: (index: number) => void;
	readonly setCostSelection: (index: number) => void;
	readonly setDebugRequestsSelection: (index: number) => void;
	readonly presetSwitcherChoices: () => readonly PresetChoice[];
	readonly presetSwitcherHandler: () =>
		| ((event: KeyEvent) => boolean)
		| undefined;
	readonly verdictOffset: () => number;
	readonly verdictRenderMarkdown: () => boolean;
	readonly agentSessionBlocks: () => readonly AgentSessionBlock[];
	readonly agentSessionMetadata: () => AgentSessionMetadata;
	readonly agentSessionContextWindows: () => Readonly<Record<string, number>>;
	readonly agentSessionDraft: () => string;
	readonly setAgentSessionDraft: (value: string) => void;
	readonly agentSessionHistory: () => readonly string[];
}

/** The delegated debug requests dialog's values (its selection and report
 * scroll live in `dash/state.ts`, like the other detail dialogs'). */
export interface DebugRequestsOverlay {
	readonly requests: readonly DebugRequestView[];
	readonly state: DebugRequestsReadState;
	readonly error?: string;
	readonly selectedIndex: number;
	readonly offset: number;
}

export interface OverlaysProps {
	readonly state: OverlaysState;
	/** Present only while the dialog is open. */
	readonly repair?: RepairOverlay;
	readonly completedPicker?: PickerOverlay;
	readonly userAction?: UserActionOverlay;
	readonly theme?: ThemeOverlay;
	readonly findings?: FindingsOverlay;
	readonly planRejection?: PlanRejectionOverlay;
	readonly cost?: CostOverlay;
	readonly debugRequests?: DebugRequestsOverlay;
	readonly presetSwitcher?: PresetSwitcherOverlay;
	readonly verdict?: VerdictOverlay;
	readonly workflowGraph?: WorkflowGraphOverlay;
	/** Short hint shown beside the action picker title. */
	readonly pickerHint?: string;
	/** Keybind help: zero lines means closed. */
	readonly helpLines: number;
}

export function Overlays(props: OverlaysProps) {
	// Activating a row is the dialog's own `Enter`: dispatching it keeps one
	// activation path (the open dialog's keymap layer) instead of a second table.
	const dispatch = useKeyDispatch();
	const activateRow = () => dispatch("Enter");
	// A backdrop tap is the dialog's `Esc`, never its confirmation: these four
	// pickers confirm irreversible work (repair, run, start, reject) and their
	// `Esc` is Cancel, so the shared backdrop binding dispatches that key and the
	// keymap's own layer decides what happens (design D2/D5).
	const repairBackdrop = useModalBackdrop({ kind: "repair-target" });
	const completedBackdrop = useModalBackdrop({
		kind: "completed-action-picker",
	});
	const userActionBackdrop = useModalBackdrop({ kind: "user-action" });
	const planRejectionBackdrop = useModalBackdrop({ kind: "plan-rejection" });
	return (
		<>
			<Show when={props.repair}>
				{(repair) => (
					<ListViewModal
						sizing="cap"
						{...repairBackdrop}
						title={`Repair r${repair().revision} · ENTER repairs`}
						fieldLabel="Compatible target"
						items={[...repair().items]}
						selectedIndex={props.state.repairSelection()}
						onSelect={props.state.setRepairSelection}
						onActivate={() => activateRow()}
						help={[
							{ key: "j/k", action: "Target" },
							{ key: "Enter", action: "Repair" },
							{ key: "Esc", action: "Cancel" },
						]}
						renderItem={(item, isSelected) => (
							<text
								fg={isSelected() ? uiColors.primary : uiColors.textSecondary}
							>
								{item}
							</text>
						)}
					/>
				)}
			</Show>
			<Show when={props.completedPicker}>
				{(picker) => (
					<ListViewModal
						{...completedBackdrop}
						title={`Choose workflow action · ${props.state.actionReason() || props.pickerHint || ""}`}
						fieldLabel="Action"
						items={[...picker().items]}
						selectedIndex={props.state.completedSelection()}
						onSelect={props.state.setCompletedSelection}
						onActivate={() => activateRow()}
						helpSections={false}
						help={[
							{ key: "j/k", action: "Navigate" },
							{
								key: "type",
								action: picker().followUp
									? "Follow-up question"
									: "Reason when required",
							},
							{ key: "Enter", action: "Run" },
							{ key: "Esc", action: "Cancel" },
						]}
						renderItem={(item, isSelected) => (
							<text
								fg={isSelected() ? uiColors.primary : uiColors.textSecondary}
							>
								{item}
							</text>
						)}
					/>
				)}
			</Show>
			<Show when={props.userAction}>
				{(action) => (
					<ListViewModal
						{...userActionBackdrop}
						title={`⚠ ${action().title}`}
						fieldLabel={action().prompt}
						items={[...action().items]}
						selectedIndex={props.state.userActionSelection()}
						onSelect={props.state.setUserActionSelection}
						onActivate={() => activateRow()}
						heightPercent={0.5}
						help={[
							{ key: "j/k", action: "Navigate" },
							{ key: "Enter", action: "Start" },
							{ key: "Esc", action: "Not now" },
						]}
						renderItem={(item, isSelected) => (
							<text
								fg={isSelected() ? uiColors.warning : uiColors.textSecondary}
								attributes={isSelected() ? TextAttributes.BOLD : 0}
							>
								{item.label}
							</text>
						)}
					/>
				)}
			</Show>
			<Show when={props.helpLines > 0}>
				<HelpModal
					title="Dashboard keybindings"
					offset={props.state.helpOffset()}
					onScrollOffset={props.state.setHelpOffset}
					lines={props.helpLines}
				/>
			</Show>
			<NotificationOverlay />
			<Show when={props.theme}>
				{(theme) => (
					<ThemePickerModal
						selected={props.state.themeIndex()}
						active={theme().active}
						themes={[...theme().themes]}
						query={props.state.themeQuery()}
						filtering={props.state.themeFiltering()}
						onSelect={props.state.setThemeIndex}
					/>
				)}
			</Show>
			<Show when={props.findings}>
				{(result) => (
					<FindingsModal
						title={result().title}
						events={result().events}
						selected={props.state.selectedFinding()}
						onSelectIndex={props.state.setSelectedFinding}
						onDetailScrollBoxReady={result().onDetailScrollBoxReady}
					/>
				)}
			</Show>
			<Show when={props.planRejection}>
				{(rejection) => (
					<ListViewModal
						{...planRejectionBackdrop}
						title="Reject plan"
						fieldLabel="Choose a rejection reason"
						items={[...rejection().reasons]}
						selectedIndex={rejection().selected}
						onSelect={rejection().onSelectIndex}
						onActivate={() => activateRow()}
						help={[
							{ key: "j/k", action: "Navigate" },
							{ key: "Enter", action: "Reject plan" },
							{ key: "Esc", action: "Cancel" },
						]}
						renderItem={(item, isSelected) => (
							<text
								fg={isSelected() ? uiColors.warning : uiColors.textSecondary}
							>
								{item}
							</text>
						)}
					/>
				)}
			</Show>
			<Show when={props.debugRequests}>
				{(overlay) => (
					<DebugRequestsModal
						{...overlay()}
						onSelectIndex={props.state.setDebugRequestsSelection}
						onOffsetChange={props.state.setDebugRequestsOffset}
					/>
				)}
			</Show>
			<Show when={props.cost}>
				{(cost) => (
					<CostModal
						rows={cost().rows}
						selected={props.state.costSelection()}
						agent={props.state.costAgent()}
						offset={props.state.costOffset()}
						onSelectIndex={props.state.setCostSelection}
					/>
				)}
			</Show>
			<Show when={props.presetSwitcher}>
				{(switcher) => (
					<PresetSwitcherModal
						choices={props.state.presetSwitcherChoices()}
						selected={switcher().selectedPreset}
						onKeyReady={(handler) => switcher().onKeyReady(handler)}
						onCancel={() => switcher().onCancel()}
						onSelect={(preset) => switcher().onSelect(preset)}
					/>
				)}
			</Show>
			<Show when={props.verdict}>
				{(report) => (
					<VerdictModal
						title={report().title}
						content={report().content}
						offset={props.state.verdictOffset()}
						lines={report().lines}
						renderMarkdown={props.state.verdictRenderMarkdown()}
					/>
				)}
			</Show>
			<Show when={props.workflowGraph}>
				{(graph) => (
					<WorkflowGraphModal
						onOffsetChange={props.state.setWorkflowGraphOffset}
						definition={graph().definition}
						origin={graph().origin}
						graph={graph().graph}
						currentStep={graph().currentStep}
						offset={props.state.workflowGraphOffset()}
						lines={graph().lines}
					/>
				)}
			</Show>
		</>
	);
}

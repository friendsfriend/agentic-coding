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
	VerdictModal,
} from "@ui";
import { Show } from "solid-js";
import type {
	AgentSessionBlock,
	AgentSessionMetadata,
} from "../agent-session.ts";
import { AgentSessionModal } from "../ui/AgentSessionModal.tsx";
import { CostModal } from "../ui/CostModal.tsx";
import { FindingsModal } from "../ui/FindingsModal.tsx";
import { NotificationOverlay } from "../ui/Notification.tsx";
import type { PresetChoice } from "../ui/PresetSwitcherModal.tsx";
import { PresetSwitcherModal } from "../ui/PresetSwitcherModal.tsx";

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

/** A live, writable durable agent session (add-pi-durable-runtime,
 * dashboard-agent-session-view). Live status text and the draft are read from
 * `OverlaysState` (high-frequency signals), matching the `verdictOffset`-style
 * split already used for the read-only overlays. */
export interface AgentSessionOverlay {
	readonly role: string;
	readonly models: readonly string[];
	readonly thinkingLevels: readonly string[];
	readonly onSubmit: (text: string) => void;
	readonly onAbort: () => void;
	readonly onClose: () => void;
	readonly onConfigure: (change: { model?: string; thinking?: string }) => void;
	/** The transcript scroll box, so the route's keymap layer can scroll it. */
	readonly onScrollBoxReady?: (box: ScrollBoxRenderable) => void;
	readonly onPickerKeyReady?: (handler: (event: KeyEvent) => boolean) => void;
	readonly onPickerActiveChange?: (active: boolean) => void;
}

/** The overlay values and selections owned by `dash/state.ts`. */
export interface OverlaysState {
	readonly repairSelection: () => number;
	readonly completedSelection: () => number;
	readonly actionReason: () => string;
	readonly userActionSelection: () => number;
	readonly helpOffset: () => number;
	readonly themeIndex: () => number;
	readonly themeQuery: () => string;
	readonly themeFiltering: () => boolean;
	readonly selectedFinding: () => number;
	readonly costSelection: () => number;
	readonly costAgent: () => string | null;
	readonly costOffset: () => number;
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
	readonly presetSwitcher?: PresetSwitcherOverlay;
	readonly verdict?: VerdictOverlay;
	readonly agentSession?: AgentSessionOverlay;
	/** Short hint shown beside the action picker title. */
	readonly pickerHint?: string;
	/** Keybind help: zero lines means closed. */
	readonly helpLines: number;
}

export function Overlays(props: OverlaysProps) {
	return (
		<>
			<Show when={props.repair}>
				{(repair) => (
					<ListViewModal
						sizing="cap"
						title={`Repair r${repair().revision} · ENTER repairs`}
						fieldLabel="Compatible target"
						items={[...repair().items]}
						selectedIndex={props.state.repairSelection()}
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
						title={`Choose workflow action · ${props.state.actionReason() || props.pickerHint || ""}`}
						fieldLabel="Action"
						items={[...picker().items]}
						selectedIndex={props.state.completedSelection()}
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
						title={`⚠ ${action().title}`}
						fieldLabel={action().prompt}
						items={[...action().items]}
						selectedIndex={props.state.userActionSelection()}
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
					/>
				)}
			</Show>
			<Show when={props.findings}>
				{(result) => (
					<FindingsModal
						title={result().title}
						events={result().events}
						selected={props.state.selectedFinding()}
						onDetailScrollBoxReady={result().onDetailScrollBoxReady}
					/>
				)}
			</Show>
			<Show when={props.planRejection}>
				{(rejection) => (
					<ListViewModal
						title="Reject plan"
						fieldLabel="Choose a rejection reason"
						items={[...rejection().reasons]}
						selectedIndex={rejection().selected}
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
			<Show when={props.cost}>
				{(cost) => (
					<CostModal
						rows={cost().rows}
						selected={props.state.costSelection()}
						agent={props.state.costAgent()}
						offset={props.state.costOffset()}
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
			<Show when={props.agentSession}>
				{(session) => (
					<AgentSessionModal
						role={session().role}
						blocks={props.state.agentSessionBlocks()}
						model={props.state.agentSessionMetadata().model}
						thinking={props.state.agentSessionMetadata().thinking}
						working={props.state.agentSessionMetadata().working}
						{...(props.state.agentSessionMetadata().error
							? { error: props.state.agentSessionMetadata().error }
							: {})}
						{...(props.state.agentSessionMetadata().contextTokens !== undefined
							? {
									contextTokens:
										props.state.agentSessionMetadata().contextTokens,
								}
							: {})}
						{...(props.state.agentSessionMetadata().cost !== undefined
							? { cost: props.state.agentSessionMetadata().cost }
							: {})}
						{...(props.state.agentSessionMetadata().model
							? {
									contextWindow:
										props.state.agentSessionContextWindows()[
											props.state.agentSessionMetadata().model as string
										],
								}
							: {})}
						models={session().models}
						thinkingLevels={session().thinkingLevels}
						draft={props.state.agentSessionDraft()}
						onDraftChange={(value) => props.state.setAgentSessionDraft(value)}
						onSubmit={(text) => session().onSubmit(text)}
						onAbort={() => session().onAbort()}
						onClose={() => session().onClose()}
						onConfigure={(change) => session().onConfigure(change)}
						onScrollBoxReady={session().onScrollBoxReady}
						onPickerKeyReady={session().onPickerKeyReady}
						onPickerActiveChange={session().onPickerActiveChange}
					/>
				)}
			</Show>
		</>
	);
}

// Dashboard page-local state (establish-opencode-boundaries, task 6.2).
//
// The dashboard route's own state, grouped by what it belongs to: which panel
// is focused, what each panel has selected, and the developer-dialogue form.
// None of it is server data — the cache lives in `tui/data` — and every group
// exposes plain signals plus the modal actions that open, move and close it, so
// a feature modal stays props-in/callbacks-out.
import type { KeyEvent } from "@opentui/core";
import { createSignal, type Setter } from "solid-js";

/** One finding row the findings overlay renders (the modal's own shape). */
export type FindingEvent = Parameters<
	typeof import("./ui/FindingsModal.tsx").FindingsModal
>[0]["events"][number];

/** One preset row the switcher renders (mirrors the modal's own choice shape). */
export interface PresetChoice {
	readonly label: string;
	readonly value?: string;
}

/** One drafted answer of the developer-dialogue form. */
export interface DialogueDraft {
	readonly kind: "option" | "custom";
	readonly value: string;
}

/** Which panel of the detail grid holds focus. */
export interface PanelState {
	readonly active: () => number;
	readonly setActive: Setter<number>;
	readonly agent: () => number;
	readonly setAgent: Setter<number>;
	/** OpenSpec artifacts shown by the artifact panel and their selection. */
	readonly artifacts: () => string[];
	readonly setArtifacts: Setter<string[]>;
	readonly artifact: () => number;
	readonly setArtifact: Setter<number>;
	/** Clamp every selection to the current list lengths. */
	readonly clamp: (counts: { agents: number; artifacts: number }) => void;
}

export function createPanelState(): PanelState {
	const [active, setActiveSignal] = createSignal(0);
	const [agent, setAgentSignal] = createSignal(0);
	const [artifacts, setArtifactsSignal] = createSignal<string[]>([]);
	const [artifact, setArtifactSignal] = createSignal(0);
	const clampIndex = (value: number, length: number) =>
		Math.max(0, Math.min(value, Math.max(0, length - 1)));
	return {
		active,
		setActive: setActiveSignal,
		agent,
		setAgent: setAgentSignal,
		artifacts,
		setArtifacts: setArtifactsSignal,
		artifact,
		setArtifact: setArtifactSignal,
		clamp: ({ agents, artifacts: artifactCount }) => {
			setAgentSignal((index) => clampIndex(index, agents));
			setArtifactSignal((index) => clampIndex(index, artifactCount));
		},
	};
}

/** The developer-dialogue form: which question, which tab, and the drafts.
 * Visibility belongs to the shell modal host, so this state is values only. */
export interface DialogueState {
	readonly tab: () => number;
	readonly setTab: Setter<number>;
	readonly promptOffset: () => number;
	readonly setPromptOffset: Setter<number>;
	readonly selection: () => number;
	readonly setSelection: Setter<number>;
	readonly custom: () => boolean;
	readonly setCustom: Setter<boolean>;
	readonly customText: () => string;
	readonly setCustomText: Setter<string>;
	readonly drafts: () => Record<string, DialogueDraft>;
	readonly setDrafts: Setter<Record<string, DialogueDraft>>;
	readonly submitting: () => boolean;
	readonly setSubmitting: Setter<boolean>;
	/** Markdown detail of the option opened with `d`, if any. */
	readonly optionDetail: () => OptionDetail | undefined;
	readonly setOptionDetail: Setter<OptionDetail | undefined>;
	/** Scroll offset of the option-detail markdown modal. */
	readonly detailOffset: () => number;
	readonly setDetailOffset: Setter<number>;
	/** Reset the form when the answerable question changes. */
	readonly reset: () => void;
}

/** The option-detail markdown modal's title and body. */
export interface OptionDetail {
	readonly title: string;
	readonly content: string;
}

export function createDialogueState(): DialogueState {
	const [tab, setTab] = createSignal(0);
	const [promptOffset, setPromptOffset] = createSignal(0);
	const [selection, setSelection] = createSignal(0);
	const [custom, setCustom] = createSignal(false);
	const [customText, setCustomText] = createSignal("");
	const [drafts, setDrafts] = createSignal<Record<string, DialogueDraft>>({});
	const [submitting, setSubmitting] = createSignal(false);
	const [optionDetail, setOptionDetail] = createSignal<
		OptionDetail | undefined
	>(undefined);
	const [detailOffset, setDetailOffset] = createSignal(0);
	return {
		tab,
		setTab,
		promptOffset,
		setPromptOffset,
		selection,
		setSelection,
		custom,
		setCustom,
		customText,
		setCustomText,
		drafts,
		setDrafts,
		submitting,
		setSubmitting,
		optionDetail,
		setOptionDetail,
		detailOffset,
		setDetailOffset,
		reset: () => {
			setTab(0);
			setPromptOffset(0);
			setSelection(0);
			setCustom(false);
			setCustomText("");
			setSubmitting(false);
			setOptionDetail(undefined);
			setDetailOffset(0);
		},
	};
}

/** Overlay values (establish-opencode-boundaries, task 6.2): what each dialog
 * shows and where its selection is. Visibility lives with the modal host, so
 * these are values and selections only — the route still decides what is open
 * and the overlay module only renders it. */
export interface OverlayState {
	readonly verdict: () => { title: string; content: string } | undefined;
	readonly setVerdict: Setter<{ title: string; content: string } | undefined>;
	readonly verdictOffset: () => number;
	readonly setVerdictOffset: Setter<number>;
	readonly verdictReturnToFindings: () => boolean;
	readonly setVerdictReturnToFindings: Setter<boolean>;
	readonly verdictReturnToUserAction: () => boolean;
	readonly setVerdictReturnToUserAction: Setter<boolean>;
	readonly verdictRenderMarkdown: () => boolean;
	readonly setVerdictRenderMarkdown: Setter<boolean>;
	readonly findings: () => FindingsOverlayData | undefined;
	readonly setFindings: Setter<FindingsOverlayData | undefined>;
	readonly selectedFinding: () => number;
	readonly setSelectedFinding: Setter<number>;
	readonly repairTargets: () => RepairTarget[];
	readonly setRepairTargets: Setter<RepairTarget[]>;
	readonly repairSelection: () => number;
	readonly setRepairSelection: Setter<number>;
	readonly completedSelection: () => number;
	readonly setCompletedSelection: Setter<number>;
	readonly actionReason: () => string;
	readonly setActionReason: Setter<string>;
	readonly userActionSelection: () => number;
	readonly setUserActionSelection: Setter<number>;
	readonly helpOffset: () => number;
	readonly setHelpOffset: Setter<number>;
	readonly themeIndex: () => number;
	readonly setThemeIndex: Setter<number>;
	readonly themeQuery: () => string;
	readonly setThemeQuery: Setter<string>;
	readonly themeFiltering: () => boolean;
	readonly setThemeFiltering: Setter<boolean>;
	readonly costSelection: () => number;
	readonly setCostSelection: Setter<number>;
	readonly costAgent: () => string | null;
	readonly setCostAgent: Setter<string | null>;
	readonly costOffset: () => number;
	readonly setCostOffset: Setter<number>;
	readonly presetSwitcherHandler: () =>
		| ((event: KeyEvent) => boolean)
		| undefined;
	readonly setPresetSwitcherHandler: Setter<
		((event: KeyEvent) => boolean) | undefined
	>;
	readonly presetSwitcherChoices: () => PresetChoice[];
	readonly setPresetSwitcherChoices: Setter<PresetChoice[]>;
}

export interface RepairTarget {
	readonly targetStep: string;
	readonly label: string;
}

export interface FindingsOverlayData {
	readonly title: string;
	readonly events: readonly FindingEvent[];
}

export function createOverlayState(options: {
	/** Index of the currently applied theme name in the registry. */
	readonly themeIndex: number;
}): OverlayState {
	const [repairTargets, setRepairTargets] = createSignal<RepairTarget[]>([]);

	const [presetSwitcherHandler, setPresetSwitcherHandler] =
		createSignal<(event: KeyEvent) => boolean>();

	const [presetSwitcherChoices, setPresetSwitcherChoices] = createSignal<
		PresetChoice[]
	>([]);

	const [themeIndex, setThemeIndex] = createSignal(options.themeIndex);

	const [verdict, setVerdict] = createSignal<{
		title: string;
		content: string;
	}>();
	const [verdictReturnToFindings, setVerdictReturnToFindings] =
		createSignal(false);
	const [verdictReturnToUserAction, setVerdictReturnToUserAction] =
		createSignal(false);
	const [findings, setFindings] = createSignal<
		FindingsOverlayData | undefined
	>();
	const [verdictOffset, setVerdictOffset] = createSignal(0);

	const [verdictRenderMarkdown, setVerdictRenderMarkdown] = createSignal(false);

	const [selectedFinding, setSelectedFinding] = createSignal(0);

	const [repairSelection, setRepairSelection] = createSignal(0);

	const [completedSelection, setCompletedSelection] = createSignal(0);

	const [actionReason, setActionReason] = createSignal("");

	const [userActionSelection, setUserActionSelection] = createSignal(0);

	const [helpOffset, setHelpOffset] = createSignal(0);

	const [themeQuery, setThemeQuery] = createSignal("");

	const [themeFiltering, setThemeFiltering] = createSignal(false);

	const [costSelection, setCostSelection] = createSignal(0);

	const [costAgent, setCostAgent] = createSignal<string | null>(null);

	const [costOffset, setCostOffset] = createSignal(0);
	return {
		verdict,
		setVerdict,
		verdictOffset,
		setVerdictOffset,
		verdictReturnToFindings,
		setVerdictReturnToFindings,
		verdictReturnToUserAction,
		setVerdictReturnToUserAction,
		verdictRenderMarkdown,
		setVerdictRenderMarkdown,
		findings,
		setFindings,
		selectedFinding,
		setSelectedFinding,
		repairTargets,
		setRepairTargets,
		repairSelection,
		setRepairSelection,
		completedSelection,
		setCompletedSelection,
		actionReason,
		setActionReason,
		userActionSelection,
		setUserActionSelection,
		helpOffset,
		setHelpOffset,
		themeIndex,
		setThemeIndex,
		themeQuery,
		setThemeQuery,
		themeFiltering,
		setThemeFiltering,
		costSelection,
		setCostSelection,
		costAgent,
		setCostAgent,
		costOffset,
		setCostOffset,
		presetSwitcherHandler,
		setPresetSwitcherHandler,
		presetSwitcherChoices,
		setPresetSwitcherChoices,
	};
}

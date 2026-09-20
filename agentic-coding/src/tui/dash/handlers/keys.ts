/** Dashboard key handling (establish-opencode-boundaries, task 6.5).
 *
 * The route's whole key surface as one function with an explicit context: the
 * panels, the review/dialogue routes, the overlays and the shell's modal help.
 * Moving it here leaves `App.tsx` a route/composition coordinator — it wires
 * state, data and callbacks, and this module decides what a key means.
 */
import type { KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import type { DashboardData } from "../../../contracts/workflow.ts";
import { copyToClipboard } from "../../clipboard.ts";
import { movePanel, type PanelDirection } from "../panel-grid.ts";

/** The route props the handler reads. */
export interface DashboardKeyProps {
	readonly repo: string;
	readonly workflowId: string;
	readonly profile?: string;
	readonly active?: () => boolean;
	readonly keymap: Keymap<Renderable, KeyEvent>;
}

export interface DashboardKeyContext {
	readonly keymap: Keymap<Renderable, KeyEvent>;
	readonly renderer: {
		getSelection: () => { getSelectedText: () => string } | null;
		destroy: () => void;
	};
	readonly busy: () => boolean;
	readonly activePanel: () => number;
	readonly setActivePanel: (index: number) => void;
	readonly refresh: () => void;
	readonly selectedAgent: () => number;
	readonly setSelectedAgent: (index: number) => void;
	readonly selectedArtifact: () => number;
	readonly setSelectedArtifact: (index: number) => void;
	readonly artifacts: () => string[];
	readonly data: () => DashboardData;
	readonly dimensions: () => { width: number; height: number };
	readonly notify: (
		message: string,
		kind?: "info" | "success" | "warning" | "error",
	) => void;
	readonly trace: (
		name: string,
		payload?: Record<string, unknown>,
		outcome?: "ok" | "error",
		durationMs?: number,
	) => void;
	/** Route a key to the open modal's `?` help overlay. */
	readonly routeModalHelp: (key: string) => boolean;
	readonly props: DashboardKeyProps;
	/** Scroll the change panel (the panel owns the scroll box). */
	readonly scrollChangePanel: (lines: number) => void;
	/** Cancellation signal for artifact reads, when one is in flight. */
	readonly artifactSignal: () => AbortSignal | undefined;
	/** The required user action whose key was already prompted. */
	readonly userActionPrompt: () => string | undefined;
	readonly setUserActionPrompt: (key: string | undefined) => void;
	readonly setBusy: (busy: boolean) => void;
	readonly setData: (data: DashboardData) => void;
	readonly loadDashboard: (
		repo: string,
		workflowId: string,
	) => Promise<DashboardData | undefined>;
	readonly focusReturnWorkspace: (
		repo: string,
		workflowId: string,
		workspace: string,
	) => void;
	readonly applyTheme: (name: string) => void;
	readonly themeNames: readonly string[];
	readonly setDemoIndex: (update: (index: number) => number) => void;
	readonly openFindingInEditor: (path: string, line: number) => void;
	readonly focusAgentAsync: (
		state: DashboardData["state"],
		role: string,
	) => Promise<void>;
	readonly switchWorkflowPreset: (
		repo: string,
		workflowId: string,
		revision: number,
		preset: string,
	) => Promise<void>;
	readonly runWorkflow: (
		action: string,
		repo: string,
		workflowId: string,
		revision: number,
		argument?: string,
	) => Promise<string>;
	readonly applyRepair: (
		repo: string,
		workflowId: string,
		revision: number,
		targetStep: string,
		reason?: string,
	) => Promise<unknown>;
	readonly answerQuestion: (
		repo: string,
		workflowId: string,
		revision: number,
		questionId: string,
		answer: unknown,
	) => Promise<unknown>;
	readonly previewRepair: (
		repo: string,
		workflowId: string,
	) => Promise<unknown>;
	readonly requestExecution: (
		repo: string,
		workflowId?: string,
	) => Promise<void>;
	readonly openArtifact: (artifact: string) => Promise<void>;
	/** Read one OpenSpec artifact (gateway-backed, or the checkout directly). */
	readonly readArtifact: (
		state: DashboardData["state"],
		artifact: string,
	) => Promise<string>;
	readonly openSpecArtifact: (
		state: DashboardData["state"],
		artifact: string,
	) => string;
	readonly openSpecArtifacts: (state: DashboardData["state"]) => string[];
	readonly verdictLines: () => number;
	readonly requiredUserAction: () => unknown;
	readonly completedActions: () => readonly {
		readonly label: string;
		readonly command?: string;
	}[];
	readonly completedInputHint: () => string;
	readonly planRejectionReasons: readonly string[];
	readonly openCost: () => void;
	readonly openReview: (kind: "developer" | "plan" | "wiki") => void;
	readonly setThemePicker: (open: boolean) => void;
	readonly setRepairTargets: (targets: unknown[]) => void;
	readonly setRepairOpen: (open: boolean) => void;
	readonly setRepairSelection: (index: number) => void;
	readonly setCompletedPicker: (open: boolean) => void;
	readonly setCostOpen: (open: boolean) => void;
	readonly setHelp: (open: boolean) => void;
	readonly setHelpOffset: (offset: number) => void;
	readonly setActionReason: (reason: string) => void;
	readonly setCompletedSelection: (index: number) => void;
	readonly setCostSelection: (index: number) => void;
	readonly setCostAgent: (agent: string | null) => void;
	readonly setCostOffset: (offset: number) => void;
	readonly setVerdict: (
		value: { title: string; content: string } | undefined,
	) => void;
	readonly setVerdictOffset: (offset: number) => void;
	readonly setVerdictRenderMarkdown: (render: boolean) => void;
	readonly setVerdictReturnToFindings: (value: boolean) => void;
	readonly setVerdictReturnToUserAction: (value: boolean) => void;
	readonly setFindings: (value: unknown) => void;
	readonly setSelectedFinding: (index: number) => void;
	readonly findings: () => unknown;
	readonly verdict: () => { title: string; content: string } | undefined;
	readonly setPresetSwitcherHandler: (handler: unknown) => void;
	readonly setPresetSwitcherChoices: (choices: unknown[]) => void;
	readonly setReviewOpen: (open: boolean) => void;
	readonly reviewFeature: unknown;
	readonly setQuestionOpen: (open: boolean) => void;
	readonly setUserActionOpen: (open: boolean) => void;
	readonly openUserAction: () => void;
	readonly setArtifacts: (artifacts: string[]) => void;
	readonly demoPhases: readonly string[];
	readonly themeIndex: () => number;
	readonly gate: () =>
		| {
				readonly prompt: string;
				readonly action: string;
		  }
		| undefined;
	readonly help: () => boolean;
	readonly openDeveloperReview: () => void;
	readonly openPlanReview: () => void;
	readonly openVerifierResult: (role: string) => Promise<void>;
	readonly openRequiredUserAction: () => boolean | undefined;
	readonly openPresetSwitcher: () => void;
}

export function createDashboardKeyHandler(
	context: DashboardKeyContext,
): (key: KeyEvent) => Promise<void> {
	return async (key: KeyEvent) => {
		const {
			renderer,
			busy,
			activePanel,
			setActivePanel,
			selectedAgent,
			setSelectedAgent,
			selectedArtifact,
			setSelectedArtifact,
			artifacts,
			data,
			notify,
			props,
		} = context;
		const traceTui = context.trace;
		const _routeModalHelp = context.routeModalHelp;
		const setBusy = context.setBusy;
		const loadDashboard = context.loadDashboard;
		const focusReturnWorkspace = context.focusReturnWorkspace;
		const applyTheme = context.applyTheme;
		const themeNames = context.themeNames;
		const demoPhases = context.demoPhases;
		const setDemoIndex = context.setDemoIndex;
		const openVerifierResult = context.openVerifierResult;
		const openDeveloperReview = context.openDeveloperReview;
		const openPlanReview = context.openPlanReview;
		const _openRequiredUserAction = context.openRequiredUserAction;
		const openPresetSwitcher = context.openPresetSwitcher;
		const _openFindingInEditor = context.openFindingInEditor;
		const focusAgentAsync = context.focusAgentAsync;
		const _switchWorkflowPreset = context.switchWorkflowPreset;
		const runWorkflow = context.runWorkflow;
		const _applyRepair = context.applyRepair;
		const _answerQuestion = context.answerQuestion;
		const previewRepair = context.previewRepair;
		const _requestExecution = context.requestExecution;
		const _openArtifact = context.openArtifact;
		const _openSpecArtifact = context.openSpecArtifact;
		const _openSpecArtifacts = context.openSpecArtifacts;
		const _verdictLines = context.verdictLines;
		const _requiredUserAction = context.requiredUserAction;
		const _completedActions = context.completedActions;
		const _completedInputHint = context.completedInputHint;
		const _planRejectionReasons = context.planRejectionReasons;
		const _openCost = context.openCost;
		const _openReview = context.openReview;
		const _openPresetSwitcherInternal = context.openPresetSwitcher;
		const themeIndex = context.themeIndex;
		const setThemePicker = context.setThemePicker;
		const setRepairTargets = context.setRepairTargets;
		const setRepairOpen = context.setRepairOpen;
		const setRepairSelection = context.setRepairSelection;
		const setCompletedPicker = context.setCompletedPicker;
		const setCostOpen = context.setCostOpen;
		const setHelp = context.setHelp;
		const setHelpOffset = context.setHelpOffset;
		const setActionReason = context.setActionReason;
		const setCompletedSelection = context.setCompletedSelection;
		const setCostSelection = context.setCostSelection;
		const setCostAgent = context.setCostAgent;
		const setCostOffset = context.setCostOffset;
		const setVerdict = context.setVerdict;
		const setVerdictOffset = context.setVerdictOffset;
		const setVerdictRenderMarkdown = context.setVerdictRenderMarkdown;
		const _setVerdictReturnToFindings = context.setVerdictReturnToFindings;
		const _setVerdictReturnToUserAction = context.setVerdictReturnToUserAction;
		const _setFindings = context.setFindings;
		const _setSelectedFinding = context.setSelectedFinding;
		const _findings = context.findings;
		const _verdict = context.verdict;
		const _setPresetSwitcherHandler = context.setPresetSwitcherHandler;
		const _setPresetSwitcherChoices = context.setPresetSwitcherChoices;
		const _setReviewOpen = context.setReviewOpen;
		const _reviewFeature = context.reviewFeature;
		const _setQuestionOpen = context.setQuestionOpen;
		const _setUserActionOpen = context.setUserActionOpen;
		const _openUserAction = context.openUserAction;
		const _setArtifacts = context.setArtifacts;
		const _notifyUser = notify;
		const refresh = context.refresh;
		const gate = context.gate;
		const _openRequiredUserActionResult = () =>
			context.openRequiredUserAction();
		const _openPresetSwitcherInternal2 = context.openPresetSwitcher;
		let lastQuitAt = 0;
		traceTui("tui.dashboard.key", {
			surface: "dashboard",
			action: "key",
			key: key.name,
			modal:
				props.keymap.getData?.("modal.active") === undefined
					? "none"
					: String(props.keymap.getData?.("modal.active")),
		});
		if (busy()) return;
		const name = key.name.toLowerCase();
		if (name === "q" || (key.ctrl && name === "c")) {
			const selection = renderer.getSelection()?.getSelectedText();
			if (key.ctrl && selection) {
				if (copyToClipboard(selection)) notify("Selection copied", "success");
				else notify("Copy failed", "error");
				return;
			}
			const now = Date.now();
			if (now - lastQuitAt < 1000) renderer.destroy();
			else {
				lastQuitAt = now;
				notify(`If you want to quit press ${key.ctrl ? "Ctrl+C" : "q"} again`);
			}
			return;
		}
		if (key.meta && name === "c") {
			const selection = renderer.getSelection()?.getSelectedText();
			if (selection) {
				if (copyToClipboard(selection)) notify("Selection copied", "success");
				else notify("Copy failed", "error");
			} else notify("No selection to copy", "warning");
			return;
		}
		if (name === "escape") {
			setBusy(true);
			try {
				const current =
					props.profile === "test"
						? data()
						: await loadDashboard(props.repo, props.workflowId);
				const workspace = current?.state.returnWorkspace;
				if (!workspace)
					throw new Error(
						"No dashboard workspace recorded. Open this workflow from the overview first.",
					);
				focusReturnWorkspace(props.repo, props.workflowId, workspace);
			} catch {
				traceTui(
					"tui.dashboard.action",
					{ surface: "dashboard", action: "return-workspace" },
					"error",
				);
			} finally {
				setBusy(false);
			}
			return;
		}
		if (name === "t" && key.shift) {
			applyTheme(themeNames[themeIndex()]);
			setThemePicker(true);
			props.keymap.setData("modal.active", "theme");
			return;
		}
		if (name === "o" && key.shift) {
			void (async () => {
				try {
					setRepairTargets(
						(await previewRepair(props.repo, props.workflowId)) as Array<{
							targetStep: string;
							label: string;
							expiresRuns: string[];
							retainedEvidence: string[];
						}>,
					);
					setRepairSelection(0);
					setRepairOpen(true);
					props.keymap.setData("modal.active", "repair");
				} catch {
					traceTui(
						"tui.dashboard.action",
						{ surface: "dashboard", action: "repair-preview" },
						"error",
					);
				}
			})();
			return;
		}
		if (name === "?") {
			setHelp(true);
			setHelpOffset(0);
			props.keymap.setData("modal.active", "help");
			return;
		}
		if (name === "m") {
			openPresetSwitcher();
			return;
		}
		if (name === "c") {
			setCostAgent(null);
			setCostSelection(0);
			setCostOffset(0);
			setCostOpen(true);
			props.keymap.setData("modal.active", "cost");
			return;
		}

		if (name === "v" && activePanel() === 1) {
			// Silent no-op for non-verification agents: only verifier roles have
			// results to show.
			const agent = data().agents[selectedAgent()];
			if (!agent?.role.endsWith("verifier")) return;
			try {
				void openVerifierResult(agent.role);
			} catch {
				traceTui(
					"tui.dashboard.action",
					{ surface: "dashboard", action: "verifier-open" },
					"error",
				);
			}
			return;
		}
		if (name === "r") {
			refresh();
			return;
		}
		if (
			(name === "j" && key.shift) ||
			(name === "k" && key.shift) ||
			(name === "h" && key.shift) ||
			(name === "l" && key.shift)
		) {
			const direction: PanelDirection =
				name === "j"
					? "down"
					: name === "k"
						? "up"
						: name === "h"
							? "left"
							: "right";
			setActivePanel(
				movePanel(activePanel(), direction, {
					artifactsVisible: artifacts().length > 0,
				}),
			);
			return;
		}
		if (name === "down" || name === "j") {
			if (activePanel() === 0) context.scrollChangePanel(1);
			else if (activePanel() === 1)
				setSelectedAgent(
					Math.min(data().agents.length - 1, selectedAgent() + 1),
				);
			else if (activePanel() === 6)
				setSelectedArtifact(
					Math.min(Math.max(0, artifacts().length - 1), selectedArtifact() + 1),
				);
			return;
		}
		if (name === "up" || name === "k") {
			if (activePanel() === 0) context.scrollChangePanel(-1);
			else if (activePanel() === 1)
				setSelectedAgent(Math.max(0, selectedAgent() - 1));
			else if (activePanel() === 6)
				setSelectedArtifact(Math.max(0, selectedArtifact() - 1));
			return;
		}
		if (name === "enter" || name === "return") {
			// openRequiredUserAction is the sole gate for reopening a review popup
			// on Enter: once its context.userActionPrompt()/activePanel guard has
			// dismissed one, Enter falls through to whatever the focused panel
			// does instead of force-reopening it (previously a `core.*` stepId
			// check bypassed that guard for engine-driven views only).
			if (context.openRequiredUserAction() === true) return;
			if (activePanel() === 6) {
				const artifact = artifacts()[selectedArtifact()];
				if (artifact) {
					setVerdictRenderMarkdown(true);
					setVerdict({
						title: `OpenSpec · ${artifact}`,
						content: "Loading artifact…",
					});
					setVerdictOffset(0);
					props.keymap.setData("modal.active", "verdict");
					void context
						.readArtifact(data().state, artifact)
						.then((content) =>
							setVerdict({
								title: `OpenSpec · ${artifact}`,
								content,
							}),
						)
						.catch((error) =>
							setVerdict({
								title: `OpenSpec · ${artifact}`,
								content: `Could not open ${artifact}: ${error instanceof Error ? error.message : String(error)}`,
							}),
						);
				}
				return;
			}
			if (activePanel() === 1) {
				const agent = data().agents[selectedAgent()];
				if (!agent) return;
				try {
					const pane = data().state.panes[agent.role];
					if (!pane) return;
					await focusAgentAsync(data().state, pane);
				} catch {
					traceTui(
						"tui.dashboard.action",
						{ surface: "dashboard", action: "focus-agent" },
						"error",
					);
				}
				return;
			}
			const approval = gate();
			if (!approval) return;
			if (approval.action === "review") {
				openDeveloperReview();
				return;
			}
			if (
				approval.action === "plan-review" ||
				approval.action === "wiki-review"
			) {
				openPlanReview();
				return;
			}
			if (approval.action === "completed-actions") {
				setCompletedPicker(true);
				setCompletedSelection(0);
				setActionReason("");
				props.keymap.setData("modal.active", "completed-picker");
				return;
			}
			setBusy(true);
			try {
				if (props.profile === "test") {
					setDemoIndex((index) => (index + 1) % demoPhases.length);
				} else {
					await runWorkflow(
						approval.action,
						props.repo,
						props.workflowId,
						data().state.revision,
					);
				}
				traceTui("tui.dashboard.action", {
					surface: "dashboard",
					action: approval.action,
				});
				refresh();
			} catch {
				traceTui(
					"tui.dashboard.action",
					{ surface: "dashboard", action: approval.action },
					"error",
				);
			} finally {
				setBusy(false);
			}
		}
	};
}

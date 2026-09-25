/** @jsxImportSource @opentui/solid */

import { join } from "node:path";
import type { KeyEvent, Renderable, ScrollBoxRenderable } from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import { useRenderer } from "@opentui/solid";
import {
	activeErrorModal,
	createModalHost,
	findModal,
	getActiveThemeName,
	handleModalHelpKey,
	Layout,
	modalHelpOpen,
	registerFocusRestorer,
	restoreFocus,
	setActiveKeybindCatalog,
	showErrorModal,
	themeNames,
	uiColors,
	useTerminalDimensions,
} from "@ui";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
	untrack,
} from "solid-js";
import type { RequiredUserActionItem } from "../../contracts/actions.ts";
import type { DashboardData } from "../../contracts/workflow";
import {
	type DeveloperDialogueRecord,
	resolveDeveloperQuestionOption,
} from "../../contracts/workflow.ts";

import { wikiWorkflowDataRoot } from "../../workflow/runtime.ts";
import { loadArtifact, loadArtifacts } from "../data/git.ts";
import { gatewayOrUndefined } from "../data/index.ts";
import {
	answerQuestion,
	applyRepair,
	loadDashboard,
	loadDashboardSeed,
	loadVerifierFindings,
	loadVerifierReport,
	previewRepair,
	requestExecution,
	runWorkflow,
} from "../data/workflow.ts";
import { testDashboard } from "./demo.ts";
import { createDashboardKeyHandler } from "./handlers/keys.ts";
import { dashboardDetailKeybindCatalog, panelContext } from "./keybinds.ts";
import {
	focusAgentAsync,
	focusReturnWorkspace,
	herdrEventMatchesWorkspace,
	listPresetNames,
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
	openFindingInEditorAsync,
	openSpecArtifact,
	openSpecArtifacts,
	PRESET_CONFIG_DEFAULTS,
	reconcileSidebarPresentation,
	reconcileWorkflowNotifications,
	serverOwnsExecutionEvents,
	subscribeDataEvents,
	subscribeHerdrEvents,
	switchWorkflowPreset,
} from "./live.ts";
import { Overlays } from "./modals/Overlays.tsx";
import { notify } from "./notifications.ts";
import { AgentsPanel } from "./panels/AgentsPanel.tsx";
import { ChangePanel } from "./panels/ChangePanel.tsx";
import { OpenSpecPanel } from "./panels/OpenSpecPanel.tsx";
import {
	agentMetricLine,
	agentRuntimeModelLine,
	approvalFor,
	type PhaseStatusState,
	phaseStatus,
	requiredUserActionFor,
} from "./projections.ts";
import { createReviewFeature } from "./review.ts";
import { DialogueRoute } from "./routes/DialogueRoute.tsx";
import { ReviewRoute } from "./routes/ReviewRoute.tsx";
import {
	createDialogueState,
	createOverlayState,
	createPanelState,
} from "./state.ts";
import { applyTheme, loadThemeName, saveThemeName } from "./theme-settings.ts";
import { traceTui } from "./tracing.ts";
import { pendingCredentialRequest } from "./ui/CredentialsModal.tsx";
import type { FindingEvent } from "./ui/FindingsModal.tsx";
import {
	debounce,
	startSafetyResync,
	watchDirectories,
} from "./watchRefresh.ts";

export { PhaseStatus } from "./ui/PhaseStatus.tsx";
export type { PhaseStatusState };
// Projection helpers are owned by `projections.ts`; these narrow re-exports
// keep the public dashboard root surface (and its renderer tests) stable.
export { agentMetricLine, agentRuntimeModelLine, phaseStatus };

/** Header context derived from the dashboard's single data source. */
export interface WorkflowHeaderInfo {
	change: string;
	phase: string;
	branch: string;
	updated: string;
}

export function App(props: {
	repo: string;
	workflowId: string;
	profile?: "test";
	/** Test fixture override for rendering a branch without a usable upstream. */
	testNoUpstream?: boolean;
	/** Test fixture override for rendering a custom dashboard (e.g. with artifacts). */
	testData?: DashboardData;
	keymap: Keymap<Renderable, KeyEvent>;
	/** Set only when the dashboard is mounted inside the unified shell. */
	shellFeature?: "workflows";
	active?: () => boolean;
	/** Push the workflow header context up to the composition root's header. */
	onHeader?: (header: WorkflowHeaderInfo | null) => void;
}) {
	let findingDetailScroll: ScrollBoxRenderable | undefined;
	const renderer = useRenderer();
	const dimensions = useTerminalDimensions();
	const demoPhases = [
		"proposed",
		"apply",
		"verify",
		"developer-review",
		"archive",
		"completed",
	] as const;
	const [demoIndex, setDemoIndex] = createSignal(0);
	/** Synchronous seed for the first frame: the test/demo data, or the inline
	 * placeholder below. Real data arrives from `tui/data` (the cache is
	 * reactive, so the refresh lands without a second render path). */
	const load = () => {
		if (props.testData) return props.testData;
		const dashboard = testDashboard(demoPhases[demoIndex()]);
		if (!props.testNoUpstream) return dashboard;
		return {
			...dashboard,
			gitStatus: {
				...dashboard.gitStatus,
				ahead: undefined,
				behind: undefined,
				noUpstream: true,
			},
		};
	};
	const initialData: DashboardData =
		props.profile === "test" || props.testData
			? (load() as DashboardData)
			: {
					state: {
						workflowId: props.workflowId,
						changeId: "",
						phase: "loading",
						stepId: "loading",
						stepLabel: "Loading",
						revision: 0,
						status: "active",
						health: { valid: false, attention: ["Loading observations…"] },
						repository: props.repo,
						worktree: props.repo,
						branch: "",
						workspace: "",
						verificationRound: 0,
						runs: [],
						panes: {},
						availableActions: [],
					},
					request: "Loading observations…",
					proposal: "Loading observations…",
					review: "Loading observations…",
					reviewHistory: [],
					agents: [],
					updated: "",
					health: { dirty: false, ahead: 0, behind: 0, branch: "" },
					gitStatus: {
						available: false,
						changedFiles: 0,
						addedFiles: 0,
						deletedFiles: 0,
						noUpstream: true,
					},
					age: "unknown",
					events: [],
					verifierTimeline: [],
					costBreakdown: [],
				};
	const [data, setData] = createSignal<DashboardData>(initialData);
	let refreshGeneration = 0;
	let refreshRunning = false;
	let dashboardLoaded = false;
	let refreshQueued = false;
	// A queued refresh must keep the force flag: a safety resync that arrives
	// while a read is in flight still has to bypass the cache when it runs.
	let refreshForceQueued = false;
	let refreshDisposed = false;
	let refreshController: AbortController | undefined;
	let refreshReviewFiles: (() => void) | undefined;
	// The last observation failure surfaced in the error modal. A persistent
	// failure must not reopen the modal on every refresh (watchDirectories
	// refreshes on each workflow file change); clearing on success re-arms it.
	let lastRefreshError: string | undefined;
	// Feed the shell's global header from the dashboard's single data source.
	createEffect(() => {
		props.onHeader?.({
			change: data().state.workflowId,
			phase: data().state.stepLabel ?? data().state.phase,
			branch: data().state.branch,
			updated: data().updated,
		});
	});
	const [busy, setBusy] = createSignal(false);
	// Dedicated review-finishing signal (in addition to the busy guard): scopes
	// the progress overlay to review finishes instead of every busy action.
	const [reviewFinishing, setReviewFinishing] = createSignal(false);
	const [reviewFinishingMessage, setReviewFinishingMessage] = createSignal("");
	let changeScroll: ScrollBoxRenderable | undefined;
	const panels = createPanelState();
	const activePanel = panels.active;
	const setActivePanel = panels.setActive;
	const selectedAgent = panels.agent;
	const setSelectedAgent = panels.setAgent;
	const selectedArtifact = panels.artifact;
	const setSelectedArtifact = panels.setArtifact;
	const artifacts = panels.artifacts;
	const setArtifacts = panels.setArtifacts;
	let artifactGeneration = 0;
	let artifactController: AbortController | undefined;
	createEffect(() => {
		const generation = ++artifactGeneration;
		artifactController?.abort();
		artifactController = new AbortController();
		if (props.profile === "test") {
			setArtifacts(openSpecArtifacts(data().state));
			return;
		}
		void loadArtifacts(data().state, artifactController.signal, {
			refresh: true,
		})
			.then((next) => {
				if (next && generation === artifactGeneration) setArtifacts(next);
			})
			.catch((error) => {
				if (
					generation === artifactGeneration &&
					!(error instanceof DOMException && error.name === "AbortError")
				)
					traceTui(
						"tui.dashboard.artifacts",
						{ surface: "dashboard", action: "artifacts" },
						"error",
					);
			});
	});
	const requiredUserAction = createMemo(() =>
		requiredUserActionFor(
			data().state.phase,
			data().state.prCreated,
			artifacts(),
			data().state.definition?.id,
			data().state.availableActions,
		),
	);
	const [userActionOpen, setUserActionOpen] = createSignal(false);
	let promptedUserActionKey: string | undefined;
	// Opt-in Markdown rendering for the OpenSpec artifact view only (D5).
	const overlays = createOverlayState({
		themeIndex: Math.max(0, themeNames.indexOf(loadThemeName())),
	});
	const verdict = overlays.verdict;
	const setVerdict = overlays.setVerdict;
	const _verdictOffset = overlays.verdictOffset;
	const setVerdictOffset = overlays.setVerdictOffset;
	const verdictReturnToFindings = overlays.verdictReturnToFindings;
	const setVerdictReturnToFindings = overlays.setVerdictReturnToFindings;
	const verdictReturnToUserAction = overlays.verdictReturnToUserAction;
	const setVerdictReturnToUserAction = overlays.setVerdictReturnToUserAction;
	const _verdictRenderMarkdown = overlays.verdictRenderMarkdown;
	const setVerdictRenderMarkdown = overlays.setVerdictRenderMarkdown;
	const findings = overlays.findings;
	const setFindings = overlays.setFindings;
	const selectedFinding = overlays.selectedFinding;
	const setSelectedFinding = overlays.setSelectedFinding;
	const repairTargets = overlays.repairTargets;
	const setRepairTargets = overlays.setRepairTargets;
	const repairSelection = overlays.repairSelection;
	const setRepairSelection = overlays.setRepairSelection;
	const completedSelection = overlays.completedSelection;
	const setCompletedSelection = overlays.setCompletedSelection;
	const actionReason = overlays.actionReason;
	const setActionReason = overlays.setActionReason;
	const userActionSelection = overlays.userActionSelection;
	const setUserActionSelection = overlays.setUserActionSelection;
	const _helpOffset = overlays.helpOffset;
	const setHelpOffset = overlays.setHelpOffset;
	const themeIndex = overlays.themeIndex;
	const setThemeIndex = overlays.setThemeIndex;
	const themeQuery = overlays.themeQuery;
	const setThemeQuery = overlays.setThemeQuery;
	const themeFiltering = overlays.themeFiltering;
	const setThemeFiltering = overlays.setThemeFiltering;
	const costSelection = overlays.costSelection;
	const setCostSelection = overlays.setCostSelection;
	const costAgent = overlays.costAgent;
	const setCostAgent = overlays.setCostAgent;
	const _costOffset = overlays.costOffset;
	const setCostOffset = overlays.setCostOffset;
	const presetSwitcherHandler = overlays.presetSwitcherHandler;
	const setPresetSwitcherHandler = overlays.setPresetSwitcherHandler;
	const presetSwitcherChoices = overlays.presetSwitcherChoices;
	const setPresetSwitcherChoices = overlays.setPresetSwitcherChoices;
	const openVerifierResult = async (role: string) => {
		setVerdictReturnToFindings(false);
		setVerdictReturnToUserAction(false);
		setVerdictRenderMarkdown(false);
		const parsed: { title: string; events: FindingEvent[] } | undefined =
			props.profile === "test"
				? undefined
				: await loadVerifierFindings(props.repo, props.workflowId, role);
		if (parsed) {
			setFindings(parsed);
			setSelectedFinding(0);
			props.keymap.setData("modal.active", "findings");
			return;
		}
		setVerdict(
			props.profile === "test"
				? {
						title: `${role} · demo`,
						content: "VERDICT: PASS\n\n## VALIDATION\nDemo verifier report.",
					}
				: await loadVerifierReport(props.repo, props.workflowId, role),
		);
		setVerdictOffset(0);
		props.keymap.setData("modal.active", "verdict");
	};
	// Authoritative dashboard modal stack (compose-unified-feature-shell task
	// 3.2/3.3): the shell-level dialogs are stack instances, so instance
	// identity, top-overlay input ownership and close ordering have one owner
	// instead of independent boolean signals.
	type DashModal =
		| "help"
		| "theme"
		| "completed-picker"
		| "repair"
		| "question"
		| "cost"
		| "review"
		| "credentials"
		| "preset-switcher";
	const modalHost = createModalHost<DashModal>();
	const modalOpen = (kind: DashModal) =>
		modalHost.stack().some((entry) => entry.kind === kind);
	const openModal = (kind: DashModal, restoreFocusTo?: string) =>
		modalHost.push({ kind, restoreFocusTo });
	const closeModal = (kind: DashModal) => {
		const instance = findModal(modalHost.state(), kind);
		if (!instance) return;
		const wasTop = modalHost.top()?.id === instance.id;
		modalHost.popById(instance.id);
		// Removing a lower instance must not steal focus from the newer top
		// overlay. Restore only the opener exposed by closing the top instance.
		if (wasTop)
			restoreFocus(modalHost.top()?.restoreFocusTo ?? instance.restoreFocusTo);
	};
	const help = () => modalOpen("help");
	const setHelp = (open: boolean) =>
		open ? openModal("help", "dashboard") : closeModal("help");
	const themePicker = () => modalOpen("theme");
	const setThemePicker = (open: boolean) =>
		open ? openModal("theme", "dashboard") : closeModal("theme");
	const completedPicker = () => modalOpen("completed-picker");
	const setCompletedPicker = (open: boolean) =>
		open
			? openModal("completed-picker", "dashboard")
			: closeModal("completed-picker");
	const repairOpen = () => modalOpen("repair");
	const setRepairOpen = (open: boolean) =>
		open ? openModal("repair", "dashboard") : closeModal("repair");
	// On-demand credential popup (askpass bridge): `pendingCredentialRequest()`
	// is set by the in-process effect runner while a git command awaits an SSH
	// passphrase. The popup keymap layer must not be gated on busy() because the
	// delivery drain runs while the dashboard is busy.
	const credentialRequest = createMemo(() => pendingCredentialRequest());
	const [credentialInput, setCredentialInput] = createSignal("");
	let credentialRequestId: number | undefined;
	let credentialModalRequestId: number | undefined;
	createEffect(() => {
		const request = credentialRequest();
		if (props.active && !props.active()) {
			credentialModalRequestId = undefined;
			const stale = findModal(modalHost.state(), "credentials");
			if (stale) modalHost.popById(stale.id);
			return;
		}
		if (request && request.id !== credentialModalRequestId) {
			modalHost.push({ kind: "credentials", restoreFocusTo: "dashboard" });
			credentialModalRequestId = request.id;
		} else if (!request) {
			const current = findModal(modalHost.state(), "credentials");
			if (current) modalHost.popById(current.id);
			credentialModalRequestId = undefined;
		}
	});
	createEffect(() => {
		const nextId = credentialRequest()?.id;
		if (nextId === credentialRequestId) return;
		credentialRequestId = nextId;
		// Never carry a passphrase from a superseded/cancelled request into the
		// next prompt, especially when its answer is rendered unmasked (SEC-002).
		setCredentialInput("");
	});
	onCleanup(() => setCredentialInput(""));
	const pendingQuestion = createMemo(() => data().state.pendingQuestions?.[0]);
	const pendingQuestionGroup = createMemo<DeveloperDialogueRecord[]>(() => {
		const question = pendingQuestion();
		if (!question) return [];
		const pending = data().state.pendingQuestions ?? [];
		return (
			question.groupId
				? pending.filter((item) => item.groupId === question.groupId)
				: [question]
		).sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
	});
	const questionOpen = () => modalOpen("question");
	const setQuestionOpen = (open: boolean) =>
		open ? openModal("question", "dashboard") : closeModal("question");
	const dialogue = createDialogueState();
	const questionTab = dialogue.tab;
	const setQuestionTab = dialogue.setTab;
	const _questionPromptOffset = dialogue.promptOffset;
	const setQuestionPromptOffset = dialogue.setPromptOffset;
	const questionSelection = dialogue.selection;
	const setQuestionSelection = dialogue.setSelection;
	const questionCustom = dialogue.custom;
	const setQuestionCustom = dialogue.setCustom;
	const questionCustomText = dialogue.customText;
	const setQuestionCustomText = dialogue.setCustomText;
	const questionDrafts = dialogue.drafts;
	const setQuestionDrafts = dialogue.setDrafts;
	const questionSubmitting = dialogue.submitting;
	const setQuestionSubmitting = dialogue.setSubmitting;
	const questionOptionDetail = dialogue.optionDetail;
	const setQuestionOptionDetail = dialogue.setOptionDetail;
	const setQuestionDetailOffset = dialogue.setDetailOffset;
	let modalBeforeCredential: string | undefined;
	let modalBeforeQuestion: string | undefined;
	let pendingQuestionId: string | undefined;
	const commitCredential = () => {
		const request = pendingCredentialRequest();
		if (!request) return;
		request.resolve(credentialInput());
		setCredentialInput("");
	};
	const cancelCredential = () => {
		const request = pendingCredentialRequest();
		if (!request) return;
		request.resolve("");
		setCredentialInput("");
	};
	const closeQuestion = () => {
		setQuestionOpen(false);
		setQuestionTab(0);
		setQuestionSelection(0);
		setQuestionCustom(false);
		setQuestionCustomText("");
		setQuestionDrafts({});
		setQuestionOptionDetail(undefined);
		setQuestionDetailOffset(0);
		props.keymap.setData("modal.active", modalBeforeQuestion ?? "none");
		modalBeforeQuestion = undefined;
	};
	const activateQuestion = (index: number) => {
		const group = pendingQuestionGroup();
		const item = group[index];
		if (!item) return;
		const draft = questionDrafts()[item.id];
		setQuestionTab(index);
		setQuestionPromptOffset(0);
		setQuestionOptionDetail(undefined);
		setQuestionDetailOffset(0);
		if (draft?.kind === "option") {
			const selected = item.options.findIndex(
				(option) => option.value === draft.value,
			);
			setQuestionSelection(selected >= 0 ? selected : 0);
			setQuestionCustom(false);
			setQuestionCustomText("");
		} else {
			setQuestionSelection(
				draft
					? item.options.length
					: item.options.length > 0
						? 0
						: item.options.length,
			);
			setQuestionCustom(Boolean(draft));
			setQuestionCustomText(draft?.value ?? "");
		}
	};
	const updateQuestionCustomText = (value: string) => {
		setQuestionCustomText(value);
		const item = pendingQuestionGroup()[questionTab()];
		if (item)
			setQuestionDrafts((drafts) => ({
				...drafts,
				[item.id]: { kind: "custom", value },
			}));
	};
	const hidePendingQuestions = (ids: string[]) => {
		const hidden = new Set(ids);
		setData((current) => ({
			...current,
			state: {
				...current.state,
				pendingQuestions: current.state.pendingQuestions?.filter(
					(item) => !hidden.has(item.id),
				),
			},
		}));
	};
	const submitQuestion = async (answer: {
		kind: "option" | "custom" | "cancel";
		value?: string;
	}) => {
		const question = pendingQuestion();
		if (!question || questionSubmitting()) return;
		if (answer.kind === "custom" && !answer.value?.trim()) {
			notify("Custom response cannot be empty", "warning");
			return;
		}
		const group = pendingQuestionGroup();
		if (answer.kind === "cancel" && group.length > 1 && question.groupId) {
			setQuestionSubmitting(true);
			try {
				if (props.profile !== "test")
					await answerQuestion(
						props.repo,
						props.workflowId,
						data().state.revision,
						question.id,
						{
							groupId: question.groupId,
							kind: "cancel",
						},
					);
				hidePendingQuestions(group.map((item) => item.id));
				closeQuestion();
				refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				traceTui(
					"tui.dashboard.question",
					{ surface: "dashboard", action: "question-cancel" },
					"error",
				);
				if (/stale|revision|pending|expired/i.test(message)) refresh();
			} finally {
				setQuestionSubmitting(false);
			}
			return;
		}
		if (answer.kind !== "cancel" && group.length > 1) {
			const responseKind = answer.kind;
			const item = group[questionTab()];
			if (!item) return;
			setQuestionDrafts((drafts) => ({
				...drafts,
				[item.id]: {
					kind: responseKind,
					value: answer.value ?? "",
				},
			}));
			if (questionTab() < group.length - 1) {
				activateQuestion(questionTab() + 1);
				return;
			}
			const drafts = questionDrafts();
			const responses = group.map((item, index) =>
				index === questionTab()
					? {
							questionId: item.id,
							kind: answer.kind,
							value: answer.value ?? "",
						}
					: { questionId: item.id, ...(drafts[item.id] ?? {}) },
			);
			if (
				responses.some((response) => !response.kind || !response.value.trim())
			) {
				notify("Answer every question before submitting", "warning");
				return;
			}
			answer = { kind: "custom", value: "" };
			setQuestionSubmitting(true);
			try {
				if (props.profile !== "test")
					await answerQuestion(
						props.repo,
						props.workflowId,
						data().state.revision,
						question.id,
						{
							groupId: question.groupId ?? "",
							responses: responses.map((response) => ({
								questionId: response.questionId,
								kind: response.kind as "option" | "custom",
								value: response.value,
							})),
						},
					);
				hidePendingQuestions(group.map((item) => item.id));
				closeQuestion();
				refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				traceTui(
					"tui.dashboard.question",
					{ surface: "dashboard", action: "question-group" },
					"error",
				);
				if (/stale|revision|pending|expired/i.test(message)) refresh();
			} finally {
				setQuestionSubmitting(false);
			}
			return;
		}
		setQuestionSubmitting(true);
		try {
			if (props.profile !== "test")
				await answerQuestion(
					props.repo,
					props.workflowId,
					data().state.revision,
					question.id,
					answer,
				);
			hidePendingQuestions([question.id]);
			closeQuestion();
			refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			traceTui(
				"tui.dashboard.question",
				{ surface: "dashboard", action: "question" },
				"error",
			);
			if (/stale|revision|pending|expired/i.test(message)) refresh();
		} finally {
			setQuestionSubmitting(false);
		}
	};
	const costOpen = () => modalOpen("cost");
	const setCostOpen = (open: boolean) =>
		open ? openModal("cost", "dashboard") : closeModal("cost");
	const presetSwitcherOpen = () => modalOpen("preset-switcher");
	const closePresetSwitcher = () => {
		closeModal("preset-switcher");
		props.keymap.setData("modal.active", "none");
	};
	const openPresetSwitcher = () => {
		const current = data().state.selectedPreset;
		let configured: string[] = [];
		try {
			configured = listPresetNames(data().state.repository);
		} catch {
			/* The picker still offers configuration defaults when config is unavailable. */
		}
		const names = new Set(configured);
		if (current) names.add(current);
		setPresetSwitcherChoices([
			{ label: PRESET_CONFIG_DEFAULTS },
			...[...names].map((name) => ({ label: name, value: name })),
		]);
		openModal("preset-switcher", "dashboard");
		props.keymap.setData("modal.active", "preset-switcher");
	};
	const selectPreset = async (preset: string | undefined) => {
		closePresetSwitcher();
		setBusy(true);
		try {
			if (props.profile === "test") {
				setData((current) => ({
					...current,
					state: {
						...current.state,
						...(preset === undefined
							? { selectedPreset: undefined }
							: { selectedPreset: preset }),
					},
				}));
			} else
				await switchWorkflowPreset(
					props.repo,
					props.workflowId,
					data().state.revision,
					preset ?? PRESET_CONFIG_DEFAULTS,
				);
			notify(
				`Switched agent preset to ${preset ?? PRESET_CONFIG_DEFAULTS}; retriggering active agents`,
				"success",
			);
			if (props.profile !== "test") refresh();
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
			traceTui(
				"tui.dashboard.action",
				{ surface: "dashboard", action: "switch-preset" },
				"error",
			);
			refresh();
		} finally {
			setBusy(false);
		}
	};
	const gate = createMemo(() => {
		if (props.profile === "test")
			return {
				prompt: "Press Enter to advance demo phase",
				action: "next demo phase",
			};
		switch (requiredUserAction()?.key) {
			case "developer-review":
				return {
					prompt: "Press Enter to review changed files",
					action: "review",
				};
			case "plan-review":
				return {
					prompt: "Press Enter to review plan artifacts",
					action: "plan-review",
				};
			case "wiki-review":
				return {
					prompt: "Press Enter to review wiki changes",
					action: "wiki-review",
				};
		}
		const actions = data().state.availableActions ?? [];
		if (actions.length > 1 || actions[0]?.confirmation !== "none")
			return actions.length
				? {
						prompt: "Press Enter to choose workflow action",
						action: "completed-actions",
					}
				: undefined;
		const action = actions[0];
		if (action)
			return { prompt: `Press Enter: ${action.label}`, action: action.id };
		const workerStatus = data().agents.find(
			(agent) => agent.role === "worker",
		)?.status;
		if (
			data().state.phase === "fix" &&
			(workerStatus === "pending" || workerStatus === "working")
		)
			return undefined;
		return approvalFor(data().state.phase);
	});
	const completedActions = () =>
		data().state.availableActions?.map((action) => ({
			label: action.label,
			command: action.id,
			confirmation: action.confirmation,
		})) ?? [];
	const completedInputHint = () => {
		const action = completedActions()[completedSelection()];
		if (action?.command === "research-follow-up")
			return "type follow-up question";
		return action?.confirmation === "reason" ? "type reason" : "Enter to run";
	};
	const actionSignature = createMemo(() =>
		completedActions()
			.map((action) => `${action.command}:${action.confirmation}`)
			.join("\0"),
	);
	let previousActionSignature: string | undefined;
	createEffect(() => {
		const next = actionSignature();
		if (
			previousActionSignature !== undefined &&
			next !== previousActionSignature
		) {
			setCompletedSelection(0);
			setActionReason("");
		}
		previousActionSignature = next;
	});
	const openRequiredUserAction = () => {
		const action = requiredUserAction();
		if (
			!action ||
			(promptedUserActionKey === action.key && activePanel() !== 0)
		)
			return false;
		if (action.key === "developer-review") {
			// The developer review user action IS the changed-files popup: no
			// intermediate item selection, open the review directly.
			promptedUserActionKey = action.key;
			openDeveloperReview();
			return true;
		}
		if (action.key === "plan-review" || action.key === "wiki-review") {
			// Review gates open their popup directly; no empty generic selection list.
			promptedUserActionKey = action.key;
			openPlanReview();
			return true;
		}
		setUserActionSelection(0);
		setUserActionOpen(true);
		props.keymap.setData("modal.active", "user-action");
		return true;
	};
	// ponytail: legacy action ids from the pre-engine dashboard; new engine dispatches by id.
	const workflowActionId = (value: string) =>
		({ apply: "approve-plan" })[value] ?? value;
	const runRequiredUserAction = async (item: RequiredUserActionItem) => {
		if (item.kind === "dismiss") {
			setUserActionOpen(false);
			props.keymap.setData("modal.active", "none");
			return;
		}
		if (item.kind === "review") {
			setUserActionOpen(false);
			props.keymap.setData("modal.active", "none");
			openPlanReview();
			return;
		}
		if (item.kind === "artifact") {
			setUserActionOpen(false);
			setVerdictReturnToFindings(false);
			setVerdictReturnToUserAction(true);
			setVerdictRenderMarkdown(true);
			let content: string;
			try {
				// With a gateway the read goes through the data layer; a
				// transport-less run (demo/test) reads the checkout directly.
				content = gatewayOrUndefined()
					? ((await loadArtifact(
							data().state,
							item.value,
							reviewDiffSignal(),
						)) ?? "")
					: openSpecArtifact(data().state, item.value);
			} catch (error) {
				content = `Could not open ${item.value}: ${error instanceof Error ? error.message : String(error)}`;
			}
			setVerdict({ title: `OpenSpec · ${item.value}`, content });
			setVerdictOffset(0);
			props.keymap.setData("modal.active", "verdict");
			return;
		}
		setUserActionOpen(false);
		props.keymap.setData("modal.active", "none");
		setBusy(true);
		try {
			if (props.profile === "test") {
				setDemoIndex((index) => (index + 1) % demoPhases.length);
			} else
				await runWorkflow(
					workflowActionId(item.value),
					props.repo,
					props.workflowId,
					data().state.revision,
				);
			traceTui("tui.dashboard.action", {
				surface: "dashboard",
				action: workflowActionId(item.value),
			});
			refresh();
		} catch {
			traceTui(
				"tui.dashboard.action",
				{ surface: "dashboard", action: workflowActionId(item.value) },
				"error",
			);
		} finally {
			setBusy(false);
		}
	};
	const refresh = (force = false) => {
		if (refreshDisposed) return;
		refreshReviewFiles?.();
		if (props.profile === "test") {
			setData(load());
			traceTui("tui.dashboard.refresh", {
				surface: "dashboard",
				action: "refresh",
			});
			return;
		}
		if (refreshRunning) {
			refreshQueued = true;
			refreshForceQueued = refreshForceQueued || force;
			return;
		}
		refreshQueued = false;
		refreshForceQueued = false;
		// Bump the generation only when a read actually starts. Bumping for a
		// merely queued refresh would discard the in-flight read's result, and the
		// periodic safety resync would then starve the view on a slow backend.
		const generation = ++refreshGeneration;
		refreshRunning = true;
		refreshController?.abort();
		refreshController = new AbortController();
		void loadDashboard(props.repo, props.workflowId, refreshController.signal, {
			refresh: force,
		})
			.then((next) => {
				if (next && !refreshDisposed && generation === refreshGeneration) {
					dashboardLoaded = true;
					lastRefreshError = undefined;
					setData(next);
					traceTui("tui.dashboard.refresh", {
						surface: "dashboard",
						action: "refresh",
					});
					setSelectedAgent((index) =>
						Math.min(index, Math.max(0, next.agents.length - 1)),
					);
				}
			})
			.catch((error) => {
				if (!refreshDisposed && generation === refreshGeneration) {
					const message =
						error instanceof Error ? error.message : String(error);
					traceTui(
						"tui.dashboard.refresh",
						{ surface: "dashboard", action: "refresh" },
						"error",
					);
					if (message !== lastRefreshError) {
						lastRefreshError = message;
						// A background safety resync must not pop a blocking modal every
						// few seconds on a flapping backend; a toast is enough for a poll
						// the user did not trigger. Explicit refreshes keep the modal.
						if (force) notify(`Observation failed: ${message}`, "error");
						else showErrorModal("Observation failed", message);
					}
				}
			})
			.finally(() => {
				refreshRunning = false;
				if (refreshQueued && !refreshDisposed) {
					refreshQueued = false;
					const queuedForce = refreshForceQueued;
					refreshForceQueued = false;
					refresh(queuedForce);
				}
			});
	};

	// Review feature: plan/developer/wiki review state, drafts, and submission
	// live in `review.ts` (cohesive dashboard-local ownership); the root wires
	// its signals into keymap layers and rendering below.
	const reviewFeature = createReviewFeature({
		repo: props.repo,
		workflowId: props.workflowId,
		profile: props.profile,
		setModalActive: (modal) => props.keymap.setData("modal.active", modal),
		trace: traceTui,
		setBusy,
		busy,
		setReviewFinishing,
		setReviewFinishingMessage,
		refresh,
		data,
		requiredUserAction,
		artifacts,
		setArtifacts,
		dimensions,
		setDemoIndex,
		demoPhases,
	});
	refreshReviewFiles = () => void reviewFeature.refreshReviewFiles();
	const {
		setReviewOpen,
		setReviewComments,
		setReviewCommentMode,
		setReviewCommentText,
		setReviewVisualMode,
		planRejectionReasons,
		planRejectionOpen,
		setPlanRejectionOpen,
		planRejectionSelection,
		setPlanRejectionSelection,
		openDeveloperReview,
		openPlanReview,
		rejectPlan,
		handleReviewKey,
		reviewDiffSignal,
		reviewVisibleChanges,
		reviewSourceRange,
		reviewCommentText,
		reviewSearchMode,
		reviewCommentMode,
		reviewChangeIndex,
		reviewKind,
		reviewOpen,
		dispose: reviewFeatureDispose,
	} = reviewFeature;
	createEffect(() => {
		if (!props.active || props.active()) return;
		// A hidden dashboard cannot leave a visible-but-unfocusable dialog behind
		// when the shell switches features. Pending backend prompts remain pending
		// and are re-presented when Workflows becomes active again.
		const currentModalState = modalHost.state();
		if (currentModalState.stack.length > 0)
			modalHost.set({ stack: [], nextSeq: currentModalState.nextSeq });
		promptedUserActionKey = undefined;
		setCredentialInput("");
		setQuestionOpen(false);
		setUserActionOpen(false);
		setFindings(undefined);
		setVerdict(undefined);
		setCostOpen(false);
		setPlanRejectionOpen(false);
		setReviewOpen(false);
		setReviewCommentMode(false);
		props.keymap.setData("modal.active", "none");
	});
	let reviewModalOpen = false;
	createEffect(() => {
		const open = reviewOpen();
		if (props.active && !props.active()) {
			if (reviewModalOpen) {
				const current = findModal(modalHost.state(), "review");
				if (current) modalHost.popById(current.id);
				reviewModalOpen = false;
			}
			return;
		}
		if (open && !reviewModalOpen) {
			modalHost.push({ kind: "review", restoreFocusTo: "dashboard" });
			reviewModalOpen = true;
		} else if (!open && reviewModalOpen) {
			const current = findModal(modalHost.state(), "review");
			if (current) modalHost.popById(current.id);
			reviewModalOpen = false;
		}
	});
	const filteredThemes = () =>
		themeNames.filter((name) => name.includes(themeQuery().toLowerCase()));
	const keybindCatalog = createMemo(() =>
		dashboardDetailKeybindCatalog({
			artifactsVisible: artifacts().length > 0,
		}),
	);
	// The shell footer and `?` help read the active surface catalog from the
	// shared store; the detail view publishes the panel-scoped catalog here.
	createEffect(() =>
		setActiveKeybindCatalog(keybindCatalog(), panelContext(activePanel())),
	);
	const helpMaxOffset = () =>
		Math.max(
			0,
			keybindCatalog().reduce(
				(count, section) => count + section.keybinds.length + 1,
				0,
			) - Math.max(5, Math.floor(dimensions().height * 0.78) - 5),
		);
	const verdictLines = createMemo(() =>
		Math.max(4, Math.floor(dimensions().height * 0.75) - 5),
	);
	const closeVerdict = () => {
		const restoreFindings = verdictReturnToFindings();
		const restoreUserAction = verdictReturnToUserAction();
		setVerdict(undefined);
		setVerdictReturnToFindings(false);
		setVerdictReturnToUserAction(false);
		setVerdictRenderMarkdown(false);
		if (restoreFindings) props.keymap.setData("modal.active", "findings");
		else if (restoreUserAction) {
			setUserActionOpen(true);
			props.keymap.setData("modal.active", "user-action");
		} else props.keymap.setData("modal.active", "none");
	};

	// A stable workspace key: the memo only notifies when the id actually
	// changes, so the event subscription is not torn down on every refresh.
	const workflowWorkspace = createMemo(() => data().state.workspace);

	// Refresh is driven by the server event stream when a transport is
	// configured: the server owns the Herdr subscription and the execution
	// coordinator listeners and publishes `workflow.updated`. A transport-less
	// run (demo/tests) falls back to local file watches + the Herdr socket.
	// The effect depends only on the active flag and the workspace key: reading
	// `data()` untracked keeps the subscription and its safety timer alive
	// across refreshes instead of tearing them down on every `setData` (which
	// would open an event-loss window).
	createEffect(() => {
		if (props.profile === "test") return;
		if (props.active && !props.active()) return;
		const state = untrack(() => data().state);
		const workspace = workflowWorkspace();
		const debounced = debounce(() => {
			refresh();
			reconcileSidebarPresentation();
			// Present only when the notifier owner lives in this process (the home
			// shell); in the standalone dash process this is a no-op and the
			// observer's bounded fallback interval drives reconciliation.
			reconcileWorkflowNotifications();
		}, 200);
		if (serverOwnsExecutionEvents()) {
			// Attached: the server owns execution and Herdr, and publishes
			// `workflow.updated`; the data layer applies each envelope to the cache.
			const dispose = subscribeDataEvents({
				onEvent: (event) => {
					if (event.domain !== "workflow") return;
					if (event.resource && event.resource !== props.repo) return;
					if (
						!event.resource &&
						event.payload &&
						typeof event.payload === "object" &&
						!herdrEventMatchesWorkspace(
							event.payload as Record<string, unknown>,
							workspace,
						)
					)
						return;
					debounced.trigger();
				},
				onResync: () => refresh(true),
			});
			// Safety resync: even with push events, a dropped/missed update must not
			// leave the view stale forever. A forced read bypasses the cache.
			const disposeResync = startSafetyResync(refresh);
			onCleanup(() => {
				debounced.cancel();
				dispose();
				disposeResync();
			});
			return;
		}
		const dirs =
			state.definition?.id === "research"
				? [join(wikiWorkflowDataRoot(), props.workflowId)]
				: [
						join(props.repo, ".herdr-workflow", props.workflowId),
						join(state.worktree, ".herdr-workflow", props.workflowId),
					];
		const disposeWatch = watchDirectories(dirs, refresh);
		// When a transport is configured the server owns the Herdr socket
		// subscription and publishes `workflow.updated`; a transport-less run
		// (demo/tests) still watches the socket in-process.
		const disposeHerdr = serverOwnsExecutionEvents()
			? () => {}
			: subscribeHerdrEvents((event) => {
					if (herdrEventMatchesWorkspace(event.data, workspace))
						debounced.trigger();
				});
		const disposeResync = startSafetyResync(refresh);
		onCleanup(() => {
			debounced.cancel();
			disposeWatch();
			disposeHerdr();
			disposeResync();
		});
	});

	onMount(() => {
		// When a transport is configured the server owns the execution-settled
		// listeners and publishes `workflow.updated`; only a transport-less run
		// (demo/tests) listens to the in-process coordinator directly.
		const localSettle = !serverOwnsExecutionEvents();
		const disposeExecutionError =
			props.profile === "test" || !localSettle
				? undefined
				: onWorkflowExecutionError(props.repo, (workflowId) => {
						if (props.active && !props.active()) return;
						if (workflowId === props.workflowId) refresh();
					});
		// A dashboard-initiated drain can change state without a Herdr event
		// (developer transitions), so refresh when the coordinator settles.
		const disposeExecutionSettled =
			props.profile === "test" || !localSettle
				? undefined
				: onWorkflowExecutionSettled(props.repo, (workflowId) => {
						if (props.active && !props.active()) return;
						if (workflowId === props.workflowId) refresh();
					});
		const disposeExecutionProgress =
			props.profile === "test" || !localSettle
				? undefined
				: onWorkflowExecutionProgress(props.repo, () => {
						if (props.active && !props.active()) return;
						refresh();
					});
		if (props.profile !== "test") {
			const seedController = new AbortController();
			void loadDashboardSeed(
				props.repo,
				props.workflowId,
				seedController.signal,
			)
				.then((seed) => {
					if (seed && !refreshDisposed && !dashboardLoaded) setData(seed);
				})
				.catch(() => undefined);
			onCleanup(() => seedController.abort());
			void requestExecution(props.repo, props.workflowId).catch((error) => {
				// Initial execution is best-effort; refresh owns visible diagnostics.
				traceTui(
					"tui.dashboard.execute",
					{
						surface: "dashboard",
						action: "execute",
						detail: error instanceof Error ? error.message : String(error),
					},
					"error",
				);
			});
		}
		// The sidebar presentation, execution coordinator and shared application
		// runtime are root-owned (task 1.2/1.3): hiding this feature view must
		// not release them, so the shell owns their registration and disposal.
		// Closing a dashboard overlay returns key ownership to the panel by
		// clearing the parked modal state (task 3.1 focus restoration).
		const disposeFocusRestorer = registerFocusRestorer("dashboard", () => {
			props.keymap.setData("modal.active", "none");
		});
		refresh();
		onCleanup(() => {
			refreshDisposed = true;
			refreshController?.abort();
			disposeExecutionError?.();
			disposeExecutionProgress?.();
			disposeExecutionSettled?.();
			artifactGeneration++;
			artifactController?.abort();
			reviewFeatureDispose();
			refreshReviewFiles = undefined;
			disposeFocusRestorer();
		});
	});

	// The last surface modal that owned the keys before the modal's own `?` help
	// opened, so Esc returns to it instead of dropping to the dashboard.
	let modalHelpReturnModal: string | undefined;
	/**
	 * Route a key to the open modal's `?` help overlay. While it is open the
	 * overlay owns j/k/Esc; otherwise `?` opens it when the mounted modal
	 * published a help catalog. Returns true when the key was consumed.
	 */
	const routeModalHelp = (key: string): boolean => {
		if (modalHelpOpen()) {
			const handled = handleModalHelpKey(key);
			if (handled && !modalHelpOpen()) {
				props.keymap.setData("modal.active", modalHelpReturnModal ?? "none");
				modalHelpReturnModal = undefined;
			}
			return handled;
		}
		if (key !== "?") return false;
		if (!handleModalHelpKey(key)) return false;
		modalHelpReturnModal = String(
			props.keymap.getData?.("modal.active") ?? "none",
		);
		props.keymap.setData("modal.active", "help");
		return true;
	};
	const handleKey = createDashboardKeyHandler({
		keymap: props.keymap,
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
		setData,
		dimensions,
		notify,
		trace: traceTui,
		routeModalHelp,
		props,
		refresh,
		scrollChangePanel: (lines) => changeScroll?.scrollBy(lines),
		artifactSignal: () => artifactController?.signal,
		userActionPrompt: () => promptedUserActionKey,
		setUserActionPrompt: (key) => {
			promptedUserActionKey = key;
		},
		setBusy,
		setDemoIndex,
		demoPhases,
		themeIndex,
		gate,
		help,
		setHelp,
		applyTheme,
		themeNames,
		loadDashboard,
		focusReturnWorkspace,
		focusAgentAsync,
		openFindingInEditor: async (path, line) =>
			openFindingInEditorAsync(
				data().state,
				{ path, line },
				artifactController?.signal,
			),
		openDeveloperReview,
		openPlanReview,
		openVerifierResult,
		openRequiredUserAction,
		openPresetSwitcher,
		openCost: () => setCostOpen(true),
		openReview: (kind) =>
			kind === "plan" ? openPlanReview() : openDeveloperReview(),
		openUserAction: () => setUserActionOpen(true),
		readArtifact: async (state, artifact) =>
			gatewayOrUndefined()
				? ((await loadArtifact(state, artifact, artifactController?.signal)) ??
					"")
				: openSpecArtifact(state, artifact),
		openSpecArtifact,
		openSpecArtifacts,
		openArtifact: async (artifact) => {
			const read = await loadArtifact(
				data().state,
				artifact,
				artifactController?.signal,
			);
			setVerdict({ title: `OpenSpec · ${artifact}`, content: read ?? "" });
		},
		switchWorkflowPreset,
		runWorkflow,
		applyRepair,
		answerQuestion,
		previewRepair,
		requestExecution,
		verdictLines,
		requiredUserAction,
		completedActions,
		completedInputHint,
		planRejectionReasons,
		setThemePicker,
		setRepairOpen,
		setRepairTargets,
		setRepairSelection,
		setCompletedPicker,
		setCompletedSelection,
		setActionReason,
		setCostOpen,
		setCostSelection,
		setCostAgent,
		setCostOffset,
		setHelpOffset,
		setVerdict,
		setVerdictOffset,
		setVerdictRenderMarkdown,
		setVerdictReturnToFindings,
		setVerdictReturnToUserAction,
		setFindings,
		setSelectedFinding,
		findings,
		verdict,
		setPresetSwitcherHandler,
		setPresetSwitcherChoices,
		setReviewOpen,
		reviewFeature,
		setQuestionOpen,
		setUserActionOpen,
		setArtifacts,
	});
	onMount(() => {
		props.keymap.setData("app.view", "detail");
		props.keymap.setData("modal.active", activeErrorModal() ? "error" : "none");
		const disposeTheme = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "theme",
			priority: 1100,
			activeModal: "theme",
			commands: [
				{
					name: "theme.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						// `?` always opens the picker's own help; theme names never need a
						// literal question mark in the filter.
						if (routeModalHelp(key)) return true;
						const items = filteredThemes();
						if (key === "escape") {
							if (themeFiltering()) {
								setThemeFiltering(false);
								setThemeQuery("");
								setThemeIndex(0);
							} else {
								setThemePicker(false);
								props.keymap.setData("modal.active", "none");
							}
						} else if (key === "/") {
							setThemeFiltering(true);
							setThemeQuery("");
							setThemeIndex(0);
						} else if (themeFiltering() && key === "backspace") {
							setThemeQuery((query) => query.slice(0, -1));
							setThemeIndex(0);
						} else if (themeFiltering() && key.length === 1) {
							setThemeQuery((query) => query + key);
							setThemeIndex(0);
						} else if (key === "j" || key === "down") {
							const next = Math.min(items.length - 1, themeIndex() + 1);
							setThemeIndex(next);
							applyTheme(items[next]);
						} else if (key === "k" || key === "up") {
							const next = Math.max(0, themeIndex() - 1);
							setThemeIndex(next);
							applyTheme(items[next]);
						} else if (key === "enter" || key === "return") {
							if (themeFiltering()) setThemeFiltering(false);
							else {
								const selected = items[themeIndex()];
								if (selected) {
									saveThemeName(selected);
									setThemePicker(false);
									props.keymap.setData("modal.active", "none");
								}
							}
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"/",
				"backspace",
				..."abcdefghijklmnopqrstuvwxyz".split(""),
				"j",
				"k",
				"up",
				"down",
				"?",
			].map((key) => ({ key, cmd: "theme.handle" })),
		});
		const disposeQuestion = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "developer-question",
			priority: 1400,
			activeModal: "developer-question",
			commands: [
				{
					name: "developer-question.handle",
					run: ({ event }) => {
						const question = pendingQuestion();
						if (!question || questionSubmitting()) return true;
						const key = event.name.toLowerCase();
						// The option-detail markdown modal owns the keyboard while open:
						// `d`/Esc close it, scroll keys page its scrollbox, and nothing
						// reaches the question underneath.
						if (questionOptionDetail()) {
							if (key === "escape" || key === "d")
								setQuestionOptionDetail(undefined);
							else if (key === "pageup" || key === "k" || key === "up")
								setQuestionDetailOffset((offset) => Math.max(0, offset - 3));
							else if (key === "pagedown" || key === "j" || key === "down")
								setQuestionDetailOffset((offset) => offset + 3);
							return true;
						}
						// `?` opens the dialog's own help unless the custom textarea owns
						// the keyboard (there it stays a literal question mark).
						if (!questionCustom() && routeModalHelp(key)) return true;
						const group = pendingQuestionGroup();
						const current = group[questionTab()] ?? question;
						const customIndex = current.options.length;
						const altEnter =
							(key === "enter" || key === "return") &&
							(event.meta || event.option);
						if (key === "escape") {
							void submitQuestion(
								question.groupId && group.length > 1
									? { kind: "cancel", value: question.groupId }
									: { kind: "cancel" },
							);
						} else if (
							(key === "pageup" || key === "pagedown") &&
							(!questionCustom() || event.ctrl)
						) {
							setQuestionPromptOffset((offset) =>
								Math.max(0, offset + (key === "pageup" ? -3 : 3)),
							);
						} else if (key === "tab") {
							const direction = event.shift ? -1 : 1;
							activateQuestion(
								(questionTab() + direction + group.length) % group.length,
							);
						} else if (questionCustom()) {
							// The focused textarea owns plain Enter, insertion, deletion,
							// cursor movement, and paste. Alt+Enter is the explicit advance.
							if (altEnter)
								void submitQuestion({
									kind: "custom",
									value: questionCustomText(),
								});
							else return false;
						} else if (key === "d" && !event.meta && !event.ctrl) {
							const option = current.options[questionSelection()];
							if (option) {
								const resolved = resolveDeveloperQuestionOption(option);
								if (resolved.description?.trim()) {
									setQuestionDetailOffset(0);
									setQuestionOptionDetail({
										title: resolved.label,
										content: resolved.description,
									});
								}
							}
						} else if (key === "j" || key === "down")
							setQuestionSelection((index) => Math.min(customIndex, index + 1));
						else if (key === "k" || key === "up")
							setQuestionSelection((index) => Math.max(0, index - 1));
						else if (key === "enter" || key === "return") {
							if (questionSelection() === customIndex) {
								setQuestionCustom(true);
								setQuestionCustomText(
									questionDrafts()[current.id]?.value ?? "",
								);
							} else {
								const option = current.options[questionSelection()];
								if (option)
									void submitQuestion({
										kind: "option",
										value: resolveDeveloperQuestionOption(option).value,
									});
							}
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"meta+enter",
				"meta+return",
				"ctrl+pageup",
				"ctrl+pagedown",
				"alt+enter",
				"alt+return",
				"j",
				"k",
				"up",
				"down",
				"tab",
				"shift+tab",
				"pageup",
				"pagedown",
				"backspace",
				"delete",
				"space",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\@#*+=[]{}~`'\"".split(
					"",
				),
			].map((key) => ({
				key,
				cmd: "developer-question.handle",
				preventDefault: false,
			})),
		});
		const disposeCredentials = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "credentials",
			priority: 1300,
			activeModal: "credentials",
			commands: [
				{
					name: "credentials.handle",
					run: ({ event }) => {
						// Intentionally NOT gated on busy(): the delivery drain that
						// requests the passphrase runs while the dashboard is busy.
						const key = event.name.toLowerCase();
						if (key === "escape") {
							cancelCredential();
							traceTui("tui.dashboard.action", {
								surface: "dashboard",
								action: "credential-cancel",
							});
							return true;
						}
						if (key === "enter" || key === "return") {
							commitCredential();
							return true;
						}
						if (key === "backspace") {
							setCredentialInput((value) => value.slice(0, -1));
							return true;
						}
						if (key === "space" || event.name === " ") {
							setCredentialInput((value) => `${value} `.slice(0, 1024));
							return true;
						}
						if (
							event.sequence &&
							event.sequence.length === 1 &&
							!event.ctrl &&
							!event.meta
						) {
							setCredentialInput((value) =>
								`${value}${event.shift ? event.sequence.toUpperCase() : event.sequence}`.slice(
									0,
									1024,
								),
							);
							return true;
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"backspace",
				"space",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\@#*+=[]{}~`'\"".split(
					"",
				),
			].map((key) => ({ key, cmd: "credentials.handle" })),
		});
		const disposeRepair = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "repair",
			priority: 1000,
			activeModal: "repair",
			commands: [
				{
					name: "repair.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						if (key === "escape") {
							setRepairOpen(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down") {
							setRepairSelection((index) =>
								Math.min(repairTargets().length - 1, index + 1),
							);
						} else if (key === "k" || key === "up") {
							setRepairSelection((index) => Math.max(0, index - 1));
						} else if (key === "enter" || key === "return") {
							const target = repairTargets()[repairSelection()];
							if (!target) return true;
							void applyRepair(
								props.repo,
								props.workflowId,
								data().state.revision,
								target.targetStep,
								"",
							)
								.then(() => {
									setRepairOpen(false);
									props.keymap.setData("modal.active", "none");
									refresh();
									notify(
										`Repaired to ${target.label}: phase retriggered`,
										"success",
									);
									traceTui("tui.dashboard.action", {
										surface: "dashboard",
										action: "repair-apply",
									});
								})
								.catch((error) => {
									notify(
										error instanceof Error ? error.message : String(error),
										"error",
									);
									traceTui(
										"tui.dashboard.action",
										{ surface: "dashboard", action: "repair-apply" },
										"error",
									);
									refresh();
								});
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({ key, cmd: "repair.handle" }),
			),
		});
		const disposeCompletedPicker = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "completed-picker",
			priority: 1000,
			activeModal: "completed-picker",
			commands: [
				{
					name: "completed-picker.handle",
					run: ({ event }) => {
						if (busy()) return true;
						const key = event.name.toLowerCase();
						if (key === "escape") {
							setCompletedPicker(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down") {
							setCompletedSelection((index) =>
								Math.min(Math.max(0, completedActions().length - 1), index + 1),
							);
						} else if (key === "k" || key === "up") {
							setCompletedSelection((index) => Math.max(0, index - 1));
						} else if (
							key === "backspace" &&
							completedActions()[completedSelection()]?.confirmation ===
								"reason"
						) {
							setActionReason((value) => value.slice(0, -1));
						} else if (
							key === "space" &&
							completedActions()[completedSelection()]?.confirmation ===
								"reason"
						) {
							setActionReason((value) => `${value} `.slice(0, 2048));
						} else if (
							key.length === 1 &&
							!event.ctrl &&
							!event.meta &&
							completedActions()[completedSelection()]?.confirmation ===
								"reason"
						) {
							setActionReason((value) => `${value}${key}`.slice(0, 2048));
						} else if (key === "enter" || key === "return") {
							const action = completedActions()[completedSelection()];
							if (!action) return true;
							if (action.confirmation === "reason" && !actionReason().trim()) {
								notify("Action reason is required", "warning");
								return true;
							}
							setCompletedPicker(false);
							props.keymap.setData("modal.active", "none");
							setBusy(true);
							void runWorkflow(
								action.command,
								props.repo,
								props.workflowId,
								data().state.revision,
								action.confirmation === "reason"
									? JSON.stringify(
											action.command === "research-follow-up"
												? { message: actionReason().trim() }
												: { reason: actionReason().trim() },
										)
									: undefined,
							)
								.then(() =>
									traceTui("tui.dashboard.action", {
										surface: "dashboard",
										action: action.command,
									}),
								)
								.catch(() =>
									traceTui(
										"tui.dashboard.action",
										{ surface: "dashboard", action: action.command },
										"error",
									),
								)
								.finally(() => {
									setBusy(false);
									refresh();
								});
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"j",
				"k",
				"up",
				"down",
				"backspace",
				"space",
				..."abcdefghijklmnopqrstuvwxyz0123456789-_.".split(""),
			].map((key) => ({ key, cmd: "completed-picker.handle" })),
		});
		const disposeUserAction = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "user-action",
			priority: 1150,
			activeModal: "user-action",
			commands: [
				{
					name: "user-action.handle",
					run: ({ event }) => {
						if (busy()) return true;
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						const items = requiredUserAction()?.items ?? [];
						if (key === "escape") {
							setUserActionOpen(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setUserActionSelection((index) =>
								Math.min(Math.max(0, items.length - 1), index + 1),
							);
						else if (key === "k" || key === "up")
							setUserActionSelection((index) => Math.max(0, index - 1));
						else if (key === "enter" || key === "return") {
							const item = items[userActionSelection()];
							if (item) void runRequiredUserAction(item);
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({ key, cmd: "user-action.handle" }),
			),
		});
		const disposeCost = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "cost",
			priority: 1000,
			activeModal: "cost",
			commands: [
				{
					name: "cost.handle",
					run: ({ event }) => {
						if (busy()) return true;
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						if (key === "escape") {
							if (costAgent()) {
								setCostAgent(null);
								setCostOffset(0);
							} else {
								setCostOpen(false);
								props.keymap.setData("modal.active", "none");
							}
						} else if (key === "j" || key === "down") {
							if (costAgent()) setCostOffset((value) => value + 1);
							else
								setCostSelection((index) =>
									Math.min(data().costBreakdown.length - 1, index + 1),
								);
						} else if (key === "k" || key === "up") {
							if (costAgent()) setCostOffset((value) => Math.max(0, value - 1));
							else setCostSelection((index) => Math.max(0, index - 1));
						} else if (key === "enter" || key === "return") {
							const row = data().costBreakdown[costSelection()];
							if (!row) return true;
							setCostAgent(row.role);
							setCostOffset(0);
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({ key, cmd: "cost.handle" }),
			),
		});
		const disposePresetSwitcher = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "preset-switcher",
			priority: 1000,
			activeModal: "preset-switcher",
			commands: [
				{
					name: "preset-switcher.handle",
					run: ({ event }) => {
						if (routeModalHelp(event.name.toLowerCase())) return true;
						return presetSwitcherHandler()?.(event) ?? true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({
					key,
					cmd: "preset-switcher.handle",
					preventDefault: false,
				}),
			),
		});
		const disposeHelp = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "help",
			priority: 1000,
			activeModal: "help",
			commands: [
				{
					name: "help.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						// The modal's own `?` help rides the same layer; route it before
						// the dashboard help so Esc returns to the open dialog.
						if (modalHelpOpen()) return routeModalHelp(key);
						if (key === "escape") {
							setHelp(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setHelpOffset((value) => Math.min(helpMaxOffset(), value + 1));
						else if (key === "k" || key === "up")
							setHelpOffset((value) => Math.max(0, value - 1));
						return true;
					},
				},
			],
			bindings: ["escape", "j", "k", "up", "down"].map((key) => ({
				key,
				cmd: "help.handle",
			})),
		});
		const disposeReviewComment = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "review-comment",
			priority: 1200,
			activeModal: "review-comment",
			commands: [
				{
					name: "review-comment.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						const returnModal = () =>
							reviewKind() === "plan" || reviewKind() === "wiki"
								? "plan-review"
								: "developer-review";
						if (key === "escape") {
							setReviewCommentMode(false);
							setReviewCommentText("");
							props.keymap.setData("modal.active", returnModal());
						} else if (key === "backspace")
							setReviewCommentText((text) => text.slice(0, -1));
						else if (key === "enter" || key === "return") {
							const body = reviewCommentText().trim();
							if (!body) return true;
							const file = reviewVisibleChanges()[reviewChangeIndex()];
							const range = reviewSourceRange();
							const line = range.end ?? range.start;
							if (file && line !== undefined) {
								const rangeComment =
									range.start !== undefined &&
									range.end !== undefined &&
									range.start !== range.end
										? { startLine: range.start, endLine: range.end }
										: {};
								setReviewComments((comments) => [
									...comments,
									{ filePath: file.newPath, line, body, ...rangeComment },
								]);
							} else if (file)
								notify("Could not map selected line to file line", "warning");
							setReviewVisualMode(false);
							setReviewCommentMode(false);
							setReviewCommentText("");
							props.keymap.setData("modal.active", returnModal());
						} else if (event.name === "space" || event.name === " ")
							setReviewCommentText((text) => `${text} `);
						else if (event.name.length === 1)
							setReviewCommentText(
								(text) =>
									text + (event.shift ? event.name.toUpperCase() : event.name),
							);
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"backspace",
				"enter",
				"return",
				"space",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\".split(
					"",
				),
			].map((key) => ({
				key,
				cmd: "review-comment.handle",
			})) satisfies readonly Binding[],
		});
		const disposeDeveloperReview = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "developer-review",
			priority: 1100,
			activeModal: "developer-review",
			commands: [
				{
					name: "developer-review.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						// `?` opens the review dialog's own help; its search field keeps
						// `?` as a literal query character.
						if (key === "?" && !reviewSearchMode() && routeModalHelp(key))
							return true;
						return handleReviewKey(event);
					},
				},
			],
			bindings: [
				"escape",
				"f",
				"v",
				"n",
				"N",
				"s",
				"[",
				"]",
				"j",
				"k",
				"up",
				"down",
				"enter",
				"return",
				"space",
				"backspace",
				"delete",
				"/",
				"c",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\".split(
					"",
				),
			].map((key) => ({ key, cmd: "developer-review.handle" })),
		});
		const disposePlanRejection = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "plan-rejection",
			priority: 1300,
			activeModal: "plan-rejection",
			commands: [
				{
					name: "plan-rejection.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						if (key === "escape") {
							setPlanRejectionOpen(false);
							props.keymap.setData("modal.active", "plan-review");
						} else if (key === "j" || key === "down")
							setPlanRejectionSelection((index) =>
								Math.min(planRejectionReasons.length - 1, index + 1),
							);
						else if (key === "k" || key === "up")
							setPlanRejectionSelection((index) => Math.max(0, index - 1));
						else if (key === "enter" || key === "return") {
							const reason = planRejectionReasons[planRejectionSelection()];
							if (reason) void rejectPlan(reason);
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({ key, cmd: "plan-rejection.handle" }),
			),
		});
		const disposePlanReview = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "plan-review",
			priority: 1100,
			activeModal: "plan-review",
			commands: [
				{
					name: "plan-review.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						// `?` opens the review dialog's own help; its search field keeps
						// `?` as a literal query character.
						if (key === "?" && !reviewSearchMode() && routeModalHelp(key))
							return true;
						return handleReviewKey(event);
					},
				},
			],
			bindings: [
				"escape",
				"f",
				"[",
				"]",
				"v",
				"n",
				"N",
				"j",
				"k",
				"up",
				"down",
				"enter",
				"return",
				"backspace",
				"delete",
				"/",
				"c",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\".split(
					"",
				),
			].map((key) => ({ key, cmd: "plan-review.handle" })),
		});
		const disposeFindings = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "findings",
			priority: 1000,
			activeModal: "findings",
			commands: [
				{
					name: "findings.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						const items = (findings()?.events ?? []).filter(
							(item) => item.type !== "verdict",
						);
						if (key === "escape") {
							setFindings(undefined);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setSelectedFinding((value) =>
								Math.min(items.length - 1, value + 1),
							);
						else if (key === "k" || key === "up")
							setSelectedFinding((value) => Math.max(0, value - 1));
						else if (key === "pagedown") findingDetailScroll?.scrollBy(5);
						else if (key === "pageup") findingDetailScroll?.scrollBy(-5);
						else if (key === "enter" || key === "return") {
							const finding = items[selectedFinding()];
							if (finding?.type === "finding") {
								void openFindingInEditorAsync(data().state, finding).catch(
									(error) => {
										setVerdictReturnToFindings(true);
										setVerdictRenderMarkdown(false);
										setVerdict({
											title: "Editor launch failed",
											content:
												error instanceof Error ? error.message : String(error),
										});
										setVerdictOffset(0);
										props.keymap.setData("modal.active", "verdict");
									},
								);
							}
						}
						return true;
					},
				},
			],
			bindings: [
				"escape",
				"enter",
				"return",
				"j",
				"k",
				"up",
				"down",
				"pageup",
				"pagedown",
				"?",
			].map((key) => ({ key, cmd: "findings.handle" })),
		});
		const disposeVerdict = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "verdict",
			priority: 1000,
			activeModal: "verdict",
			commands: [
				{
					name: "verdict.handle",
					run: ({ event }) => {
						const name = event.name.toLowerCase();
						if (routeModalHelp(name)) return true;
						const max = () => {
							const width = Math.max(
								40,
								Math.floor(dimensions().width * 0.7) - 8,
							);
							const wrapped =
								verdict()
									?.content.split(/\r?\n/)
									.reduce(
										(total, line) =>
											total + Math.max(1, Math.ceil(line.length / width)),
										0,
									) ?? 0;
							return Math.max(0, wrapped - verdictLines() + 2);
						};
						if (name === "escape") closeVerdict();
						else if (name === "j" || name === "down")
							setVerdictOffset((offset) => Math.min(max(), offset + 1));
						else if (name === "k" || name === "up")
							setVerdictOffset((offset) => Math.max(0, offset - 1));
						else if (name === "d")
							setVerdictOffset((offset) =>
								Math.min(max(), offset + verdictLines()),
							);
						else if (name === "u")
							setVerdictOffset((offset) =>
								Math.max(0, offset - verdictLines()),
							);
						return true;
					},
				},
			],
			bindings: ["escape", "j", "k", "d", "u", "up", "down", "?"].map(
				(key) => ({
					key,
					cmd: "verdict.handle",
				}),
			),
		});
		const dispose = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "detail",
			priority: 100,
			appView: "detail",
			activeModal: "none",
			commands: [
				{
					name: "detail.handle",
					run: ({ event }) => {
						void handleKey(event);
						return true;
					},
				},
			],
			bindings: [
				"q",
				"ctrl+c",
				"meta+c",
				"y",
				"n",
				"shift+t",
				"shift+r",
				"shift+o",
				"r",
				"v",
				"c",
				"m",
				"p",
				"?",
				"j",
				"k",
				"J",
				"K",
				"H",
				"L",
				"up",
				"down",
				"enter",
				"return",
				"escape",
			].map((key) => ({ key, cmd: "detail.handle" })),
		});
		onCleanup(() => {
			disposeTheme();
			disposeQuestion();
			disposeCredentials();
			disposeCompletedPicker();
			disposeRepair();
			disposeUserAction();
			disposeCost();
			disposePresetSwitcher();
			disposeHelp();
			disposeReviewComment();
			disposeDeveloperReview();
			disposePlanRejection();
			disposePlanReview();
			disposeFindings();
			disposeVerdict();
			dispose();
		});
		// Failure diagnostics the engine attaches to a workflow are surfaced once
		// per distinct message through the global error modal instead of a
		// persistent red line at the top of the Change panel.
		let lastHealthDiagnostic: string | undefined;
		createEffect(() => {
			const diagnostic = data().state.health.diagnostic;
			if (!diagnostic) {
				lastHealthDiagnostic = undefined;
				return;
			}
			if (diagnostic === lastHealthDiagnostic) return;
			lastHealthDiagnostic = diagnostic;
			showErrorModal("Invalid workflow state", diagnostic);
		});
		// Git status is best-effort: an unavailable worktree is a warning toast,
		// deduped per diagnostic, not inline panel text.
		let lastGitDiagnostic: string | undefined;
		createEffect(() => {
			const status = data().gitStatus;
			if (status.available || !status.diagnostic) {
				lastGitDiagnostic = undefined;
				return;
			}
			if (status.diagnostic === lastGitDiagnostic) return;
			lastGitDiagnostic = status.diagnostic;
			notify(`Git status unavailable: ${status.diagnostic}`, "warning");
		});
		// A workflow whose project was removed from configuration keeps its
		// detail access; the catalog mismatch is surfaced once per message as an
		// advisory toast without retargeting the pinned checkout.
		let lastCatalogMismatch: string | undefined;
		createEffect(() => {
			const mismatch = data().catalogMismatch;
			if (!mismatch) {
				lastCatalogMismatch = undefined;
				return;
			}
			if (mismatch === lastCatalogMismatch) return;
			lastCatalogMismatch = mismatch;
			notify(mismatch, "warning");
		});
		const anyModalOpen = () =>
			!!(
				credentialRequest() ||
				verdict() ||
				findings() ||
				help() ||
				themePicker() ||
				completedPicker() ||
				repairOpen() ||
				planRejectionOpen() ||
				userActionOpen() ||
				questionOpen() ||
				costOpen() ||
				presetSwitcherOpen() ||
				reviewOpen() ||
				reviewCommentMode() ||
				activeErrorModal() != null
			);
		// Self-heal: reconcile keymap modal data with real modal state.
		createEffect(() => {
			if (!anyModalOpen()) props.keymap.setData("modal.active", "none");
		});
		// The credential popup opens while the dashboard is busy (delivery drain);
		// switch the keymap to the non-busy-gated layer and restore the previous
		// modal on resolution.
		createEffect(() => {
			if (props.active && !props.active()) return;
			const request = credentialRequest();
			const current = props.keymap.getData?.("modal.active");
			if (request && current !== "credentials") {
				modalBeforeCredential =
					typeof current === "string" ? current : undefined;
				props.keymap.setData("modal.active", "credentials");
			} else if (!request && modalBeforeCredential !== undefined) {
				props.keymap.setData("modal.active", modalBeforeCredential);
				modalBeforeCredential = undefined;
			}
		});
		createEffect(() => {
			if (props.active && !props.active()) return;
			const question = pendingQuestion();
			if (question && question.id !== pendingQuestionId) {
				pendingQuestionId = question.id;
				setQuestionTab(0);
				setQuestionPromptOffset(0);
				setQuestionSelection(0);
				setQuestionCustom(false);
				setQuestionCustomText("");
				setQuestionDrafts({});
				setQuestionOptionDetail(undefined);
				setQuestionDetailOffset(0);
			}
			if (question && !questionOpen() && !credentialRequest()) {
				const current = props.keymap.getData?.("modal.active");
				modalBeforeQuestion =
					typeof current === "string" && current !== "none"
						? current
						: undefined;
				setQuestionOpen(true);
				props.keymap.setData("modal.active", "developer-question");
			} else if (!question && questionOpen()) {
				pendingQuestionId = undefined;
				closeQuestion();
			}
		});
		createEffect(() => {
			if (props.active && !props.active()) return;
			const action = requiredUserAction();
			if (!action) {
				promptedUserActionKey = undefined;
				if (userActionOpen()) {
					setUserActionOpen(false);
					props.keymap.setData("modal.active", "none");
				}
				return;
			}
			if (promptedUserActionKey === action.key) return;
			if (userActionOpen()) {
				promptedUserActionKey = action.key;
				setUserActionSelection(0);
				return;
			}
			if (anyModalOpen()) return;
			promptedUserActionKey = action.key;
			if (action.key === "developer-review") {
				// Auto-open the review as the changed-files popup, not the generic
				// ListViewModal (the merged user action has no selectable items).
				openDeveloperReview();
				return;
			}
			if (action.key === "plan-review" || action.key === "wiki-review") {
				// Auto-open trigger-only review actions directly, not the generic
				// ListViewModal (there are no selectable items).
				openPlanReview();
				return;
			}
			setUserActionSelection(0);
			setUserActionOpen(true);
			props.keymap.setData("modal.active", "user-action");
		});
	});
	const _prompt = createMemo(() =>
		data().state.status === "paused"
			? "Verification paused · developer intervention required"
			: (gate()?.prompt ?? "Waiting for workflow activity"),
	);

	return (
		<box style={{ width: "100%", height: "100%" }}>
			<Layout
				content={
					<box
						backgroundColor={uiColors.bgBase}
						style={{
							width: "100%",
							height: "100%",
							flexDirection: "column",
							gap: 1,
						}}
					>
						<box
							style={{
								width: "100%",
								flexGrow: 1,
								minHeight: 0,
								flexDirection: "row",
								gap: 1,
							}}
						>
							<box
								flexGrow={1}
								flexBasis={0}
								minWidth={0}
								height="100%"
								flexDirection="column"
								gap={1}
							>
								<ChangePanel
									data={data()}
									active={activePanel() === 0}
									onScrollBoxReady={(box) => {
										changeScroll = box as ScrollBoxRenderable;
									}}
								/>
								<Show when={artifacts().length > 0}>
									<OpenSpecPanel
										artifacts={artifacts()}
										active={activePanel() === 6}
										selectedIndex={selectedArtifact()}
									/>
								</Show>
							</box>
							<AgentsPanel
								data={data()}
								active={activePanel() === 1}
								selectedIndex={selectedAgent()}
								narrow={dimensions().width < 90}
							/>
						</box>
					</box>
				}
			/>
			<Overlays
				state={overlays}
				pickerHint={completedInputHint()}
				repair={
					repairOpen()
						? {
								revision: data().state.revision,
								items: repairTargets().map((target) => target.label),
							}
						: undefined
				}
				completedPicker={
					completedPicker()
						? {
								items: completedActions().map((action) => action.label),
								reason: actionReason(),
								followUp:
									completedActions()[completedSelection()]?.command ===
									"research-follow-up",
							}
						: undefined
				}
				userAction={
					userActionOpen() && requiredUserAction()
						? {
								title: requiredUserAction()?.title ?? "",
								prompt: requiredUserAction()?.prompt ?? "",
								items: requiredUserAction()?.items ?? [],
							}
						: undefined
				}
				helpLines={
					help() ? Math.max(5, Math.floor(dimensions().height * 0.78) - 5) : 0
				}
				theme={
					themePicker()
						? {
								active: getActiveThemeName(),
								themes: filteredThemes(),
							}
						: undefined
				}
				findings={
					findings()
						? {
								title: findings()?.title ?? "",
								events: [...(findings()?.events ?? [])],
								onDetailScrollBoxReady: (scrollBox) => {
									findingDetailScroll = scrollBox;
								},
							}
						: undefined
				}
				planRejection={
					planRejectionOpen()
						? {
								reasons: planRejectionReasons,
								selected: planRejectionSelection(),
							}
						: undefined
				}
				cost={costOpen() ? { rows: data().costBreakdown } : undefined}
				presetSwitcher={
					presetSwitcherOpen()
						? {
								choices: presetSwitcherChoices(),
								selectedPreset: data().state.selectedPreset,
								onKeyReady: (handler) =>
									setPresetSwitcherHandler(() => handler),
								onCancel: closePresetSwitcher,
								onSelect: (preset) => void selectPreset(preset),
							}
						: undefined
				}
				verdict={
					verdict()
						? {
								title: verdict()?.title ?? "",
								content: verdict()?.content ?? "",
								lines: verdictLines(),
							}
						: undefined
				}
			/>
			<ReviewRoute
				feature={reviewFeature}
				modalTop={() => modalHost.top()?.kind}
				setModalActive={(modal: string) =>
					props.keymap.setData("modal.active", modal)
				}
				fallbackTitle={requiredUserAction()?.title}
			/>
			<DialogueRoute
				dialogue={dialogue}
				open={questionOpen()}
				pendingGroup={pendingQuestionGroup()}
				credential={credentialRequest()}
				credentialInput={credentialInput()}
				modalTop={() => modalHost.top()?.kind}
				finishing={reviewFinishing()}
				finishingMessage={reviewFinishingMessage()}
				onCustomTextChange={updateQuestionCustomText}
			/>
		</box>
	);
}

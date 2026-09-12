/** @jsxImportSource @opentui/solid */

import { join } from "node:path";
import {
	type KeyEvent,
	type Renderable,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { DeveloperDialogueRecord } from "../../workflow/contracts";
import { formatDuration } from "../../workflow/format";
import { wikiWorkflowDataRoot } from "../../workflow/runtime";
import { copyToClipboard } from "../clipboard";
import { activeErrorModal, showErrorModal } from "../shared/errorModal";
import { setActiveKeybindCatalog } from "../shared/keybinds";
import { ModalHelpOverlay } from "../shared/ModalHelpOverlay";
import { handleModalHelpKey, modalHelpOpen } from "../shared/modalHelp";
import { testDashboard } from "./demo";
import { ChangedFilesView } from "./devenv-ui/components/ChangedFilesView";
import { DiffViewModal } from "./devenv-ui/components/DiffViewModal";
import { GenericModal } from "./devenv-ui/components/GenericModal";
import { MarkdownViewModal } from "./devenv-ui/components/MarkdownViewModal";
import {
	disposeDashboardApplication,
	disposeExecutionCoordinator,
	onWorkflowExecutionError,
	onWorkflowExecutionSettled,
	reconcileSidebarPresentation,
	requestWorkflowExecution,
	startSidebarPresentation,
} from "./engine";
import {
	herdrEventMatchesWorkspace,
	subscribeHerdrEvents,
} from "./herdr-events";
import { dashboardDetailKeybindCatalog, panelContext } from "./keybinds";
import { notify } from "./notifications";
import {
	answerQuestion,
	applyRepair,
	focusAgentAsync,
	focusReturnWorkspace,
	loadDashboard,
	loadDashboardAsync,
	loadVerifierFindings,
	loadVerifierReport,
	openFindingInEditorAsync,
	openSpecArtifactAsync,
	openSpecArtifacts,
	openSpecArtifactsAsync,
	previewRepair,
	runWorkflow,
} from "./observations";
import { movePanel, type PanelDirection } from "./panel-grid";
import {
	agentMetricLine,
	agentRuntimeModelLine,
	approvalFor,
	type PhaseStatusState,
	phaseStatus,
	requiredUserActionFor,
} from "./projections";
import { createReviewFeature } from "./review";
import { applyTheme, loadThemeName, saveThemeName } from "./theme-settings";
import { traceTui } from "./tracing";
import type {
	DashboardData,
	FindingCounts,
	RequiredUserActionItem,
} from "./types";
import { Badge } from "./ui/Badge";
import { CostModal } from "./ui/CostModal";
import {
	CredentialsModal,
	pendingCredentialRequest,
} from "./ui/CredentialsModal";
import { uiColors } from "./ui/colors";
import { DeveloperQuestionModal } from "./ui/DeveloperQuestionModal";
import { EventsModal } from "./ui/EventsModal";
import { type FindingEvent, FindingsModal } from "./ui/FindingsModal";
import { HelpModal } from "./ui/HelpModal";
import { HighlightedText } from "./ui/Highlight";
import { Layout } from "./ui/Layout";
import { ListViewModal } from "./ui/ListViewModal";
import { NotificationOverlay } from "./ui/Notification";
import { Panel } from "./ui/Panel";
import { ProgressModal } from "./ui/ProgressModal";
import { ScrollableContent } from "./ui/ScrollableContent";
import { SelectableList } from "./ui/Selectable";
import { ThemePickerModal } from "./ui/ThemePickerModal";
import { getActiveThemeName, themeNames } from "./ui/theme";
import { VerdictModal } from "./ui/VerdictModal";
import { debounce, watchDirectories } from "./watchRefresh";

export type { PhaseStatusState };
// Projection helpers are owned by `projections.ts`; these narrow re-exports
// keep the public dashboard root surface (and its renderer tests) stable.
export { agentMetricLine, agentRuntimeModelLine, phaseStatus };

export function PhaseStatus(props: { state: PhaseStatusState }) {
	const status = createMemo(() => phaseStatus(props.state));
	return (
		<box flexDirection="row" gap={1}>
			<Badge
				text={status().text}
				appearance="badge"
				highlight={status().working ? "highlight2" : "secondary"}
				animation={status().working ? "aurora" : "static"}
			/>
			<Show when={status().blocked}>
				<Badge
					text="BLOCKED"
					appearance="badge"
					highlight="warning"
					animation="static"
				/>
			</Show>
		</box>
	);
}

function FindingCountSummary(props: {
	counts: FindingCounts;
	compact: boolean;
}) {
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

export function App(props: {
	repo: string;
	workflowId: string;
	profile?: "test";
	/** Test fixture override for rendering a branch without a usable upstream. */
	testNoUpstream?: boolean;
	/** Test fixture override for rendering a custom dashboard (e.g. with artifacts). */
	testData?: DashboardData;
	keymap: Keymap<Renderable, KeyEvent>;
	/** Push the workflow header context up to the shell's global header. */
	onHeader?: (
		header: import("../otel/app/App").WorkflowHeaderInfo | null,
	) => void;
}) {
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
	const load = () => {
		if (props.profile !== "test")
			return loadDashboard(props.repo, props.workflowId);
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
			? load()
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
	let refreshQueued = false;
	let refreshDisposed = false;
	let refreshController: AbortController | undefined;
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
	let lastQuitAt = 0;
	const [busy, setBusy] = createSignal(false);
	// Dedicated review-finishing signal (in addition to the busy guard): scopes
	// the progress overlay to review finishes instead of every busy action.
	const [reviewFinishing, setReviewFinishing] = createSignal(false);
	const [reviewFinishingMessage, setReviewFinishingMessage] = createSignal("");
	let changeScroll: ScrollBoxRenderable | undefined;
	const [activePanel, setActivePanel] = createSignal(0);
	const [selectedAgent, setSelectedAgent] = createSignal(0);
	const [selectedArtifact, setSelectedArtifact] = createSignal(0);
	const [artifacts, setArtifacts] = createSignal<string[]>([]);
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
		void openSpecArtifactsAsync(data().state, artifactController.signal)
			.then((next) => {
				if (generation === artifactGeneration) setArtifacts(next);
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
	const [userActionSelection, setUserActionSelection] = createSignal(0);
	let promptedUserActionKey: string | undefined;
	const [verdict, setVerdict] = createSignal<{
		title: string;
		content: string;
	}>();
	const [verdictReturnToFindings, setVerdictReturnToFindings] =
		createSignal(false);
	const [verdictReturnToUserAction, setVerdictReturnToUserAction] =
		createSignal(false);
	// Opt-in Markdown rendering for the OpenSpec artifact view only (D5).
	const [verdictRenderMarkdown, setVerdictRenderMarkdown] = createSignal(false);
	const [findings, setFindings] = createSignal<{
		title: string;
		events: FindingEvent[];
	}>();
	const [selectedFinding, setSelectedFinding] = createSignal(0);
	const openVerifierResult = (role: string) => {
		setVerdictReturnToFindings(false);
		setVerdictReturnToUserAction(false);
		setVerdictRenderMarkdown(false);
		const parsed =
			props.profile === "test"
				? undefined
				: loadVerifierFindings(props.repo, props.workflowId, role);
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
				: loadVerifierReport(props.repo, props.workflowId, role),
		);
		setVerdictOffset(0);
		props.keymap.setData("modal.active", "verdict");
	};
	const [verdictOffset, setVerdictOffset] = createSignal(0);
	const [eventsDetail, setEventsDetail] = createSignal(false);
	const [selectedEvent, setSelectedEvent] = createSignal(0);
	const [help, setHelp] = createSignal(false);
	const [themePicker, setThemePicker] = createSignal(false);
	const [completedPicker, setCompletedPicker] = createSignal(false);
	const [completedSelection, setCompletedSelection] = createSignal(0);
	const [actionReason, setActionReason] = createSignal("");
	const [repairOpen, setRepairOpen] = createSignal(false);
	const [repairTargets, setRepairTargets] = createSignal<
		Array<{
			targetStep: string;
			label: string;
			expiresRuns: string[];
			retainedEvidence: string[];
		}>
	>([]);
	const [repairSelection, setRepairSelection] = createSignal(0);
	// On-demand credential popup (askpass bridge): `pendingCredentialRequest()`
	// is set by the in-process effect runner while a git command awaits an SSH
	// passphrase. The popup keymap layer must not be gated on busy() because the
	// delivery drain runs while the dashboard is busy.
	const credentialRequest = createMemo(() => pendingCredentialRequest());
	const [credentialInput, setCredentialInput] = createSignal("");
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
	const [questionOpen, setQuestionOpen] = createSignal(false);
	const [questionTab, setQuestionTab] = createSignal(0);
	const [questionPromptOffset, setQuestionPromptOffset] = createSignal(0);
	const [questionSelection, setQuestionSelection] = createSignal(0);
	const [questionCustom, setQuestionCustom] = createSignal(false);
	const [questionCustomText, setQuestionCustomText] = createSignal("");
	const [questionDrafts, setQuestionDrafts] = createSignal<
		Record<string, { kind: "option" | "custom"; value: string }>
	>({});
	const [questionSubmitting, setQuestionSubmitting] = createSignal(false);
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
					answerQuestion(
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
					answerQuestion(
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
				answerQuestion(
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
	const [costOpen, setCostOpen] = createSignal(false);
	const [costSelection, setCostSelection] = createSignal(0);
	const [costAgent, setCostAgent] = createSignal<string | null>(null);
	const [costOffset, setCostOffset] = createSignal(0);
	const [themeIndex, setThemeIndex] = createSignal(
		Math.max(0, themeNames.indexOf(loadThemeName())),
	);
	const [themeQuery, setThemeQuery] = createSignal("");
	const [themeFiltering, setThemeFiltering] = createSignal(false);
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
				content = await openSpecArtifactAsync(
					data().state,
					item.value,
					reviewDiffSignal(),
				);
			} catch (error) {
				content = `Could not open ${item.value}: ${error instanceof Error ? error.message : String(error)}`;
			}
			setVerdict({ title: `OpenSpec · ${item.value}`, content });
			setVerdictOffset(0);
			props.keymap.setData("modal.active", "verdict");
			return;
		}
		if (item.kind === "workflow" && item.value === "research-follow-up") {
			setUserActionOpen(false);
			setCompletedPicker(true);
			props.keymap.setData("modal.active", "completed-actions");
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
	const refresh = () => {
		if (refreshDisposed) return;
		if (props.profile === "test") {
			setData(load());
			traceTui("tui.dashboard.refresh", {
				surface: "dashboard",
				action: "refresh",
			});
			return;
		}
		refreshQueued = refreshRunning;
		const generation = ++refreshGeneration;
		if (refreshRunning) return;
		refreshRunning = true;
		refreshController?.abort();
		refreshController = new AbortController();
		void loadDashboardAsync(
			props.repo,
			props.workflowId,
			refreshController.signal,
		)
			.then((next) => {
				if (!refreshDisposed && generation === refreshGeneration) {
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
						showErrorModal("Observation failed", message);
					}
				}
			})
			.finally(() => {
				refreshRunning = false;
				if (refreshQueued && !refreshDisposed) {
					refreshQueued = false;
					refresh();
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
		dimensions,
		setDemoIndex,
		demoPhases,
	});
	const {
		reviewOpen,
		setReviewOpen,
		reviewKind,
		reviewView,
		setReviewView,
		reviewChangeIndex,
		reviewLine,
		setReviewLine,
		reviewDiff,
		setReviewComments,
		reviewCommentMode,
		setReviewCommentMode,
		reviewCommentText,
		setReviewCommentText,
		reviewVisualMode,
		setReviewVisualMode,
		reviewVisualStart,
		reviewSourceRange,
		setReviewSourceRange,
		setReviewDiscussionLineIndices,
		setReviewSelectableLineCount,
		setReviewSelectedLineFindingIds,
		reviewSearchMode,
		reviewSearchQuery,
		reviewSplitView,
		planRejectionReasons,
		planRejectionOpen,
		setPlanRejectionOpen,
		planRejectionSelection,
		setPlanRejectionSelection,
		reviewVisibleChanges,
		reviewFile,
		reviewChangesForView,
		reviewFilesAvailableLines,
		reviewDiffFile,
		reviewDiscussions,
		currentReviewDiscussions,
		developerReviewPhase,
		openDeveloperReview,
		openPlanReview,
		navigateReviewFile,
		navigatePlanMarkdownFile,
		rejectPlan,
		handleReviewKey,
		reviewDiffSignal,
		dispose: reviewFeatureDispose,
	} = reviewFeature;
	const filteredThemes = () =>
		themeNames.filter((name) => name.includes(themeQuery().toLowerCase()));
	const [helpOffset, setHelpOffset] = createSignal(0);
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

	// File-backed state (artifacts, telemetry, the SQLite mirror) still changes
	// from other processes, so keep the OS event watches; the Herdr subscription
	// below adds agent/tab lifecycle pushes on top.
	createEffect(() => {
		if (props.profile === "test") return;
		const state = data().state;
		const dirs =
			state.definition?.id === "research"
				? [join(wikiWorkflowDataRoot(), props.workflowId)]
				: [
						join(props.repo, ".herdr-workflow", props.workflowId),
						join(state.worktree, ".herdr-workflow", props.workflowId),
					];
		const dispose = watchDirectories(dirs, refresh);
		onCleanup(dispose);
	});

	createEffect(() => {
		if (props.profile === "test") return;
		const workspace = workflowWorkspace();
		// Herdr is the source of truth for agent/tab lifecycle and re-publishes
		// a short event backlog on connect; debounce so a burst is one reload.
		const debounced = debounce(refresh, 200);
		const dispose = subscribeHerdrEvents((event) => {
			if (herdrEventMatchesWorkspace(event.data, workspace)) {
				debounced.trigger();
				// Runtime-only input changes (a blocked approval prompt) arrive as
				// events without a workflow revision change, so reconcile the
				// presentation from the live read too.
				reconcileSidebarPresentation();
			}
		});
		onCleanup(() => {
			debounced.cancel();
			dispose();
		});
	});

	onMount(() => {
		const disposeExecutionError =
			props.profile === "test"
				? undefined
				: onWorkflowExecutionError(props.repo, (workflowId) => {
						if (workflowId === props.workflowId) refresh();
					});
		// A dashboard-initiated drain can change state without a Herdr event
		// (developer transitions), so refresh when the coordinator settles.
		const disposeExecutionSettled =
			props.profile === "test"
				? undefined
				: onWorkflowExecutionSettled(props.repo, (workflowId) => {
						if (workflowId === props.workflowId) refresh();
					});
		if (props.profile !== "test")
			requestWorkflowExecution(props.repo, props.workflowId);
		const stopSidebarPresentation =
			props.profile === "test"
				? undefined
				: startSidebarPresentation(() => [props.repo]);
		refresh();
		onCleanup(() => {
			refreshDisposed = true;
			refreshController?.abort();
			disposeExecutionError?.();
			disposeExecutionSettled?.();
			stopSidebarPresentation?.();
			artifactGeneration++;
			artifactController?.abort();
			reviewFeatureDispose();
			disposeExecutionCoordinator(props.repo);
			// Dashboard unmount releases the single owned application runtime
			// (complete-workflow-effect-cutover, task 1).
			disposeDashboardApplication();
		});
	});

	const handleKey = async (key: KeyEvent) => {
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
				const workspace = (
					props.profile === "test"
						? data()
						: await loadDashboardAsync(props.repo, props.workflowId)
				).state.returnWorkspace;
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
			try {
				setRepairTargets(previewRepair(props.repo, props.workflowId));
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
			return;
		}
		if (name === "?") {
			setHelp(true);
			setHelpOffset(0);
			props.keymap.setData("modal.active", "help");
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
				openVerifierResult(agent.role);
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
			setActivePanel((panel) =>
				movePanel(panel, direction, {
					artifactsVisible: artifacts().length > 0,
				}),
			);
			return;
		}
		if (name === "down" || name === "j") {
			if (activePanel() === 0) changeScroll?.scrollBy(1);
			else if (activePanel() === 1)
				setSelectedAgent((index) =>
					Math.min(data().agents.length - 1, index + 1),
				);
			else if (activePanel() === 6)
				setSelectedArtifact((index) =>
					Math.min(Math.max(0, artifacts().length - 1), index + 1),
				);
			return;
		}
		if (name === "up" || name === "k") {
			if (activePanel() === 0) changeScroll?.scrollBy(-1);
			else if (activePanel() === 1)
				setSelectedAgent((index) => Math.max(0, index - 1));
			else if (activePanel() === 6)
				setSelectedArtifact((index) => Math.max(0, index - 1));
			return;
		}
		if (name === "enter" || name === "return") {
			// openRequiredUserAction is the sole gate for reopening a review popup
			// on Enter: once its promptedUserActionKey/activePanel guard has
			// dismissed one, Enter falls through to whatever the focused panel
			// does instead of force-reopening it (previously a `core.*` stepId
			// check bypassed that guard for engine-driven views only).
			if (openRequiredUserAction()) return;
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
					void openSpecArtifactAsync(
						data().state,
						artifact,
						artifactController?.signal,
					)
						.then((content) =>
							setVerdict({ title: `OpenSpec · ${artifact}`, content }),
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
	onMount(() => {
		props.keymap.setData("app.view", "detail");
		props.keymap.setData("modal.active", activeErrorModal() ? "error" : "none");
		const disposeTheme = props.keymap.registerLayer({
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
						// `?` opens the dialog's own help unless the custom textarea owns
						// the keyboard (there it stays a literal question mark).
						if (!questionCustom() && routeModalHelp(key)) return true;
						const group = pendingQuestionGroup();
						const current = group[questionTab()] ?? question;
						const customIndex = current.options.length;
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
							if ((key === "enter" || key === "return") && event.meta)
								void submitQuestion({
									kind: "custom",
									value: questionCustomText(),
								});
							else return false;
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
									void submitQuestion({ kind: "option", value: option.value });
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
				"pageup",
				"pagedown",
				"backspace",
				"delete",
				"space",
				..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()/\\@#*+=[]{}~`'\"".split(
					"",
				),
			].map((key) => ({ key, cmd: "developer-question.handle" })),
		});
		const disposeCredentials = props.keymap.registerLayer({
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
							try {
								applyRepair(
									props.repo,
									props.workflowId,
									data().state.revision,
									target.targetStep,
									"",
								);
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
							} catch (error) {
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
							}
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
		const disposeHelp = props.keymap.registerLayer({
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
		const disposeEvents = props.keymap.registerLayer({
			name: "events",
			priority: 1000,
			activeModal: "events",
			commands: [
				{
					name: "events.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						if (key === "escape") {
							setEventsDetail(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setSelectedEvent((value) =>
								Math.min(data().events.length - 1, value + 1),
							);
						else if (key === "k" || key === "up")
							setSelectedEvent((value) => Math.max(0, value - 1));
						return true;
					},
				},
			],
			bindings: ["escape", "j", "k", "up", "down", "?"].map((key) => ({
				key,
				cmd: "events.handle",
			})),
		});
		const disposeReviewComment = props.keymap.registerLayer({
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
			bindings: ["escape", "enter", "return", "j", "k", "up", "down", "?"].map(
				(key) => ({ key, cmd: "findings.handle" }),
			),
		});
		const disposeVerdict = props.keymap.registerLayer({
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
				"shift+t",
				"shift+r",
				"shift+o",
				"r",
				"v",
				"c",
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
			disposeHelp();
			disposeEvents();
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
		const anyModalOpen = () =>
			!!(
				credentialRequest() ||
				verdict() ||
				findings() ||
				eventsDetail() ||
				help() ||
				themePicker() ||
				completedPicker() ||
				repairOpen() ||
				planRejectionOpen() ||
				userActionOpen() ||
				questionOpen() ||
				costOpen() ||
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
			const question = pendingQuestion();
			if (question && question.id !== pendingQuestionId) {
				pendingQuestionId = question.id;
				setQuestionTab(0);
				setQuestionPromptOffset(0);
				setQuestionSelection(0);
				setQuestionCustom(false);
				setQuestionCustomText("");
				setQuestionDrafts({});
			}
			if (question && !questionOpen()) {
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
								<Panel
									title={`Change (${data().age} ago)`}
									accent={uiColors.primary}
									active={activePanel() === 0}
									style={{ width: "100%", flexGrow: 1, minHeight: 0 }}
								>
									<ScrollableContent
										onScrollBoxReady={(box) => {
											changeScroll = box;
										}}
									>
										<box flexDirection="row">
											<box width={7}>
												<text fg={uiColors.textMuted}>STATUS</text>
											</box>
											<PhaseStatus state={data().state} />
										</box>
										<text fg={uiColors.textMuted}>GIT STATUS</text>
										<Show when={data().gitStatus.available}>
											<Show when={data().gitStatus.branch}>
												<box flexDirection="row" overflow="hidden">
													<text
														fg={uiColors.success}
														flexShrink={0}
														wrapMode="none"
													>
														+{data().gitStatus.addedFiles}
													</text>
													<text
														fg={uiColors.warning}
														flexShrink={0}
														wrapMode="none"
													>
														*{data().gitStatus.changedFiles}
													</text>
													<text
														fg={uiColors.error}
														flexShrink={0}
														wrapMode="none"
													>
														-{data().gitStatus.deletedFiles}{" "}
													</text>
													<Show
														when={!data().gitStatus.noUpstream}
														fallback={
															<text
																fg={uiColors.textMuted}
																flexShrink={0}
																wrapMode="none"
															>
																
															</text>
														}
													>
														<text
															fg={uiColors.success}
															flexShrink={0}
															wrapMode="none"
														>
															↑{data().gitStatus.ahead}{" "}
														</text>
														<text
															fg={uiColors.success}
															flexShrink={0}
															wrapMode="none"
														>
															↓{data().gitStatus.behind}
														</text>
													</Show>
													<text
														fg={uiColors.textSecondary}
														flexShrink={0}
														wrapMode="none"
													>
														{" "}
														{data().gitStatus.branch}
													</text>
												</box>
											</Show>
										</Show>
										<Show when={data().state.definition}>
											{(definition) => (
												<box flexDirection="row">
													<box width={7}>
														<text fg={uiColors.textMuted}>FLOW</text>
													</box>
													<text fg={uiColors.textSecondary}>
														{definition().label} · v{definition().version}
													</text>
												</box>
											)}
										</Show>
										<Show when={data().state.ticketNumber}>
											<box flexDirection="row">
												<box width={7}>
													<text fg={uiColors.textMuted}>TICKET</text>
												</box>
												<HighlightedText
													text={data().state.ticketNumber ?? ""}
													highlight="highlight"
												/>
											</box>
										</Show>
										<Show when={data().state.planQuality}>
											{(plan) => (
												<box flexDirection="row">
													<box width={7}>
														<text fg={uiColors.textMuted}>PLAN</text>
													</box>
													<Badge
														text={plan().passed ? "PASS" : "FAIL"}
														highlight={plan().passed ? "positive" : "negative"}
													/>
													<text fg={uiColors.textSecondary}>
														{" "}
														{plan().specFiles} specs · {plan().taskCount} tasks
													</text>
												</box>
											)}
										</Show>
										<Show when={data().state.verificationTier}>
											{(tier) => {
												const roles = () =>
													data().state.verificationRoles ?? [];
												const completed = () =>
													roles().filter(
														(role) => data().state.verificationResults?.[role],
													).length;
												return (
													<box flexDirection="row">
														<box width={7}>
															<text fg={uiColors.textMuted}>VERIFY</text>
														</box>
														<Badge
															text={tier().toUpperCase()}
															highlight="highlight2"
														/>
														<text fg={uiColors.textSecondary}>
															{" "}
															{completed()}/{roles().length} reviews · round{" "}
															{data().state.verificationRound}
														</text>
													</box>
												);
											}}
										</Show>
										<text fg={uiColors.textMuted}>REQUEST</text>
										<box paddingLeft={1}>
											<text fg={uiColors.textPrimary}>{data().request}</text>
										</box>
									</ScrollableContent>
								</Panel>
								<Show when={artifacts().length > 0}>
									<Panel
										title="OpenSpec"
										accent={uiColors.accent}
										active={activePanel() === 6}
										style={{
											width: "100%",
											height: Math.min(artifacts().length, 5) + 1,
											flexShrink: 0,
										}}
									>
										<SelectableList
											items={artifacts()}
											selectedIndex={
												activePanel() === 6 ? selectedArtifact() : -1
											}
											renderItem={(artifact, selected) => (
												<box height={1} paddingLeft={1}>
													<text
														fg={
															selected
																? uiColors.textPrimary
																: uiColors.textSecondary
														}
														attributes={selected ? TextAttributes.BOLD : 0}
													>
														{artifact}
													</text>
												</box>
											)}
										/>
									</Panel>
								</Show>
							</box>
							<Panel
								title="Agents"
								accent={uiColors.accent}
								active={activePanel() === 1}
								style={{
									flexGrow: 1,
									flexBasis: 0,
									minWidth: 0,
									height: "100%",
								}}
							>
								<SelectableList
									items={data().agents}
									selectedIndex={activePanel() === 1 ? selectedAgent() : -1}
									renderItem={(agent, _selected) => {
										const timeline = () =>
											data().verifierTimeline.find(
												(item) => item.role === agent.role,
											);
										const metricsLine = () => agentMetricLine(agent.metrics);
										const runtimeModelLine = () =>
											agentRuntimeModelLine(
												agent.runtime,
												timeline()?.model ?? agent.model,
											);
										const findingSummaryRows = () =>
											dimensions().width < 90 ? 3 : 1;
										const highlight = () =>
											agent.status === "working"
												? "highlight2"
												: agent.status === "completed"
													? "positive"
													: agent.status === "blocked"
														? "warning"
														: agent.status === "failed"
															? "negative"
															: "secondary";
										return (
											<box
												width="100%"
												height={
													2 +
													(metricsLine() ? 1 : 0) +
													(agent.findingCounts ? findingSummaryRows() : 0)
												}
												flexDirection="column"
												paddingLeft={1}
												paddingRight={1}
											>
												<box width="100%" height={1} flexDirection="row">
													<box flexGrow={1} minWidth={0} overflow="hidden">
														<text
															fg={uiColors.textPrimary}
															attributes={TextAttributes.BOLD}
														>
															{agent.role}
														</text>
													</box>
													<Badge
														text={agent.status}
														appearance="text"
														highlight={highlight()}
														animation={
															agent.status === "working" ? "aurora" : "static"
														}
														attributes={TextAttributes.BOLD}
														transitionKey={agent.role}
													/>
												</box>
												<box width="100%" height={1} flexDirection="row">
													<box flexGrow={1} minWidth={0} overflow="hidden">
														<text fg={uiColors.textMuted}>
															{runtimeModelLine() ??
																(timeline()
																	? "default"
																	: agent.role.endsWith("verifier")
																		? "Awaiting verification run"
																		: "Interactive workflow agent")}
														</text>
													</box>
													<Show when={timeline()}>
														{(entry) => {
															const duration = entry().durationSeconds;
															return (
																<text
																	fg={
																		entry().status === "PASS"
																			? uiColors.success
																			: entry().status === "FAIL"
																				? uiColors.error
																				: uiColors.warning
																	}
																>
																	{entry().status}
																	{duration !== undefined
																		? ` · ${formatDuration(duration)}`
																		: ""}
																	{entry().fallback ? " · fallback" : ""}
																</text>
															);
														}}
													</Show>
												</box>
												<Show when={agent.findingCounts}>
													{(counts) => (
														<FindingCountSummary
															counts={counts()}
															compact={findingSummaryRows() === 3}
														/>
													)}
												</Show>
												<Show when={metricsLine()}>
													<box width="100%" height={1} overflow="hidden">
														<text fg={uiColors.textMuted}>{metricsLine()}</text>
													</box>
												</Show>
											</box>
										);
									}}
								/>
							</Panel>
						</box>
					</box>
				}
			/>
			<Show when={repairOpen()}>
				<ListViewModal
					title={`Repair r${data().state.revision} · ENTER repairs`}
					fieldLabel="Compatible target"
					items={repairTargets().map(
						(target) =>
							`${target.label} · expire [${target.expiresRuns.slice(0, 4).join(", ") || "none"}${target.expiresRuns.length > 4 ? ", …" : ""}] · retain [${target.retainedEvidence.slice(0, 4).join(", ") || "none"}${target.retainedEvidence.length > 4 ? ", …" : ""}]`,
					)}
					selectedIndex={repairSelection()}
					help={[
						{ key: "j/k", action: "Target" },
						{ key: "Enter", action: "Repair" },
						{ key: "Esc", action: "Cancel" },
					]}
					renderItem={(item, selected) => (
						<text fg={selected ? uiColors.primary : uiColors.textSecondary}>
							{item}
						</text>
					)}
				/>
			</Show>
			<Show when={completedPicker()}>
				<ListViewModal
					title={`Choose workflow action · ${actionReason() || completedInputHint()}`}
					fieldLabel="Action"
					items={completedActions().map((action) => action.label)}
					selectedIndex={completedSelection()}
					helpSections={false}
					help={[
						{ key: "j/k", action: "Navigate" },
						{
							key: "type",
							action:
								completedActions()[completedSelection()]?.command ===
								"research-follow-up"
									? "Follow-up question"
									: "Reason when required",
						},
						{ key: "Enter", action: "Run" },
						{ key: "Esc", action: "Cancel" },
					]}
					renderItem={(item, selected) => (
						<text fg={selected ? uiColors.primary : uiColors.textSecondary}>
							{item}
						</text>
					)}
				/>
			</Show>
			<Show when={userActionOpen() && requiredUserAction()}>
				<ListViewModal
					title={`⚠ ${requiredUserAction()?.title}`}
					fieldLabel={requiredUserAction()?.prompt}
					items={requiredUserAction()?.items ?? []}
					selectedIndex={userActionSelection()}
					heightPercent={0.5}
					help={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Start" },
						{ key: "Esc", action: "Not now" },
					]}
					renderItem={(item, selected) => (
						<text
							fg={selected ? uiColors.warning : uiColors.textSecondary}
							attributes={selected ? TextAttributes.BOLD : 0}
						>
							{item.label}
						</text>
					)}
				/>
			</Show>
			<Show when={help()}>
				<HelpModal
					title="Dashboard keybindings"
					offset={helpOffset()}
					lines={Math.max(5, Math.floor(dimensions().height * 0.78) - 5)}
				/>
			</Show>
			<NotificationOverlay />
			<Show when={themePicker()}>
				<ThemePickerModal
					selected={themeIndex()}
					active={getActiveThemeName()}
					themes={filteredThemes()}
					query={themeQuery()}
					filtering={themeFiltering()}
				/>
			</Show>
			<Show when={eventsDetail()}>
				<EventsModal
					events={[...data().events].reverse()}
					selected={selectedEvent()}
				/>
			</Show>
			<Show when={findings()}>
				{(result) => (
					<FindingsModal
						title={result().title}
						events={result().events}
						selected={selectedFinding()}
					/>
				)}
			</Show>
			<Show when={planRejectionOpen()}>
				<ListViewModal
					title="Reject plan"
					fieldLabel="Choose a rejection reason"
					items={planRejectionReasons}
					selectedIndex={planRejectionSelection()}
					help={[
						{ key: "j/k", action: "Navigate" },
						{ key: "Enter", action: "Reject plan" },
						{ key: "Esc", action: "Cancel" },
					]}
					renderItem={(item, selected) => (
						<text fg={selected ? uiColors.warning : uiColors.textSecondary}>
							{item}
						</text>
					)}
				/>
			</Show>
			<Show when={reviewOpen() && reviewView() === "files"}>
				<GenericModal
					title={
						reviewKind() === "plan"
							? "Plan review"
							: reviewKind() === "wiki"
								? "Wiki review"
								: (requiredUserAction()?.title ?? "Developer review")
					}
					widthPercent={0.9}
					heightPercent={0.75}
					helpText={[
						{ key: "j/k", action: "Navigate" },
						{
							key: "Enter",
							action:
								reviewKind() === "plan"
									? "Open artifact"
									: reviewKind() === "wiki"
										? "Open document"
										: "Open diff",
						},
						{ key: "/", action: "Search files" },
						...(reviewKind() === "plan" ||
						reviewKind() === "wiki" ||
						developerReviewPhase()
							? [{ key: "f", action: "Finish review" }]
							: []),
						...(reviewKind() === "plan"
							? [{ key: "r", action: "Reject plan" }]
							: []),
						{ key: "Esc", action: "Postpone" },
					]}
					onBackdropClick={() => {
						setReviewOpen(false);
						props.keymap.setData("modal.active", "none");
					}}
				>
					<ChangedFilesView
						changes={reviewChangesForView()}
						selectedIndex={reviewChangeIndex()}
						searchMode={reviewSearchMode()}
						searchQuery={reviewSearchQuery()}
						availableLines={reviewFilesAvailableLines()}
						onClose={() => {
							setReviewOpen(false);
							props.keymap.setData("modal.active", "none");
						}}
					/>
				</GenericModal>
			</Show>
			<Show
				when={
					reviewOpen() &&
					reviewView() === "diff" &&
					reviewKind() === "plan" &&
					reviewFile()
				}
			>
				<MarkdownViewModal
					filePath={reviewFile()?.newPath ?? ""}
					content={reviewDiff()}
					currentFileIndex={reviewChangeIndex()}
					totalFiles={reviewVisibleChanges().length}
					selectedLine={reviewLine()}
					visualModeActive={reviewVisualMode()}
					visualModeStart={reviewVisualStart()}
					commentMode={reviewCommentMode()}
					commentText={reviewCommentText()}
					discussions={currentReviewDiscussions()}
					onSelectedLineChange={setReviewLine}
					onSelectedSourceRangeChange={(start, end) =>
						setReviewSourceRange({ start, end })
					}
					onDiscussionLineIndicesChange={setReviewDiscussionLineIndices}
					onSelectableLineCountChange={setReviewSelectableLineCount}
					onClose={() => {
						setReviewVisualMode(false);
						setReviewCommentMode(false);
						setReviewView("files");
					}}
					onNavigateFile={(direction) =>
						void navigatePlanMarkdownFile(direction)
					}
				/>
			</Show>
			<Show
				when={
					reviewOpen() &&
					reviewView() === "diff" &&
					(reviewKind() === "developer" || reviewKind() === "wiki") &&
					reviewDiffFile()
				}
			>
				{(file) => (
					<DiffViewModal
						filePath={file().new_path}
						diff={file().diff}
						currentFileIndex={reviewChangeIndex()}
						totalFiles={reviewVisibleChanges().length}
						selectedLine={reviewLine()}
						visualModeActive={reviewVisualMode()}
						visualModeStart={reviewVisualStart()}
						forceSplitView={reviewSplitView()}
						isNewFile={file().new_file}
						isDeletedFile={file().deleted_file}
						currentSideOnly={reviewKind() === "wiki"}
						renderMarkdown={reviewKind() === "wiki"}
						commentMode={reviewCommentMode()}
						commentText={reviewCommentText()}
						discussions={reviewDiscussions()}
						onSelectedLineChange={setReviewLine}
						onSelectedSourceRangeChange={(start, end) =>
							setReviewSourceRange({ start, end })
						}
						onDiscussionLineIndicesChange={setReviewDiscussionLineIndices}
						onSelectableLineCountChange={setReviewSelectableLineCount}
						onSelectedFindingIdsChange={setReviewSelectedLineFindingIds}
						onClose={() => {
							setReviewVisualMode(false);
							setReviewCommentMode(false);
							setReviewView("files");
						}}
						onNavigateFile={(direction) => void navigateReviewFile(direction)}
					/>
				)}
			</Show>
			<Show when={costOpen()}>
				<CostModal
					rows={data().costBreakdown}
					selected={costSelection()}
					agent={costAgent()}
					offset={costOffset()}
				/>
			</Show>
			<Show when={verdict()}>
				{(report) => (
					<VerdictModal
						title={report().title}
						content={report().content}
						offset={verdictOffset()}
						lines={verdictLines()}
						renderMarkdown={verdictRenderMarkdown()}
					/>
				)}
			</Show>
			<Show when={questionOpen() && pendingQuestion()}>
				{(_question) => (
					<DeveloperQuestionModal
						questions={pendingQuestionGroup()}
						activeIndex={questionTab()}
						promptOffset={questionPromptOffset()}
						selected={questionSelection()}
						custom={questionCustom()}
						customText={questionCustomText()}
						responseState={pendingQuestionGroup().map((item) =>
							questionDrafts()[item.id]?.value.trim()
								? "answered"
								: "unanswered",
						)}
						onCustomTextChange={updateQuestionCustomText}
					/>
				)}
			</Show>
			<Show when={credentialRequest()}>
				{(request) => (
					<CredentialsModal
						prompt={request().prompt}
						mask={request().mask}
						value={credentialInput()}
					/>
				)}
			</Show>
			<Show when={reviewFinishing()}>
				{/* Stacks above the still-open review popup; cleared in the finish
				    handlers' existing finally cleanup. */}
				<ProgressModal
					title="Finishing review"
					message={reviewFinishingMessage()}
				/>
			</Show>
			{/* The open dialog's own `?` help, above every dialog (question z20,
			    credentials z10). */}
			<ModalHelpOverlay zIndex={30} />
		</box>
	);
}

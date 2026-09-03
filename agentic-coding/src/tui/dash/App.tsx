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
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { DeveloperDialogueRecord } from "../../workflow/contracts";
import { formatDuration } from "../../workflow/format";
import { wikiWorkflowDataRoot } from "../../workflow/runtime";
import { copyToClipboard } from "../clipboard";
import {
	type AgentUsageMetrics,
	answerQuestion,
	applyRepair,
	approvalFor,
	type DashboardData,
	type DeveloperReviewComment,
	type DeveloperReviewFinding,
	type FindingCounts,
	focusAgent,
	focusReturnWorkspace,
	getTaskViewport,
	type LocalChange,
	loadDashboard,
	loadDeveloperReviewFindings,
	loadLocalChanges,
	loadLocalDiff,
	loadVerifierFindings,
	loadVerifierReport,
	loadWikiSnapshotChanges,
	loadWikiSnapshotDiff,
	openFindingInEditor,
	openSpecArtifact,
	openSpecArtifacts,
	previewRepair,
	type RequiredUserActionItem,
	requiredUserActionFor,
	runWorkflow,
	saveDeveloperReview,
	savePlanReview,
	saveWikiReview,
	testDashboard,
	type WorkflowState,
} from "./data";
import { ChangedFilesView } from "./devenv-ui/components/ChangedFilesView";
import { DiffViewModal } from "./devenv-ui/components/DiffViewModal";
import { GenericModal } from "./devenv-ui/components/GenericModal";
import { MarkdownViewModal } from "./devenv-ui/components/MarkdownViewModal";
import type { Discussion } from "./devenv-ui/types";
import { notify } from "./notifications";
import { movePanel, type PanelDirection } from "./panel-grid";
import { applyTheme, loadThemeName, saveThemeName } from "./theme-settings";
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
import { HelpModal, type HelpSection } from "./ui/HelpModal";
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
import { watchDirectories } from "./watchRefresh";

/** Compact token count for the Agents panel metric line (1234 → 1.2k). */
function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
	return String(count);
}

/** Compose the presentation-only runtime/model label used in agent rows. */
export function agentRuntimeModelLine(
	runtime: string | undefined,
	model: string | undefined,
): string | undefined {
	const runtimeLabel = runtime
		? runtime === "opencode-v2"
			? "opencode2"
			: runtime
		: undefined;
	return runtimeLabel && model
		? `${runtimeLabel} · ${model}`
		: runtimeLabel || model || undefined;
}

/** One compact, fixed-order metric line per agent: cost, tokens in→out, cache
 * hit rate (cache-read / total prompt input), duration, tokens/s. Undefined when
 * the role recorded no metrics so the panel can omit the line entirely instead
 * of showing zero placeholders that could be mistaken for measured values. */
export function agentMetricLine(
	metrics: AgentUsageMetrics | undefined,
): string | undefined {
	if (!metrics) return undefined;
	const inputTokens = metrics.inputTokens;
	const cacheReadTokens = metrics.cacheReadTokens;
	const cacheWriteTokens = metrics.cacheWriteTokens;
	let cacheRate: number | undefined;
	if (
		inputTokens !== undefined &&
		cacheReadTokens !== undefined &&
		cacheWriteTokens !== undefined &&
		Number.isFinite(inputTokens) &&
		Number.isFinite(cacheReadTokens) &&
		Number.isFinite(cacheWriteTokens) &&
		inputTokens >= 0 &&
		cacheReadTokens >= 0 &&
		cacheWriteTokens >= 0
	) {
		const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		if (Number.isFinite(totalPromptTokens) && totalPromptTokens > 0) {
			const calculatedRate = (cacheReadTokens / totalPromptTokens) * 100;
			if (
				Number.isFinite(calculatedRate) &&
				calculatedRate >= 0 &&
				calculatedRate <= 100
			)
				cacheRate = Math.min(100, Math.max(0, calculatedRate));
		}
	}
	const parts = [
		...(metrics.cost !== undefined ? [`$${metrics.cost.toFixed(2)}`] : []),
		...(metrics.inputTokens !== undefined || metrics.outputTokens !== undefined
			? [
					`tok ${formatTokens(inputTokens ?? 0)}→${formatTokens(metrics.outputTokens ?? 0)}`,
				]
			: []),
		...(cacheRate !== undefined
			? [
					`${(cacheRate === 100 ? cacheRate : Math.floor(cacheRate * 10) / 10).toFixed(1)}%`,
				]
			: []),
		...(metrics.durationSeconds !== undefined
			? [formatDuration(metrics.durationSeconds)]
			: []),
		...(metrics.tokensPerSecond !== undefined
			? [`${metrics.tokensPerSecond} tok/s`]
			: []),
	];
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

export type PhaseStatusState = Pick<
	WorkflowState,
	"phase" | "stepId" | "stepLabel" | "status"
> & {
	runs: Array<Pick<WorkflowState["runs"][number], "stepId" | "status">>;
};

export function phaseStatus(state: PhaseStatusState) {
	const text = state.stepLabel ?? state.phase;
	const terminal = ["completed", "closed"].includes(state.status);
	const blocked =
		state.status === "attention-required" &&
		state.stepId !== undefined &&
		state.runs.some(
			(run) => run.stepId === state.stepId && run.status === "blocked",
		);
	return { text, working: !terminal, blocked };
}

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
	const [data, setData] = createSignal<DashboardData>(load());
	// Feed the shell's global header from the dashboard's single data source.
	createEffect(() => {
		props.onHeader?.({
			change: data().state.workflowId,
			phase: data().state.stepLabel ?? data().state.phase,
			branch: data().state.branch,
			updated: data().updated,
		});
	});
	const [_message, setMessage] = createSignal("");
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
	const artifacts = createMemo(() => openSpecArtifacts(data().state));
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
	const planRejectionReasons = [
		"Needs more detail",
		"Scope is not approved",
		"Requires design changes",
		"Reject proposal",
	];
	const [planRejectionOpen, setPlanRejectionOpen] = createSignal(false);
	const [planRejectionSelection, setPlanRejectionSelection] = createSignal(0);
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
	const submitQuestion = async (answer: {
		kind: "option" | "custom" | "cancel";
		value?: string;
	}) => {
		const question = pendingQuestion();
		if (!question || questionSubmitting()) return;
		if (answer.kind === "custom" && !answer.value?.trim()) {
			setMessage("Custom response cannot be empty");
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
				closeQuestion();
				refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setMessage(message);
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
				setMessage("Answer every question before submitting");
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
				closeQuestion();
				refresh();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				setMessage(message);
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
			closeQuestion();
			refresh();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setMessage(message);
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
	const [reviewOpen, setReviewOpen] = createSignal(false);
	const [reviewKind, setReviewKind] = createSignal<
		"developer" | "plan" | "wiki"
	>("developer");
	const [reviewView, setReviewView] = createSignal<"files" | "diff">("files");
	const [reviewChanges, setReviewChanges] = createSignal<LocalChange[]>([]);
	const [reviewChangeIndex, setReviewChangeIndex] = createSignal(0);
	const [reviewLine, setReviewLine] = createSignal(0);
	const [reviewDiff, setReviewDiff] = createSignal("");
	const [reviewComments, setReviewComments] = createSignal<
		DeveloperReviewComment[]
	>([]);
	const [reviewFindings, setReviewFindings] = createSignal<
		DeveloperReviewFinding[]
	>([]);
	const [selectedReviewFindingIds, setSelectedReviewFindingIds] = createSignal<
		Set<string>
	>(new Set());
	const [reviewCommentMode, setReviewCommentMode] = createSignal(false);
	const [reviewCommentText, setReviewCommentText] = createSignal("");
	const [reviewVisualMode, setReviewVisualMode] = createSignal(false);
	const [reviewVisualStart, setReviewVisualStart] = createSignal(0);
	const [reviewSourceRange, setReviewSourceRange] = createSignal<{
		start?: number;
		end?: number;
	}>({});
	const [reviewDiscussionLineIndices, setReviewDiscussionLineIndices] =
		createSignal<number[]>([]);
	const [reviewSelectableLineCount, setReviewSelectableLineCount] =
		createSignal(0);
	const [reviewSelectedLineFindingIds, setReviewSelectedLineFindingIds] =
		createSignal<string[]>([]);
	const [reviewSearchMode, setReviewSearchMode] = createSignal(false);
	const [reviewSearchQuery, setReviewSearchQuery] = createSignal("");
	const [reviewSplitView, setReviewSplitView] = createSignal<boolean | null>(
		null,
	);
	const reviewVisibleChanges = createMemo(() => {
		const query = reviewSearchQuery().toLowerCase();
		if (!query) return reviewChanges();
		return reviewChanges().filter((change) =>
			[change.newPath, change.oldPath].some((path) =>
				path?.toLowerCase().includes(query),
			),
		);
	});
	const reviewFile = () => reviewVisibleChanges()[reviewChangeIndex()];
	const reviewChangeForView = (change: LocalChange, diff = "") => ({
		old_path: change.oldPath ?? change.newPath,
		new_path: change.newPath,
		a_mode: "100644",
		b_mode: "100644",
		new_file: change.newFile,
		renamed_file: change.renamedFile,
		deleted_file: change.deletedFile,
		diff,
		lines_added: change.linesAdded,
		lines_deleted: change.linesDeleted,
		review_finding_count: reviewFindings().filter(
			(finding) =>
				finding.path === change.newPath || finding.path === change.oldPath,
		).length,
	});
	const reviewChangesForView = createMemo(() =>
		reviewVisibleChanges().map((change) => reviewChangeForView(change)),
	);
	// Lines available to the embedded ChangedFilesView list inside the popup:
	// GenericModal chrome (padding top/bottom + title + help footer) = 4,
	// ChangedFilesView chrome (stats header 2 + table header 1) = 3.
	// Mirrors GenericModal's own height calc (Math.floor(height * 0.75)).
	const reviewFilesAvailableLines = () =>
		Math.max(
			1,
			Math.min(dimensions().height, Math.floor(dimensions().height * 0.75)) -
				4 -
				3,
		);
	const reviewDiffFile = createMemo(() => {
		const file = reviewFile();
		return file ? reviewChangeForView(file, reviewDiff()) : undefined;
	});
	const reviewDiscussions = createMemo<Discussion[]>(() => [
		...reviewComments().map((comment, index) => {
			const position = {
				base_sha: "",
				start_sha: "",
				head_sha: "",
				old_path: comment.filePath,
				new_path: comment.filePath,
				position_type: "text",
				new_line: comment.line,
			};
			const note = {
				id: index + 1,
				type: "DiffNote",
				body: comment.body,
				author: {
					id: 0,
					username: "developer",
					name: "Developer",
					avatar_url: "",
				},
				created_at: new Date().toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
				position,
			};
			return {
				id: `local-${index}`,
				individual_note: true,
				notes: [note],
				position,
			};
		}),
		...reviewFindings()
			.filter((finding) => finding.path)
			.map((finding) => {
				const position = {
					base_sha: "",
					start_sha: "",
					head_sha: "",
					old_path: finding.path ?? "",
					new_path: finding.path ?? "",
					position_type: "text",
					new_line: finding.line ?? 1, // legacy artifacts may lack a line
				};
				const note = {
					id: 10000 + reviewFindings().indexOf(finding),
					type: "DiffNote",
					body: `${finding.detail}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
					author: {
						id: 0,
						username: "verifier",
						name: "Verifier",
						avatar_url: "",
					},
					created_at: new Date().toISOString(),
					updated_at: "",
					system: false,
					resolvable: false,
					resolved: selectedReviewFindingIds().has(finding.id),
					position,
				};
				return {
					id: `finding-${finding.id}`,
					individual_note: true,
					notes: [note],
					position,
					findingId: finding.originalId,
					findingSeverity: finding.severity,
				};
			}),
	]);
	const currentReviewDiscussions = createMemo(() => {
		const file = reviewFile()?.newPath;
		if (!file) return [];
		return reviewDiscussions().filter((discussion) => {
			const position = discussion.position ?? discussion.notes?.[0]?.position;
			return (
				!position || position.new_path === file || position.old_path === file
			);
		});
	});
	const cycleReviewComments = (direction: 1 | -1) => {
		const lines = reviewDiscussionLineIndices();
		if (!lines.length) return;
		const current = reviewLine();
		const next =
			direction > 0
				? (lines.find((line) => line > current) ?? lines[0])
				: ([...lines].reverse().find((line) => line < current) ?? lines.at(-1));
		if (next !== undefined) setReviewLine(next);
	};
	const filteredThemes = () =>
		themeNames.filter((name) => name.includes(themeQuery().toLowerCase()));
	const [helpOffset, setHelpOffset] = createSignal(0);
	const helpSections: HelpSection[] = [
		{
			title: "Navigation",
			items: [
				{ key: "Shift+J/K/H/L", description: "Move between panels" },
				{ key: "j/k or ↑/↓", description: "Scroll focused panel" },
				{ key: "Esc", description: "Return to dashboard workspace" },
			],
		},
		{
			title: "Actions",
			items: [
				{ key: "Enter", description: "Approve workflow gate" },
				{ key: "Enter", description: "Focus selected agent (Agents panel)" },
				{ key: "Shift+O", description: "Show safe repair guidance" },
				{ key: "v", description: "View selected verification agent's result" },
				{ key: "c", description: "View agent cost breakdown" },
				{ key: "r", description: "Refresh dashboard" },
				{ key: "q", description: "Quit" },
				{ key: "?", description: "Open help" },
			],
		},
	];
	const helpMaxOffset = () =>
		Math.max(
			0,
			helpSections.reduce(
				(count, section) => count + section.items.length + 1,
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
	const openDeveloperReview = () => {
		try {
			const changes =
				props.profile === "test"
					? [
							{
								newPath: "src/example.ts",
								linesAdded: 3,
								linesDeleted: 1,
								newFile: false,
								deletedFile: false,
								renamedFile: false,
							},
						]
					: loadLocalChanges(props.repo, props.workflowId);
			const findings =
				props.profile === "test"
					? [
							{
								id: "demo-run:demo-warning",
								originalId: "demo-warning",
								severity: "warning" as const,
								path: "src/example.ts",
								line: 2,
								detail: "Prefer const for immutable value.",
								fix: "Use const.",
							},
						]
					: loadDeveloperReviewFindings(props.repo, props.workflowId);
			setReviewChanges(changes);
			setReviewChangeIndex(0);
			setReviewLine(0);
			setReviewComments([]);
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewSourceRange({});
			setReviewDiscussionLineIndices([]);
			setReviewSelectableLineCount(0);
			setReviewSelectedLineFindingIds([]);
			setReviewSearchMode(false);
			setReviewSearchQuery("");
			setReviewSplitView(null);
			setReviewFindings(findings);
			setSelectedReviewFindingIds(new Set<string>());
			setReviewView("files");
			setReviewOpen(true);
			setReviewKind("developer");
			queueMicrotask(() =>
				props.keymap.setData("modal.active", "developer-review"),
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const openReviewDiff = () => {
		const file = reviewVisibleChanges()[reviewChangeIndex()];
		if (!file) return;
		try {
			setReviewDiff(
				props.profile === "test"
					? "diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,4 @@\n const value = 1;\n-old();\n+new();\n+reviewed();\n"
					: loadLocalDiff(props.repo, props.workflowId, file),
			);
			setReviewLine(0);
			setReviewView("diff");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const developerReviewPhase = () =>
		requiredUserAction()?.key === "developer-review";
	const finishDeveloperReview = async () => {
		if (busy()) return;
		// Finishing dispatches the workflow gate, so it is only meaningful while
		// the workflow actually waits in the developer review phase.
		if (!developerReviewPhase()) {
			notify(
				"Developer review can only be finished during the developer review phase",
				"warning",
			);
			return;
		}
		setBusy(true);
		setMessage("Finishing developer review…");
		setReviewFinishing(true);
		setReviewFinishingMessage(
			"Saving comments and dispatching developer review…",
		);
		try {
			// Yield one macrotask so the progress overlay paints before any
			// synchronous save/dispatch work begins.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const findingComments: DeveloperReviewComment[] = reviewFindings()
				.filter((finding) => selectedReviewFindingIds().has(finding.id))
				.map((finding) => ({
					filePath: finding.path ?? "repository",
					line: finding.line ?? 1,
					body: `${finding.detail}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
					findingId: finding.originalId,
				}));
			const comments = [...reviewComments(), ...findingComments];
			if (props.profile !== "test") {
				await saveDeveloperReview(props.repo, props.workflowId, comments);
				const engineComments = comments.map((comment) => ({
					comment: comment.body,
					...(comment.filePath ? { file: comment.filePath } : {}),
					...(comment.line ? { line: comment.line } : {}),
					...(comment.startLine ? { startLine: comment.startLine } : {}),
					...(comment.endLine ? { endLine: comment.endLine } : {}),
					...(comment.findingId ? { findingId: comment.findingId } : {}),
				}));
				setMessage(
					await runWorkflow(
						comments.length ? "review-comments" : "approve-review",
						props.repo,
						props.workflowId,
						data().state.revision,
						comments.length
							? JSON.stringify({ comments: engineComments })
							: undefined,
					),
				);
				refresh();
			} else {
				setMessage(
					comments.length
						? "Review comments sent to worker"
						: "Developer review passed",
				);
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReviewView("files");
			setReviewOpen(false);
			props.keymap.setData("modal.active", "none");
			setBusy(false);
			setReviewFinishing(false);
		}
	};
	const demoPlanArtifacts = () => [
		{
			newPath: "proposal.md",
			linesAdded: 4,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "design.md",
			linesAdded: 6,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "tasks.md",
			linesAdded: 5,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
		{
			newPath: "specs/workflow-engine-runtime/spec.md",
			linesAdded: 8,
			linesDeleted: 0,
			newFile: true,
			deletedFile: false,
			renamedFile: false,
		},
	];
	const demoPlanContent = (artifact: string) => {
		const demo = {
			"proposal.md":
				"# Proposal\n\nMake the plan review modal-based.\n\n## What changes\n- Artifact list popup.\n- Markdown review modal.",
			"design.md":
				"# Design\n\n## Context\n\nMirror the developer review gate.\n\n## Decisions\n\nD1: Engine comments outcome.\n\nD2: Planner review-fix mode.",
			"tasks.md":
				"# Tasks\n\n- [ ] Engine routing\n- [ ] Markdown modal\n- [ ] Planner instruction",
			"specs/workflow-engine-runtime/spec.md":
				"# Workflow engine runtime\n\n## ADDED Requirements\n\n### Requirement: Review comments route to the planner\n\nThe plan gate SHALL accept bounded review comments.\n\n#### Scenario: Comments return to planning\n\nWHEN the developer dispatches review-comments.\n\nTHEN the workflow transitions to planning with feedback.",
		} as Record<string, string>;
		return demo[artifact] ?? `# ${artifact}\n\nDemo artifact content.`;
	};
	const openPlanReview = () => {
		try {
			const wikiReview = requiredUserAction()?.key === "wiki-review";
			const changes: LocalChange[] = wikiReview
				? loadWikiSnapshotChanges(props.repo, props.workflowId)
				: props.profile === "test"
					? demoPlanArtifacts()
					: openSpecArtifacts(data().state).map((artifact) => {
							let linesAdded = 0;
							try {
								linesAdded = openSpecArtifact(data().state, artifact).split(
									/\r?\n/,
								).length;
							} catch {
								/* line count falls back to 0 when the artifact is unreadable */
							}
							return {
								newPath: artifact,
								linesAdded,
								linesDeleted: 0,
								newFile: true,
								deletedFile: false,
								renamedFile: false,
							};
						});
			setReviewKind(wikiReview ? "wiki" : "plan");
			setReviewChanges(changes);
			setReviewChangeIndex(0);
			setReviewLine(0);
			setReviewDiff("");
			setReviewComments([]);
			setReviewFindings([]);
			setSelectedReviewFindingIds(new Set<string>());
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewSourceRange({});
			setReviewDiscussionLineIndices([]);
			setReviewSelectableLineCount(0);
			setReviewSelectedLineFindingIds([]);
			setReviewSearchMode(false);
			setReviewSearchQuery("");
			setReviewSplitView(null);
			setReviewView("files");
			setReviewOpen(true);
			queueMicrotask(() => props.keymap.setData("modal.active", "plan-review"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const openPlanMarkdown = () => {
		const file = reviewVisibleChanges()[reviewChangeIndex()];
		if (!file) return;
		try {
			setReviewDiff(
				reviewKind() === "wiki"
					? loadWikiSnapshotDiff(props.repo, props.workflowId, file.newPath)
					: props.profile === "test"
						? demoPlanContent(file.newPath)
						: openSpecArtifact(data().state, file.newPath),
			);
			setReviewLine(0);
			setReviewView("diff");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const navigateReviewFile = (direction: 1 | -1) => {
		const previous = reviewChangeIndex();
		const total = reviewVisibleChanges().length;
		if (!total) return;
		const next = (previous + direction + total) % total;
		const file = reviewVisibleChanges()[next];
		if (!file) return;
		try {
			const content =
				reviewKind() === "wiki"
					? loadWikiSnapshotDiff(props.repo, props.workflowId, file.newPath)
					: reviewKind() === "plan"
						? props.profile === "test"
							? demoPlanContent(file.newPath)
							: openSpecArtifact(data().state, file.newPath)
						: props.profile === "test"
							? "diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,4 @@\n const value = 1;\n-old();\n+new();\n+reviewed();\n"
							: loadLocalDiff(props.repo, props.workflowId, file);
			setReviewChangeIndex(next);
			setReviewVisualMode(false);
			setReviewVisualStart(0);
			setReviewLine(0);
			setReviewDiff(content);
		} catch (error) {
			setReviewChangeIndex(previous);
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};
	const finishPlanReview = async () => {
		if (busy()) return;
		const wikiReview = requiredUserAction()?.key === "wiki-review";
		const saveReview = wikiReview ? saveWikiReview : savePlanReview;
		setBusy(true);
		setMessage(
			wikiReview ? "Finishing wiki review…" : "Finishing plan review…",
		);
		setReviewFinishing(true);
		setReviewFinishingMessage(
			wikiReview
				? "Saving comments and dispatching wiki review…"
				: "Saving comments and dispatching plan review…",
		);
		try {
			// Yield one macrotask so the progress overlay paints before any
			// synchronous save/dispatch work begins.
			await new Promise((resolve) => setTimeout(resolve, 0));
			const comments = reviewComments();
			if (props.profile !== "test") {
				await saveReview(props.repo, props.workflowId, comments);
				const engineComments = comments.map((comment) => ({
					comment: comment.body,
					...(comment.filePath ? { file: comment.filePath } : {}),
					...(comment.line ? { line: comment.line } : {}),
					...(comment.startLine ? { startLine: comment.startLine } : {}),
					...(comment.endLine ? { endLine: comment.endLine } : {}),
				}));
				setMessage(
					await runWorkflow(
						comments.length
							? "review-comments"
							: wikiReview
								? "approve-wiki"
								: "approve-plan",
						props.repo,
						props.workflowId,
						data().state.revision,
						comments.length
							? JSON.stringify({ comments: engineComments })
							: undefined,
					),
				);
				refresh();
			} else {
				if (comments.length) {
					setMessage("Plan review comments sent to planner");
				} else {
					setDemoIndex((index) => (index + 1) % demoPhases.length);
					setMessage("Plan approved");
				}
				refresh();
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReviewView("files");
			setReviewOpen(false);
			props.keymap.setData("modal.active", "none");
			setBusy(false);
			setReviewFinishing(false);
		}
	};
	const openPlanRejection = () => {
		setPlanRejectionSelection(0);
		setPlanRejectionOpen(true);
		queueMicrotask(() =>
			props.keymap.setData("modal.active", "plan-rejection"),
		);
	};
	const rejectPlan = async (reason: string) => {
		if (busy()) return;
		setBusy(true);
		setMessage("Rejecting plan…");
		try {
			if (props.profile === "test") setMessage("Plan rejected");
			else {
				await runWorkflow(
					"reject-plan",
					props.repo,
					props.workflowId,
					data().state.revision,
					JSON.stringify({ reason }),
				);
				refresh();
			}
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setPlanRejectionOpen(false);
			setReviewOpen(false);
			props.keymap.setData("modal.active", "none");
			setBusy(false);
		}
	};
	const handleReviewKey = (event: KeyEvent) => {
		const key = event.name.toLowerCase();
		if (reviewView() === "files" && reviewSearchMode()) {
			if (key === "escape") {
				setReviewSearchMode(false);
				setReviewSearchQuery("");
				setReviewChangeIndex(0);
			} else if (key === "enter" || key === "return") {
				setReviewSearchMode(false);
			} else if (key === "backspace" || key === "delete") {
				setReviewSearchQuery((query) => query.slice(0, -1));
				setReviewChangeIndex(0);
			} else if (
				event.sequence &&
				event.sequence.length === 1 &&
				event.sequence >= " "
			) {
				setReviewSearchQuery((query) => query + event.sequence);
				setReviewChangeIndex(0);
			}
			return true;
		}
		if (key === "escape") {
			if (reviewView() === "diff") {
				setReviewVisualMode(false);
				setReviewView("files");
			} else if (reviewSearchQuery()) {
				setReviewSearchQuery("");
				setReviewSearchMode(false);
				setReviewChangeIndex(0);
			} else {
				setReviewOpen(false);
				props.keymap.setData("modal.active", "none");
			}
		} else if (
			key === "r" &&
			reviewKind() === "plan" &&
			reviewView() === "files"
		) {
			openPlanRejection();
		} else if (key === "f" && !event.shift) {
			if (reviewKind() === "plan" || reviewKind() === "wiki")
				void finishPlanReview();
			else void finishDeveloperReview();
		} else if (
			reviewView() === "files" &&
			(key === "/" || event.sequence === "/")
		) {
			setReviewSearchMode(true);
			setReviewSearchQuery("");
			setReviewChangeIndex(0);
		} else if (reviewView() === "files" && (key === "j" || key === "down"))
			setReviewChangeIndex((index) =>
				Math.min(Math.max(0, reviewVisibleChanges().length - 1), index + 1),
			);
		else if (reviewView() === "files" && (key === "k" || key === "up"))
			setReviewChangeIndex((index) => Math.max(0, index - 1));
		else if (
			reviewView() === "files" &&
			(key === "enter" || key === "return")
		) {
			if (reviewKind() === "plan" || reviewKind() === "wiki")
				openPlanMarkdown();
			else openReviewDiff();
		} else if (reviewView() === "diff" && key === "v") {
			if (reviewVisualMode()) setReviewVisualMode(false);
			else {
				setReviewVisualStart(reviewLine());
				setReviewVisualMode(true);
			}
		} else if (reviewView() === "diff" && key === "n")
			cycleReviewComments(event.shift ? -1 : 1);
		else if (reviewView() === "diff" && (key === "[" || key === "]"))
			navigateReviewFile(key === "]" ? 1 : -1);
		else if (
			reviewView() === "diff" &&
			key === "s" &&
			(reviewKind() === "developer" || reviewKind() === "wiki")
		)
			setReviewSplitView((split) =>
				split === null ? dimensions().width < 160 : !split,
			);
		else if (reviewView() === "diff" && (key === "j" || key === "down"))
			setReviewLine((line) =>
				Math.min(Math.max(0, reviewSelectableLineCount() - 1), line + 1),
			);
		else if (reviewView() === "diff" && (key === "k" || key === "up"))
			setReviewLine((line) => Math.max(0, line - 1));
		else if (
			reviewView() === "diff" &&
			(key === "space" || key === " ") &&
			reviewKind() === "developer"
		) {
			const ids = reviewSelectedLineFindingIds();
			if (ids.length)
				setSelectedReviewFindingIds((selected) => {
					const next = new Set(selected);
					const select = ids.some((id) => !next.has(id));
					for (const id of ids) {
						if (select) next.add(id);
						else next.delete(id);
					}
					return next;
				});
		} else if (reviewView() === "diff" && key === "c") {
			const selectedRange = reviewSourceRange();
			if (
				reviewKind() === "wiki" &&
				(selectedRange.start === undefined || selectedRange.end === undefined)
			) {
				notify(
					"Snapshot context is not commentable; select a current document line",
					"warning",
				);
				return true;
			}
			setReviewCommentText("");
			setReviewCommentMode(true);
			props.keymap.setData("modal.active", "review-comment");
		}
		return true;
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
		if (
			data().state.phase === "fix" &&
			data().agents.find((agent) => agent.role === "worker")?.status !== "idle"
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
				content = openSpecArtifact(data().state, item.value);
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
		setMessage(`Running ${item.label}…`);
		try {
			if (props.profile === "test") {
				setDemoIndex((index) => (index + 1) % demoPhases.length);
				setMessage("Advanced dummy workflow");
			} else
				setMessage(
					await runWorkflow(
						workflowActionId(item.value),
						props.repo,
						props.workflowId,
						data().state.revision,
					),
				);
			refresh();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const refresh = () => {
		try {
			setData(load());
			setSelectedAgent((index) =>
				Math.min(index, Math.max(0, data().agents.length - 1)),
			);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		}
	};

	onMount(() => {
		// ponytail: 30s safety re-sync catches drift the watchers miss (e.g. a
		// directory that didn't exist yet); file watches give near-instant refresh.
		const dirs =
			props.profile === "test"
				? []
				: data().state.definition?.id === "research"
					? [join(wikiWorkflowDataRoot(), props.workflowId)]
					: [
							join(props.repo, ".herdr-workflow", props.workflowId),
							join(data().state.worktree, ".herdr-workflow", props.workflowId),
						];
		const dispose = watchDirectories(dirs, refresh);
		const safety = setInterval(refresh, 30000);
		onCleanup(() => {
			dispose();
			clearInterval(safety);
		});
	});

	const handleKey = async (key: KeyEvent) => {
		const trace = (msg: string) => {
			const target = process.env.AGENTIC_CODING_TRACE;
			if (target) {
				try {
					require("node:fs").appendFileSync(
						target,
						`${Date.now()} dash ${msg}\n`,
					);
				} catch {
					/* noop */
				}
			}
		};
		trace(
			`key=${key.name} modal.active=${props.keymap.getData?.("modal.active")}`,
		);
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
			try {
				const workspace = (
					props.profile === "test"
						? data()
						: loadDashboard(props.repo, props.workflowId)
				).state.returnWorkspace;
				if (!workspace)
					throw new Error(
						"No dashboard workspace recorded. Open this workflow from the overview first.",
					);
				focusReturnWorkspace(props.repo, props.workflowId, workspace);
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
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
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
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
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			}
			return;
		}
		if (name === "r") {
			refresh();
			setMessage("Refreshed");
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
						content: openSpecArtifact(data().state, artifact),
					});
					setVerdictOffset(0);
					props.keymap.setData("modal.active", "verdict");
				}
				return;
			}
			if (activePanel() === 2) {
				setVerdictRenderMarkdown(false);
				setVerdict({
					title: `Tasks · ${doneTasks()}/${data().tasks.length}`,
					content:
						data()
							.tasks.map(
								(task, index) =>
									`${task.done ? "✓" : "○"} ${index + 1}. ${task.text}`,
							)
							.join("\n") || "No tasks yet.",
				});
				setVerdictOffset(0);
				props.keymap.setData("modal.active", "verdict");
				return;
			}
			if (activePanel() === 1) {
				const agent = data().agents[selectedAgent()];
				if (!agent) return;
				try {
					const pane = data().state.panes[agent.role];
					if (!pane) return;
					focusAgent(data().state, pane);
				} catch (error) {
					setMessage(error instanceof Error ? error.message : String(error));
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
			setMessage(`Running ${approval.action}…`);
			try {
				if (props.profile === "test") {
					setDemoIndex((index) => (index + 1) % demoPhases.length);
					setMessage("Advanced dummy workflow");
				} else {
					setMessage(
						await runWorkflow(
							approval.action,
							props.repo,
							props.workflowId,
							data().state.revision,
						),
					);
				}
				refresh();
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error));
			} finally {
				setBusy(false);
			}
		}
	};
	onMount(() => {
		props.keymap.setData("app.view", "detail");
		props.keymap.setData("modal.active", "none");
		const disposeTheme = props.keymap.registerLayer({
			name: "theme",
			priority: 1100,
			activeModal: "theme",
			commands: [
				{
					name: "theme.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
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
							setMessage("Credential prompt cancelled");
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
								setMessage(`Repaired to ${target.label}: phase retriggered`);
							} catch (error) {
								setMessage(
									error instanceof Error ? error.message : String(error),
								);
								refresh();
							}
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
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
								setMessage("Action reason is required");
								return true;
							}
							setCompletedPicker(false);
							props.keymap.setData("modal.active", "none");
							setBusy(true);
							setMessage(`Running ${action.label}…`);
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
								.then(setMessage)
								.catch((error) =>
									setMessage(
										error instanceof Error ? error.message : String(error),
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
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
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
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
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
			bindings: ["escape", "j", "k", "up", "down"].map((key) => ({
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
								setMessage("Could not map selected line to file line.");
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
					run: ({ event }) => handleReviewKey(event),
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
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
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
					run: ({ event }) => handleReviewKey(event),
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
								try {
									openFindingInEditor(data().state, finding);
								} catch (error) {
									setVerdictReturnToFindings(true);
									setVerdictRenderMarkdown(false);
									setVerdict({
										title: "Editor launch failed",
										content:
											error instanceof Error ? error.message : String(error),
									});
									setVerdictOffset(0);
									props.keymap.setData("modal.active", "verdict");
								}
							}
						}
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
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
			bindings: ["escape", "j", "k", "d", "u", "up", "down"].map((key) => ({
				key,
				cmd: "verdict.handle",
			})),
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
				reviewCommentMode()
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
	const doneTasks = createMemo(
		() => data().tasks.filter((task) => task.done).length,
	);
	const taskViewport = createMemo(() => getTaskViewport(data().tasks));
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
										<Show
											when={data().gitStatus.available}
											fallback={
												<text fg={uiColors.warning}>
													UNAVAILABLE ·{" "}
													{data().gitStatus.diagnostic ??
														"git status unavailable"}
												</text>
											}
										>
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
											height: artifacts().length + 2,
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
												: agent.status === "done" || agent.status === "idle"
													? "positive"
													: agent.status === "blocked"
														? "warning"
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
						<box
							style={{
								width: "100%",
								height: 6,
								flexShrink: 0,
								flexDirection: "column",
							}}
						>
							<Panel
								title={`Current task · ${
									taskViewport().activePosition !== undefined
										? `task ${taskViewport().activePosition} of ${data().tasks.length}`
										: data().tasks.length === 0
											? "no tasks"
											: `all ${data().tasks.length} tasks complete`
								}`}
								accent={uiColors.success}
								active={activePanel() === 2}
								style={{
									width: "100%",
									height: 6,
								}}
							>
								<Show
									when={taskViewport().visibleTasks.length > 0}
									fallback={<text fg={uiColors.textMuted}>No tasks yet.</text>}
								>
									<For each={taskViewport().visibleTasks}>
										{(task, index) => {
											const active = () =>
												taskViewport().start + index() ===
												taskViewport().activeIndex;
											return (
												<box
													height={1}
													width="100%"
													backgroundColor={
														active() ? uiColors.bgSurface0 : uiColors.bgMantle
													}
												>
													<text
														fg={
															task.done
																? uiColors.success
																: active()
																	? uiColors.primary
																	: uiColors.textPrimary
														}
														attributes={active() ? TextAttributes.BOLD : 0}
													>
														{task.done ? "✓" : "○"}{" "}
														{taskViewport().start + index() + 1}. {task.text}
													</text>
												</box>
											);
										}}
									</For>
								</Show>
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
					sections={helpSections}
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
					onNavigateFile={(direction) => {
						const previous = reviewChangeIndex();
						try {
							const total = reviewVisibleChanges().length;
							if (!total) return;
							const next = (previous + direction + total) % total;
							const file = reviewVisibleChanges()[next];
							if (!file) return;
							setReviewChangeIndex(next);
							setReviewVisualMode(false);
							setReviewVisualStart(0);
							setReviewLine(0);
							setReviewDiff(
								reviewKind() === "wiki"
									? loadWikiSnapshotDiff(
											props.repo,
											props.workflowId,
											file.newPath,
										)
									: props.profile === "test"
										? demoPlanContent(file.newPath)
										: openSpecArtifact(data().state, file.newPath),
							);
						} catch (error) {
							setReviewChangeIndex(previous);
							setMessage(
								error instanceof Error ? error.message : String(error),
							);
						}
					}}
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
						onNavigateFile={(direction) => {
							const previous = reviewChangeIndex();
							try {
								const total = reviewVisibleChanges().length;
								if (!total) return;
								const next = (previous + direction + total) % total;
								const file = reviewVisibleChanges()[next];
								if (!file) return;
								const diff =
									props.profile === "test"
										? "diff --git a/src/example.ts b/src/example.ts\n@@ -1,2 +1,4 @@\n const value = 1;\n-old();\n+new();\n+reviewed();\n"
										: loadLocalDiff(props.repo, props.workflowId, file);
								setReviewChangeIndex(next);
								setReviewVisualMode(false);
								setReviewVisualStart(0);
								setReviewLine(0);
								setReviewDiff(diff);
							} catch (error) {
								setReviewChangeIndex(previous);
								setMessage(
									error instanceof Error ? error.message : String(error),
								);
							}
						}}
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
		</box>
	);
}

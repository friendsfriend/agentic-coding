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
	helpModalRowCount,
	Layout,
	modalHelpOpen,
	registerFocusRestorer,
	restoreFocus,
	setActiveKeybindCatalog,
	showErrorModal,
	themeNames,
	uiColors,
	useKeyDispatch,
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
import { createWorkflowSessionResolver } from "../../agent-host/workflow-session.ts";
import type { RequiredUserActionItem } from "../../contracts/actions.ts";
import type {
	DebugRequests,
	EvidenceEntry,
	EvidenceManifest,
} from "../../contracts/environment.ts";
import type { StageJournal } from "../../contracts/stages.ts";
import {
	type DashboardData,
	type DeveloperDialogueRecord,
	decodeWorkflowDefinitionGraph,
	resolveDeveloperQuestionOption,
} from "../../contracts/workflow.ts";
import { wikiWorkflowDataRoot } from "../../workflow/runtime.ts";
import { copyToClipboard } from "../clipboard.ts";
import { loadDebugRequests } from "../data/debug-requests.ts";
import {
	evidenceFileKey,
	loadEvidence,
	loadEvidenceFile,
	loadEvidenceText,
	loadStageJournal,
} from "../data/evidence.ts";
import { loadArtifact, loadArtifacts } from "../data/git.ts";
import {
	gatewayOrUndefined,
	invalidateKey,
	SupersededRead,
} from "../data/index.ts";
import {
	answerQuestion,
	applyRepair,
	loadDashboard,
	loadDashboardSeed,
	loadVerifierFindings,
	loadVerifierReport,
	mergeDashboardLive,
	previewRepair,
	requestExecution,
	runWorkflow,
} from "../data/workflow.ts";
import {
	loadPromptHistory,
	MAX_PROMPT_HISTORY,
	savePromptHistory,
} from "../shared/preferences.ts";
import {
	createAgentActivitySource,
	watchAgentActivity,
} from "./agent-activity.ts";
import {
	focusDashboardAgent,
	focusedAgentPosition,
	indexDashboardAgents,
} from "./agent-navigation.ts";
import {
	createAgentSessionProjection,
	streamAgentSessionProjection,
	submissionStateNote,
} from "./agent-session.ts";
import { openDebugRequestReport } from "./debug-requests-open.ts";
import {
	type DebugRequestsReadState,
	debugRequestsKeyAction,
} from "./debug-requests-panel.ts";
import { testDashboard } from "./demo.ts";
import {
	evidenceLocalPath,
	openEvidenceExternally,
	openStageFlowExternally,
} from "./evidence-open.ts";
import {
	type EvidenceReadState,
	evidencePanelLines,
	evidenceReportEntry,
	evidenceRows,
} from "./evidence-panel.ts";
import { evidenceCitedImages, inlineImagePreview } from "./evidence-report.ts";
import {
	createDashboardKeyHandler,
	createEvidenceSubviewKeyHandler,
	EVIDENCE_VIEW_KEYS,
} from "./handlers/keys.ts";
import {
	agentSessionKeybindCatalog,
	dashboardDetailKeybindCatalog,
	evidenceSubviewKeybindCatalog,
	panelContext,
	stagePlanReviewKeybindCatalog,
	stagePlanReviewKeybindsForView,
	stageReportReviewKeybindCatalog,
	stageReportReviewKeybindsForView,
} from "./keybinds.ts";
import {
	onWorkflowExecutionError,
	onWorkflowExecutionProgress,
	onWorkflowExecutionSettled,
	openSpecArtifact,
	openSpecArtifacts,
	PRESET_CONFIG_DEFAULTS,
	presetCatalog,
	serverOwnsExecutionEvents,
	subscribeDataEvents,
	switchWorkflowPreset,
} from "./live.ts";
import { Overlays } from "./modals/Overlays.tsx";
import { workflowGraphRows } from "./modals/WorkflowGraphModal.tsx";
import { notify } from "./notifications.ts";
import { openFindingInEditor } from "./open-finding.ts";
import {
	AGENTS_PANEL,
	CLASSIFIER_PANEL,
	EVIDENCE_PANEL,
} from "./panel-grid.ts";
import { panelPointerHandlers } from "./panel-pointer.ts";
import { AgentsPanel } from "./panels/AgentsPanel.tsx";
import { ChangePanel } from "./panels/ChangePanel.tsx";
import { ClassifierPanel } from "./panels/ClassifierPanel.tsx";
import { EvidencePanel } from "./panels/EvidencePanel.tsx";
import { OpenSpecPanel } from "./panels/OpenSpecPanel.tsx";
import {
	agentMetricLine,
	agentRuntimeModelLine,
	approvalFor,
	artifactSurfaceLabel,
	classificationEntries,
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
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "./ui/AgentSessionView.tsx";
import { pendingCredentialRequest } from "./ui/CredentialsModal.tsx";
import {
	type EvidenceReportState,
	EvidenceSubview,
} from "./ui/EvidenceSubview.tsx";
import type { FindingEvent } from "./ui/FindingsModal.tsx";
import {
	debounce,
	REFRESH_MIN_INTERVAL_MS,
	seedThenHydrate,
	startSafetyResync,
	throttle,
	watchDirectories,
} from "./watchRefresh.ts";

export { PhaseStatus } from "./ui/PhaseStatus.tsx";
export type { PhaseStatusState };
// Projection helpers are owned by `projections.ts`; these narrow re-exports
// keep the public dashboard root surface (and its renderer tests) stable.
export { agentMetricLine, agentRuntimeModelLine, phaseStatus };

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
	/** A shell-owned overlay (theme picker, location picker, new-workflow form,
	 * delete confirmation) holds the keyboard. Keymap-only, so the dashboard's
	 * inputs must blur themselves rather than keep reading keys behind it. */
	overlay?: () => boolean;
	/** One-shot exact run navigation request from the shell's agent index. */
	agentRunId?: string;
	agentRequestId?: string;
	onAgentRunRequestConsumed?: (requestId: string) => void;
	/** Composition-root Escape boundary: true when the root handled it. Inside
	 * the unified shell the root leaves the workflow page for its structural
	 * parent (Home); a standalone dashboard leaves it unset and Escape no-ops. */
	onBack?: () => boolean;
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
						verificationRound: 0,
						runs: [],
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
	const agentIndex = createMemo(() => indexDashboardAgents(data()));
	const panels = createPanelState();
	const focusedAgentRunId = panels.focusedAgentRunId;
	const setFocusedAgentRunId = panels.setFocusedAgentRunId;
	const agentPanelData = createMemo(() =>
		focusDashboardAgent(data(), agentIndex(), focusedAgentRunId()),
	);
	const historicalAgentRunId = () => {
		const runId = focusedAgentRunId();
		return runId &&
			agentIndex().runsById.has(runId) &&
			!agentIndex().positionsByRunId.has(runId)
			? runId
			: undefined;
	};
	let refreshGeneration = 0;
	let refreshRunning = false;
	// The test profile and an explicit fixture are already the full observation;
	// a live view starts from the cheap seed and hydrates below. The Agents panel
	// reads this to keep provisional seed statuses and verifier verdicts off
	// screen until the authoritative observation lands.
	const [dashboardLoaded, setDashboardLoaded] = createSignal(
		props.profile === "test" || props.testData !== undefined,
	);
	let refreshQueued = false;
	// A queued refresh must keep the force flag: a safety resync that arrives
	// while a read is in flight still has to bypass the cache when it runs.
	let refreshForceQueued = false;
	let refreshDisposed = false;
	let refreshController: AbortController | undefined;
	let liveGeneration = 0;
	let liveController: AbortController | undefined;
	let refreshReviewFiles: ((force?: boolean) => void) | undefined;
	// The last observation failure surfaced in the error modal. A persistent
	// failure must not reopen the modal on every refresh (watchDirectories
	// refreshes on each workflow file change); clearing on success re-arms it.
	let lastRefreshError: string | undefined;
	const [busy, setBusy] = createSignal(false);
	// Dedicated review-finishing signal (in addition to the busy guard): scopes
	// the progress overlay to review finishes instead of every busy action.
	const [reviewFinishing, setReviewFinishing] = createSignal(false);
	const [reviewFinishingMessage, setReviewFinishingMessage] = createSignal("");
	let changeScroll: ScrollBoxRenderable | undefined;
	const activePanel = panels.active;
	const setActivePanel = panels.setActive;
	const selectedAgent = panels.agent;
	const setSelectedAgent = panels.setAgent;
	const selectedArtifact = panels.artifact;
	const setSelectedArtifact = panels.setArtifact;
	const selectedDecision = panels.decision;
	const setSelectedDecision = panels.setDecision;
	const selectedEvidence = panels.evidence;
	const setSelectedEvidence = panels.setEvidence;
	// Pointer parity (`tui-mouse-interaction`): a tap focuses the panel the way
	// `J/K/H/L` does, and activating a row dispatches the key the panel's own
	// `Enter` binding maps to, so the keymap keeps deciding what is available and
	// no panel needs a second activation table. The grid is mounted behind the
	// agent-session page, so a hidden panel never takes a focus request.
	const dispatchKey = useKeyDispatch();
	const { focusPanelFromPointer, activatePanelRow } = panelPointerHandlers({
		setActivePanel,
		dispatchKey,
		// Read lazily: the agent-session page's signal is declared further down.
		agentSessionOpen: () => agentSessionOpen(),
	});

	const artifacts = panels.artifacts;
	const setArtifacts = panels.setArtifacts;
	let artifactGeneration = 0;
	let artifactRevision: string | undefined;
	let artifactReadAt = 0;
	let artifactController: AbortController | undefined;
	createEffect(() => {
		const state = data().state;
		if (props.profile === "test") {
			setArtifacts(openSpecArtifacts(state));
			return;
		}
		// The observation invalidates its caches on every event, but this panel
		// does not need a filesystem read on every effect commit. A new workflow
		// revision reads immediately; otherwise the five-second safety resync is
		// the next authoritative look, which also catches an out-of-band edit.
		const revision = `${state.workflowId}:${state.revision}`;
		if (revision === artifactRevision && Date.now() - artifactReadAt < 5_000)
			return;
		const readAt = Date.now();
		const generation = ++artifactGeneration;
		artifactController?.abort();
		artifactController = new AbortController();
		void loadArtifacts(state, artifactController.signal, {
			refresh: true,
		})
			.then((next) => {
				if (next && generation === artifactGeneration) {
					setArtifacts(next);
					artifactRevision = revision;
					artifactReadAt = readAt;
				}
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
	// The delegated debug requests the workflow asked for, and what came back
	// (add-debug-subagent-requests). One read per dashboard refresh: a finished
	// request is worth seeing without a manual refresh, and the dialog is
	// read-only.
	const [debugRequests, setDebugRequests] = createSignal<
		DebugRequests | undefined
	>(undefined);
	const [debugRequestsState, setDebugRequestsState] =
		createSignal<DebugRequestsReadState>("loading");
	const [debugRequestsError, setDebugRequestsError] = createSignal<
		string | undefined
	>(undefined);
	let debugRequestsGeneration = 0;
	let debugRequestsController: AbortController | undefined;
	let lastDebugRequestsError: string | undefined;
	// The open workflow's evidence: the manifest the panel lists, the selected
	// entry's bytes when the terminal can render them, and the local path
	// `Enter`/`y` act on.
	const [evidence, setEvidence] = createSignal<EvidenceManifest>({
		workflowId: props.workflowId,
		entries: [],
		bytes: 0,
		quotaBytes: 0,
	});
	/** What the manifest read is doing. The panel shows the neutral empty state
	 * only for a read that actually succeeded with no entries. */
	const [evidenceState, setEvidenceState] =
		createSignal<EvidenceReadState>("loading");
	const [evidenceError, setEvidenceError] = createSignal<string | undefined>(
		undefined,
	);
	let evidenceGeneration = 0;
	let evidenceController: AbortController | undefined;
	let lastEvidenceError: string | undefined;
	/** The workflow's stage flow journal (`add-stage-flow-evidence`). `empty` is
	 * an answer — the workflow ran no stage flow — and it is what keeps the panel
	 * rendering exactly as it did before the journal existed. */
	const [stageJournal, setStageJournal] = createSignal<
		StageJournal | undefined
	>(undefined);
	let stageJournalGeneration = 0;
	let stageJournalController: AbortController | undefined;
	let lastStageJournalError: string | undefined;
	/** The evidence subview page: a page of the dashboard body exactly like the
	 * agent session, so it takes the keyboard through its own keymap field
	 * (`evidence.view`) instead of a dialog (`evidence-summary-subview`). */
	const [evidenceView, setEvidenceView] = createSignal<"none" | "open">("none");
	const evidenceViewOpen = () => evidenceView() === "open";
	let evidenceSubviewScrollbox: ScrollBoxRenderable | undefined;
	/** The report the subview renders: the newest flagged entry, or none. Its text
	 * and the bytes of the screenshots it cites are read only while the view is
	 * open — the panel is a summary and spends no file read on a refresh. */
	const [reportText, setReportText] = createSignal<string | undefined>(
		undefined,
	);
	const [reportState, setReportState] =
		createSignal<EvidenceReportState>("none");
	const [reportError, setReportError] = createSignal<string | undefined>(
		undefined,
	);
	const [reportImages, setReportImages] = createSignal<
		Readonly<Record<string, Uint8Array>>
	>({});
	let reportGeneration = 0;
	let reportController: AbortController | undefined;
	let reportTextId: string | undefined;
	let reportImageIds: string[] = [];
	let reportImageGeneration = 0;
	let reportImageController: AbortController | undefined;
	/** Kitty graphics support is the renderer's own capability probe: the report
	 * never sniffs `$TERM`, and an unanswered probe means no inline image. The
	 * probe itself is not reactive, so it is read into a signal — and re-read when
	 * the dashboard changes, which is what lets the view follow a capability that
	 * settled after the first paint. */
	const [kittyGraphics, setKittyGraphics] = createSignal(
		inlineImagePreview(renderer.capabilities),
	);
	createEffect(() => {
		data();
		setKittyGraphics(inlineImagePreview(renderer.capabilities));
	});
	/** The subview's sidebar rows: the flow grouping when the workflow recorded a
	 * stage flow, the debug-request grouping otherwise. */
	const evidenceListRows = createMemo(() =>
		evidenceRows(evidence().entries, stageJournal()),
	);
	/** The panel's height: one summary line, or the title row alone while the run
	 * has attached nothing. */
	const evidencePanelHeight = () =>
		evidencePanelLines({
			entries: evidence().entries.length,
			state: evidenceState(),
		});
	/** One entry's local path, or `undefined` when it has none — the shared
	 * lookup the sidebar's detail rows and the report's image fallback read. */
	const evidencePathOf = (entry: EvidenceEntry): string | undefined => {
		try {
			return evidenceLocalPath(data().state, entry);
		} catch {
			// An unaddressable workflow id: the row shows metadata without a path.
			return undefined;
		}
	};
	const reportEntry = createMemo(() => evidenceReportEntry(evidence().entries));
	// The manifest read follows every dashboard refresh: attaching evidence does
	// not bump the workflow revision, and a workflow event drops the cached
	// manifest, so a forced read is what keeps the panel from missing an entry
	// written mid-refresh.
	createEffect(() => {
		data();
		if (props.profile === "test" || !gatewayOrUndefined()) {
			// The demo fixture carries no evidence, so the listing is empty rather
			// than eternally loading; a transport that is not installed yet keeps the
			// loading state that the next dashboard read settles.
			if (props.profile === "test") setEvidenceState("ready");
			return;
		}
		const generation = ++evidenceGeneration;
		evidenceController?.abort();
		evidenceController = new AbortController();
		void loadEvidence(props.repo, props.workflowId, evidenceController.signal, {
			refresh: true,
		})
			.then((next) => {
				if (!next || generation !== evidenceGeneration) return;
				setEvidence(next);
				setEvidenceState("ready");
				setEvidenceError(undefined);
				lastEvidenceError = undefined;
			})
			.catch((error) => {
				if (generation !== evidenceGeneration) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				// A read that failed is not "no evidence attached": the panel says so
				// and the developer hears about it once per distinct failure.
				const message = error instanceof Error ? error.message : String(error);
				setEvidenceState("error");
				setEvidenceError(message);
				traceTui(
					"tui.dashboard.evidence",
					{ surface: "dashboard", action: "evidence" },
					"error",
				);
				if (message !== lastEvidenceError) {
					lastEvidenceError = message;
					notify(`Evidence could not be read: ${message}`, "error");
				}
			});
	});
	// The stage flow journal follows the same refresh: a run writes steps while it
	// works, and the panel's flow grouping and its open-flow action both depend on
	// it. A failed read leaves the manifest's own grouping in place rather than
	// tearing the panel down.
	createEffect(() => {
		data();
		if (props.profile === "test" || !gatewayOrUndefined()) return;
		const generation = ++stageJournalGeneration;
		stageJournalController?.abort();
		stageJournalController = new AbortController();
		void loadStageJournal(
			props.repo,
			props.workflowId,
			stageJournalController.signal,
			{ refresh: true },
		)
			.then((next) => {
				if (generation !== stageJournalGeneration) return;
				setStageJournal(next);
				lastStageJournalError = undefined;
			})
			.catch((error) => {
				if (generation !== stageJournalGeneration) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				// The panel falls back to its request grouping either way, but a
				// journal that exists and cannot be read is not a workflow that ran no
				// stage flow: the flow silently disappearing would look like the run
				// never recorded one, so the developer hears it once per distinct
				// failure.
				const message = error instanceof Error ? error.message : String(error);
				setStageJournal(undefined);
				if (message !== lastStageJournalError) {
					lastStageJournalError = message;
					notify(`Stage flow journal could not be read: ${message}`, "error");
				}
			});
	});
	// The delegated debug request read follows every dashboard refresh, exactly
	// like the evidence manifest: a request is created and finished by other
	// runs, so a workflow event is what drops the cached listing.
	createEffect(() => {
		data();
		if (props.profile === "test" || !gatewayOrUndefined()) {
			if (props.profile === "test") setDebugRequestsState("ready");
			return;
		}
		const generation = ++debugRequestsGeneration;
		debugRequestsController?.abort();
		debugRequestsController = new AbortController();
		void loadDebugRequests(
			props.repo,
			props.workflowId,
			debugRequestsController.signal,
			{ refresh: true },
		)
			.then((next) => {
				if (generation !== debugRequestsGeneration) return;
				setDebugRequests(next);
				setDebugRequestsState("ready");
				setDebugRequestsError(undefined);
			})
			.catch((error) => {
				if (generation !== debugRequestsGeneration) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				setDebugRequestsState("error");
				const message = error instanceof Error ? error.message : String(error);
				setDebugRequestsError(message);
				// A failed read must not leave a stale list looking live: it is
				// reported once per distinct failure, like the evidence read.
				if (message !== lastDebugRequestsError) {
					lastDebugRequestsError = message;
					notify(`Debug requests could not be read: ${message}`, "error");
				}
			});
	});
	// The run's report, read when the subview opens and again when the manifest's
	// newest flagged entry changes. A report's bytes are immutable once written, so
	// re-opening the same report is a cache hit rather than a second read; the
	// settled id is what keeps this effect from looping on its own signals.
	let reportSettledId: string | undefined;
	createEffect(() => {
		const entry = evidenceViewOpen() ? reportEntry() : undefined;
		const id = entry?.id;
		if (id === reportSettledId) return;
		reportSettledId = id;
		const generation = ++reportGeneration;
		reportController?.abort();
		// The bytes of a report this page no longer shows are dropped with it: closing
		// the view (or moving to another report) leaves nothing resident, and the
		// immutable file is re-read if the page shows it again.
		if (reportTextId !== undefined && reportTextId !== id) {
			invalidateKey(
				evidenceFileKey(props.repo, props.workflowId, reportTextId),
			);
			reportTextId = undefined;
		}
		reportTextId = id;
		setReportText(undefined);
		setReportError(undefined);
		if (id === undefined) {
			// No flagged entry is a fact, not a pending read: the subview says the run
			// attached no report instead of loading forever.
			setReportState("none");
			return;
		}
		setReportState("loading");
		if (props.profile === "test" || !gatewayOrUndefined()) {
			setReportState("absent");
			return;
		}
		reportController = new AbortController();
		void loadEvidenceText(
			props.repo,
			props.workflowId,
			id,
			reportController.signal,
			// A completion the cache dropped because the key moved on is not the
			// gateway's "the file is gone": reject it so the two answers stay
			// distinguishable instead of painting a failure for a readable report.
			{ superseded: "reject" },
		)
			.then((text) => {
				if (generation !== reportGeneration) return;
				// A file the gateway answers as gone is not still loading, and the answer
				// is cached, so the retry has to drop both the settled id and the key.
				if (text === undefined) {
					reportSettledId = undefined;
					invalidateKey(evidenceFileKey(props.repo, props.workflowId, id));
					setReportState("absent");
					return;
				}
				setReportText(text);
				setReportState("ready");
			})
			.catch((error) => {
				if (generation !== reportGeneration) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				if (error instanceof SupersededRead) {
					// The key moved on while the read was in flight, so the answer was
					// dropped before it was ever an answer: stay pending and let the next run
					// read it again rather than report a report that exists as missing.
					reportSettledId = undefined;
					return;
				}
				// A report that cannot be read stays retriable: the failure is reported
				// once and the next open reads it again.
				reportSettledId = undefined;
				setReportError(error instanceof Error ? error.message : String(error));
				setReportState("error");
				traceTui(
					"tui.dashboard.evidence.report",
					{ surface: "dashboard", action: "evidence-report" },
					"error",
				);
			});
	});
	/**
	 * Read one cited screenshot, allowing one second attempt when the cache dropped
	 * the first answer because the key moved on — an event gap, a reconnect or a
	 * cleared cache is not the gateway's "the file is gone". Without it a present,
	 * readable picture is painted as its caption for the rest of the open, which is
	 * exactly the state the report text already recovers from. Bounded at one retry
	 * per id per read, so a cache that keeps clearing cannot spin.
	 */
	const readCitedImage = async (
		id: string,
		signal: AbortSignal,
	): Promise<Uint8Array | undefined> => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const bytes = await loadEvidenceFile(
					props.repo,
					props.workflowId,
					id,
					signal,
					{ superseded: "reject" },
				);
				// The gateway's own `undefined` is an absent file: the cached answer is
				// dropped so the next open asks again rather than being served it.
				if (bytes === undefined)
					invalidateKey(evidenceFileKey(props.repo, props.workflowId, id));
				return bytes;
			} catch (error) {
				if (!(error instanceof SupersededRead)) throw error;
			}
		}
		// Two dropped answers: the caption carries this open instead of a loop.
		return undefined;
	};
	// The screenshots the open report cites, read only for a terminal the renderer
	// says can draw them: a cited image is bytes the reader has to be able to see,
	// and a fallback line costs no read. The set is diffed against the previous one
	// so a report edit drops the bytes it no longer cites.
	createEffect(() => {
		const text = reportText();
		const cited =
			evidenceViewOpen() && kittyGraphics() && reportState() === "ready"
				? text === undefined
					? []
					: evidenceCitedImages(text, evidence().entries).map(
							(entry) => entry.id,
						)
				: [];
		const nextIds = cited.join(",");
		if (nextIds === reportImageIds.join(",")) return;
		const previous = reportImageIds;
		reportImageIds = cited;
		const generation = ++reportImageGeneration;
		reportImageController?.abort();
		// Only what is still cited stays resident: a closed report leaves no picture
		// bytes cached behind it.
		const kept: Record<string, Uint8Array> = {};
		for (const id of cited) {
			const bytes = reportImages()[id];
			if (bytes !== undefined) kept[id] = bytes;
		}
		setReportImages(kept);
		for (const id of previous)
			if (!cited.includes(id))
				invalidateKey(evidenceFileKey(props.repo, props.workflowId, id));
		const missing = cited.filter((id) => kept[id] === undefined);
		if (missing.length === 0) return;
		if (props.profile === "test" || !gatewayOrUndefined()) return;
		reportImageController = new AbortController();
		const signal = reportImageController.signal;
		void Promise.all(
			missing.map(
				async (id) => [id, await readCitedImage(id, signal)] as const,
			),
		)
			.then((loaded) => {
				if (generation !== reportImageGeneration) return;
				const next: Record<string, Uint8Array> = { ...kept };
				for (const [id, bytes] of loaded)
					if (bytes !== undefined) next[id] = bytes;
				setReportImages(next);
			})
			.catch((error) => {
				if (generation !== reportImageGeneration) return;
				if (error instanceof DOMException && error.name === "AbortError")
					return;
				// An unreadable picture falls back to its caption and path; the next open
				// retries it instead of pinning an empty frame.
				reportImageIds = [];
				traceTui(
					"tui.dashboard.evidence.images",
					{ surface: "dashboard", action: "evidence-images" },
					"error",
				);
			});
	});
	/** Open the evidence subview. The panel keeps its selection so reopening lands
	 * where the reader left it, and the keymap field is what hands the keyboard
	 * over from the grid. */
	const openEvidenceView = () => {
		setEvidenceView("open");
		props.keymap.setData("evidence.view", "open");
	};
	/** Leave the view for the dashboard grid: the manifest stays loaded and the
	 * selection stays put, so returning is a repaint rather than a read. */
	const backEvidenceView = () => {
		setEvidenceView("none");
		props.keymap.setData("evidence.view", "none");
	};
	// The dashboard body is one instance per workflow page, so the bytes it read
	// are dropped with it: a browsing session leaves nothing resident, and they are
	// immutable and re-readable if the page is opened again.
	onCleanup(() => {
		if (reportTextId !== undefined)
			invalidateKey(
				evidenceFileKey(props.repo, props.workflowId, reportTextId),
			);
		for (const id of reportImageIds)
			invalidateKey(evidenceFileKey(props.repo, props.workflowId, id));
	});
	const openEvidence = async (entry: EvidenceEntry) => {
		try {
			await openEvidenceExternally(data().state, entry);
		} catch (error) {
			notify(
				`Could not open evidence: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"error",
			);
		}
	};
	const copyEvidencePath = (entry: EvidenceEntry) => {
		let file: string;
		try {
			file = evidenceLocalPath(data().state, entry);
		} catch {
			notify("Evidence has no local path", "error");
			return;
		}
		if (copyToClipboard(file)) notify(`Copied ${file}`, "success");
		else notify("Copy failed", "error");
	};
	/** Open `stage-flow.html` with the system opener. A workflow without a journal
	 * has no page, which is reported rather than opening a stale one. */
	const openEvidenceFlow = async () => {
		const journal = stageJournal();
		if (journal?.flowPage === undefined) {
			notify("This workflow has no stage flow page", "info");
			return;
		}
		try {
			await openStageFlowExternally(data().state, journal.flowPage);
		} catch (error) {
			notify(
				`Could not open the stage flow: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"error",
			);
		}
	};
	// Every classification the workflow recorded, in the order it happened:
	// model-pool routing, verifier-role triage, stage gates, and the per-file
	// judgment sweep. The panel, its keybinds, and Enter all read this one list.
	const classifications = createMemo(() => classificationEntries(data().state));
	createEffect(() =>
		panels.clamp({
			agents: agentPanelData().agents.length,
			artifacts: artifacts().length,
			classifications: classifications().length,
			// The rows the panel paints, not the manifest's entries: a stage flow
			// lists a row per journal step too, and clamping by the shorter list would
			// snap the selection back to the top on every dashboard refresh — making
			// exactly the step rows this change exists to show unselectable.
			evidence: evidenceListRows().length,
		}),
	);
	const requiredUserAction = createMemo(() =>
		requiredUserActionFor(
			data().state.phase,
			data().state.prCreated,
			artifacts(),
			data().state.definition?.id,
			data().state.availableActions,
			data().state.stepContext,
		),
	);
	const [userActionOpen, setUserActionOpen] = createSignal(false);
	let promptedUserActionKey: string | undefined;
	// Opt-in Markdown rendering for the OpenSpec artifact view only (D5).
	const overlays = createOverlayState({
		themeIndex: Math.max(0, themeNames.indexOf(loadThemeName())),
		promptHistory: loadPromptHistory(),
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
	const setWorkflowGraphOffset = overlays.setWorkflowGraphOffset;
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
	const debugRequestsSelection = overlays.debugRequestsSelection;
	const setDebugRequestsSelection = overlays.setDebugRequestsSelection;
	const debugRequestsOffset = overlays.debugRequestsOffset;
	const setDebugRequestsOffset = overlays.setDebugRequestsOffset;
	const presetSwitcherHandler = overlays.presetSwitcherHandler;
	const setPresetSwitcherHandler = overlays.setPresetSwitcherHandler;
	const presetSwitcherChoices = overlays.presetSwitcherChoices;
	const setPresetSwitcherChoices = overlays.setPresetSwitcherChoices;
	const agentSession = overlays.agentSession;
	const setAgentSession = overlays.setAgentSession;
	const agentSessionOpen = overlays.agentSessionOpen;
	const setAgentSessionOpen = overlays.setAgentSessionOpen;
	const setAgentSessionBlocks = overlays.setAgentSessionBlocks;
	const agentSessionBlocks = overlays.agentSessionBlocks;
	const agentSessionDraft = overlays.agentSessionDraft;
	const agentSessionMetadata = overlays.agentSessionMetadata;
	const agentSessionContextWindows = overlays.agentSessionContextWindows;
	const setAgentSessionMetadata = overlays.setAgentSessionMetadata;
	const setAgentSessionDraft = overlays.setAgentSessionDraft;
	/** Local transcript notices the host's documents cannot carry: today, an
	 * aborted manual compaction (no summary is placed, and only the client that
	 * requested the abort knows one was in flight). */
	const agentSessionNotices = overlays.agentSessionNotices;
	const setAgentSessionNotices = overlays.setAgentSessionNotices;
	// Live session watch (add-pi-durable-runtime, dashboard-agent-session-view):
	// at most one subscription at a time, torn down whenever the open session
	// changes identity or the dashboard unmounts (going back to the grid keeps
	// it streaming). `HostClient` is dynamically imported so no dashboard route
	// eagerly loads the durable-agent-host module.
	let agentSessionStopWatch: (() => void) | undefined;
	// The transcript projection of the frame the watch last delivered: the newest
	// window is published on arrival and the older entries fill in on idle turns
	// (see `projectAgentSessionTranscript`). A no-op until a frame starts one, so
	// every teardown path can call it without a guard.
	let agentSessionStopProjection: () => void = () => {};
	let agentSessionGeneration = 0;
	const stopAgentSessionWatch = (): void => {
		// Invalidate pending imports and callbacks as well as an installed watch.
		agentSessionGeneration += 1;
		agentSessionStopWatch?.();
		agentSessionStopWatch = undefined;
		agentSessionStopProjection();
	};
	onCleanup(stopAgentSessionWatch);
	// The transcript scroll box, owned by the view and scrolled by the
	// agent-session keymap layer registered below.
	let agentSessionScrollbox: ScrollBoxRenderable | undefined;
	// The `/model` and `/thinking` picker catalogs, fetched once per open
	// session from the host that will actually run the choice.
	const agentSessionModels = overlays.agentSessionModels;
	const setAgentSessionModels = overlays.setAgentSessionModels;
	const agentSessionThinkingLevels = overlays.agentSessionThinkingLevels;
	const setAgentSessionThinkingLevels = overlays.setAgentSessionThinkingLevels;
	const setAgentSessionContextWindows = overlays.setAgentSessionContextWindows;
	// The view's picker key handler while a picker is open; the
	// `agent-session-picker` keymap layer delegates to it.
	let agentSessionPickerHandler: ((event: KeyEvent) => boolean) | undefined;
	// Live per-agent activity (agents-panel-live-activity): one host watch per
	// durable run, reconciled with the agent list the dashboard reads. The watch
	// is the "what is it doing right now" the workflow store cannot give, so the
	// Agents panel badge tracks the running tool instead of waiting for the
	// engine's next status observation.
	const sessionSockets = createWorkflowSessionResolver(
		props.repo,
		props.workflowId,
	);
	onCleanup(() => sessionSockets.dispose());
	const agentActivity = createAgentActivitySource({
		watch: async (target, onValue, onState) => {
			// A refresh's activity acquisitions share one authoritative store/path
			// validation batch, instead of synchronous I/O once per agent.
			const socket = await sessionSockets.resolve(
				target.runId,
				target.hostSocket,
			);
			return watchAgentActivity(
				{ ...target, hostSocket: socket },
				onValue,
				onState,
				() => sessionSockets.connection(target.runId, target.hostSocket),
			);
		},
	});
	createEffect(() => {
		agentActivity.sync(data().agents);
	});
	onCleanup(() => agentActivity.dispose());
	/** A nonterminal status is provisional until the full observation has landed
	 * and, for a durable agent, its activity watch has delivered a first frame.
	 * Terminal statuses are real verdicts, not a guess, so they stay on screen. */
	const agentStatusPending = (role: string, runId?: string) => {
		const index = agentIndex();
		if (!index.pendingRoles.has(role)) return false;
		if (runId && index.runByRole.get(role) !== runId) return false;
		return !dashboardLoaded() || agentActivity.pending(role);
	};
	const rowAgentActivity = (role: string, runId?: string) =>
		runId && agentIndex().runByRole.get(role) !== runId
			? undefined
			: agentActivity.activity(role);
	/**
	 * Leave the view for the dashboard grid. The run keeps streaming into the
	 * session state, so reopening the panel's agent lands on the live view
	 * instead of resubscribing.
	 */
	const backAgentSession = () => {
		setAgentSessionOpen(false);
		props.keymap.setData("agent.view", "none");
	};
	/**
	 * Project one host watch frame into the transcript page.
	 *
	 * The newest entries paint immediately, so the reader sees the tail of the
	 * run as soon as the frame lands; the older entries are projected on idle
	 * turns and published as they complete. Projecting the whole transcript on
	 * every frame (a streaming run delivers one every ~50 ms) measured ~18 ms for
	 * a long transcript, most of it for rows the view's own window never renders.
	 * A newer frame cancels the projection in flight: the tail it built for the
	 * previous frame is superseded, and the reader is looking at the newest rows
	 * either way.
	 */
	const projectAgentSessionTranscript = (value: unknown) => {
		agentSessionStopProjection();
		agentSessionStopProjection = streamAgentSessionProjection(
			createAgentSessionProjection(value, {
				notices: agentSessionNotices(),
			}),
			(blocks) => setAgentSessionBlocks(blocks),
		);
	};
	const unavailableAgentSession = (runId: string): void => {
		stopAgentSessionWatch();
		backAgentSession();
		setActivePanel(AGENTS_PANEL);
		setFocusedAgentRunId(runId);
		setSelectedAgent(focusedAgentPosition(agentIndex(), runId));
		notify(`Recorded session for agent run ${runId} is unavailable`, "warning");
	};
	// Every new connection, including watch retries, gets fresh ownership and
	// an instance pin. Route changes invalidate asynchronous control work.
	const agentSessionEndpoint = (session: {
		runId: string;
		hostSocket: string;
	}) => {
		const generation = agentSessionGeneration;
		return async () => {
			if (
				generation !== agentSessionGeneration ||
				agentSession()?.runId !== session.runId
			)
				throw new Error("agent session changed");
			const endpoint = await sessionSockets.connection(
				session.runId,
				session.hostSocket,
			);
			if (generation !== agentSessionGeneration)
				throw new Error("agent session changed");
			return endpoint;
		};
	};
	const openAgentSession = (
		session: {
			role: string;
			runId: string;
			hostSocket: string;
			/** Recovery hint only: the host verifies its durable association with
			 * this run before serving a transcript after restart. */
			conversationId?: string;
		},
		onUnavailable?: () => void,
	) => {
		stopAgentSessionWatch();
		const generation = agentSessionGeneration;
		const isCurrent = () => generation === agentSessionGeneration;
		setAgentSessionNotices([]);
		setAgentSessionDraft("");
		setAgentSessionMetadata({ working: false, connection: "connecting" });
		setAgentSessionBlocks([
			{
				id: "route:connecting",
				kind: "notice",
				tone: "muted",
				text: "Connecting…",
			},
		]);
		// Do not expose an unverified handle to submit/configure controls while
		// asynchronous batch validation is pending.
		setAgentSession(undefined);
		setAgentSessionOpen(true);
		props.keymap.setData("agent.view", "session");
		void (async () => {
			let socket: string;
			try {
				socket = await sessionSockets.resolve(
					session.runId,
					session.hostSocket,
				);
			} catch {
				if (isCurrent()) {
					if (onUnavailable) onUnavailable();
					else unavailableAgentSession(session.runId);
				}
				return;
			}
			if (!isCurrent()) return;
			setAgentSession({ ...session, hostSocket: socket });
			try {
				const { HostClient, watchStream } = await import(
					"../../agent-host/client.ts"
				);
				if (!isCurrent()) return;
				const { readAgentSessionMetadata } = await import("./agent-session.ts");
				if (!isCurrent()) return;
				const client = new HostClient(agentSessionEndpoint(session));
				// The catalog is best-effort: an old host without the request just
				// leaves the pickers empty instead of failing the session view.
				void client
					.catalog()
					.then((catalog) => {
						if (!isCurrent()) return;
						setAgentSessionModels([...catalog.models]);
						setAgentSessionThinkingLevels([...catalog.thinkingLevels]);
						setAgentSessionContextWindows(catalog.contextWindows ?? {});
					})
					.catch(() => undefined);
				// After a first frame, preserve the transcript across reconnects but
				// mark it stale and pause controls until another frame arrives. Any
				// open that cannot obtain its first frame returns to the exact run;
				// retrying an unavailable/older host is then an explicit row open.
				let receivedFrame = false;
				const stop = watchStream(client, session.runId, {
					...(session.conversationId
						? { conversationId: session.conversationId }
						: {}),
					onFrame: (value) => {
						if (!isCurrent()) return;
						receivedFrame = true;
						projectAgentSessionTranscript(value);
						setAgentSessionMetadata({
							...readAgentSessionMetadata(value),
							connection: "connected",
						});
					},
					onState: (state) => {
						if (!isCurrent()) return;
						if (state === "closed" && !receivedFrame) {
							if (onUnavailable) onUnavailable();
							else unavailableAgentSession(session.runId);
							return;
						}
						if (state !== "open") {
							// Cancel idle projection work too: it must not publish live
							// spinners over the disconnected transcript after this turn.
							agentSessionStopProjection();
							setAgentSessionBlocks((blocks) =>
								blocks.map((block) =>
									block.live || block.pending
										? { ...block, live: false, pending: false }
										: block,
								),
							);
							setAgentSessionMetadata((metadata) => ({
								...metadata,
								connection: receivedFrame ? "disconnected" : "connecting",
								working: false,
								compacting: undefined,
								tokensPerSecond: undefined,
							}));
						}
						if (state !== "open" && !receivedFrame) {
							// A reconnect before the first frame owns the placeholder
							// again: nothing may publish over it.
							agentSessionStopProjection();
							setAgentSessionBlocks([
								{
									id: "route:connecting",
									kind: "notice",
									tone: "muted",
									text: "Connecting…",
								},
							]);
						}
					},
				});
				if (!isCurrent()) {
					stop();
					return;
				}
				agentSessionStopWatch = stop;
			} catch (error) {
				if (!isCurrent()) return;
				if (onUnavailable) {
					onUnavailable();
					return;
				}
				agentSessionStopProjection();
				setAgentSessionBlocks([
					{
						id: "route:host-error",
						kind: "error",
						tone: "error",
						text:
							"Could not reach the agent host: " +
							(error instanceof Error ? error.message : String(error)),
					},
				]);
			}
		})();
	};
	// Consume the route request once after the dashboard has a concrete workflow
	// snapshot. A missing session handle focuses only the matching run row; it
	// never opens a different role's latest session as a substitute.
	let handledAgentRequest: string | undefined;
	createEffect(() => {
		const requestId = props.agentRequestId;
		const runId = props.agentRunId;
		if (!requestId || !runId || handledAgentRequest === requestId) return;
		const current = data();
		if (current.state.phase === "loading") return;
		const run = agentIndex().runsById.get(runId);
		setFocusedAgentRunId(run?.id);
		handledAgentRequest = requestId;
		stopAgentSessionWatch();
		backAgentSession();
		setActivePanel(AGENTS_PANEL);
		if (!run) {
			setSelectedAgent(-1);
			notify(`Agent run ${runId} is no longer available`, "warning");
			props.onAgentRunRequestConsumed?.(requestId);
			return;
		}
		// Superseded authoritative runs have a transient row at index zero.
		setSelectedAgent(focusedAgentPosition(agentIndex(), run.id));
		if (!run.hostSocket)
			notify(
				`Agent run ${runId} has no recorded session handle; showing its workflow row`,
				"warning",
			);
		if (run.hostSocket) {
			openAgentSession(
				{
					role: run.role,
					runId: run.id,
					hostSocket: run.hostSocket,
					...(run.conversationId ? { conversationId: run.conversationId } : {}),
				},
				() => unavailableAgentSession(runId),
			);
		}
		props.onAgentRunRequestConsumed?.(requestId);
	});
	const rememberAgentSessionInput = (text: string) => {
		const history = overlays.agentSessionHistory();
		if (history.at(-1) === text) return;
		const next = [...history, text].slice(-MAX_PROMPT_HISTORY);
		overlays.setAgentSessionHistory(next);
		try {
			savePromptHistory(next);
		} catch (error) {
			notify(
				"Could not save prompt history: " +
					(error instanceof Error ? error.message : String(error)),
				"error",
			);
		}
	};
	// Opening another session (even the same run again) invalidates pending
	// controls. Neither success nor failure may publish into its replacement.
	const currentAgentSessionControl = (runId: string) => {
		const generation = agentSessionGeneration;
		return () =>
			generation === agentSessionGeneration && agentSession()?.runId === runId;
	};
	const submitAgentSession = (text: string) => {
		const session = agentSession();
		if (!session || agentSessionMetadata().connection !== "connected") return;
		const isCurrent = currentAgentSessionControl(session.runId);
		void (async () => {
			try {
				const { HostClient } = await import("../../agent-host/client.ts");
				if (!isCurrent()) return;
				const client = new HostClient(agentSessionEndpoint(session));
				const response = await client.submit(
					session.runId,
					text,
					crypto.randomUUID(),
					"steer",
				);
				if (!isCurrent()) return;
				// What the prompt did to the run's workflow state is part of the
				// answer: an aborted run comes back active, a run that already handed
				// off is reported instead of being quietly reopened.
				const note = submissionStateNote(response.workflowState);
				if (note) notify(note.text, note.tone);
			} catch (error) {
				if (!isCurrent()) return;
				notify(
					"Could not send message: " +
						(error instanceof Error ? error.message : String(error)),
					"error",
				);
			}
		})();
	};
	const configureAgentSession = (change: {
		model?: string;
		thinking?: string;
	}) => {
		const session = agentSession();
		if (!session || agentSessionMetadata().connection !== "connected") return;
		const isCurrent = currentAgentSessionControl(session.runId);
		void (async () => {
			try {
				const { HostClient } = await import("../../agent-host/client.ts");
				if (!isCurrent()) return;
				const client = new HostClient(agentSessionEndpoint(session));
				await client.configureRun(session.runId, change);
				if (!isCurrent()) return;
				// Show the accepted override immediately; the next watch frame carries
				// the same value in `pi.agent` and reconciles any concurrent update.
				if (agentSession()?.runId === session.runId)
					setAgentSessionMetadata((metadata) => ({
						...metadata,
						...(change.model ? { model: change.model } : {}),
						...(change.thinking ? { thinking: change.thinking } : {}),
					}));
				notify(
					change.model
						? `Model set to ${change.model}`
						: `Thinking level set to ${change.thinking ?? ""}`,
					"success",
				);
			} catch (error) {
				if (!isCurrent()) return;
				notify(
					"Could not apply the change: " +
						(error instanceof Error ? error.message : String(error)),
					"error",
				);
			}
		})();
	};
	const abortAgentSession = () => {
		const session = agentSession();
		if (!session || agentSessionMetadata().connection !== "connected") return;
		const isCurrent = currentAgentSessionControl(session.runId);
		void (async () => {
			try {
				const { HostClient } = await import("../../agent-host/client.ts");
				if (!isCurrent()) return;
				const client = new HostClient(agentSessionEndpoint(session));
				// A manual compaction is a conversation-owned, non-background task, so
				// the abort cancels it too: say so in the transcript instead of leaving a
				// compaction block that will never produce a summary.
				const compacting = agentSessionBlocks().some(
					(block) => block.kind === "compaction" && block.live === true,
				);
				await client.abort(session.runId);
				if (!isCurrent()) return;
				if (compacting) {
					setAgentSessionNotices((notices) => [
						...notices.filter(
							(notice) => notice.id !== "local:compaction-aborted",
						),
						{
							id: "local:compaction-aborted",
							kind: "notice",
							tone: "warning",
							text: "Compaction aborted — a compaction in flight was cancelled and places no summary",
						},
					]);
					notify(
						"Abort requested — a compaction in flight is cancelled and places no summary",
						"info",
					);
				} else notify("Abort requested", "info");
			} catch (error) {
				if (!isCurrent()) return;
				notify(
					"Could not abort the run: " +
						(error instanceof Error ? error.message : String(error)),
					"error",
				);
			}
		})();
	};
	/** `/compact [instructions]`: the host admits one manual compaction and answers
	 * with a structured outcome, which is reported as a notice so "nothing to
	 * compact" is never mistaken for a started compaction. */
	const compactAgentSession = (instructions?: string) => {
		const session = agentSession();
		if (!session || agentSessionMetadata().connection !== "connected") return;
		const isCurrent = currentAgentSessionControl(session.runId);
		void (async () => {
			try {
				const { HostClient } = await import("../../agent-host/client.ts");
				if (!isCurrent()) return;
				const client = new HostClient(agentSessionEndpoint(session));
				const answer = await client.compactRun(session.runId, instructions);
				if (!isCurrent()) return;
				switch (answer.status) {
					case "started":
						notify(
							"Compaction started — the summary is placed at the next turn boundary",
							"info",
						);
						return;
					case "already-compacting":
						notify(
							`Already compacting (${answer.reason ?? "automatic"}) — no second summary was started`,
							"warning",
						);
						return;
					case "nothing-to-compact":
						notify(
							"Nothing to compact — this conversation holds no range a summary could replace",
							"info",
						);
						return;
				}
			} catch (error) {
				if (!isCurrent()) return;
				const message = error instanceof Error ? error.message : String(error);
				notify(
					message.includes("unknown-run")
						? "This run has finished; nothing was compacted"
						: `Could not compact: ${message}`,
					message.includes("unknown-run") ? "info" : "error",
				);
			}
		})();
	};
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
		| "debug-requests"
		| "review"
		| "credentials"
		| "preset-switcher"
		| "workflow-graph";
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
	const debugRequestsOpen = () => modalOpen("debug-requests");
	const setDebugRequestsOpen = (open: boolean) =>
		open
			? openModal("debug-requests", "dashboard")
			: closeModal("debug-requests");
	const openDebugRequests = () => {
		setDebugRequestsSelection(0);
		setDebugRequestsOffset(0);
		setDebugRequestsOpen(true);
		props.keymap.setData("modal.active", "debug-requests");
	};
	const openSelectedDebugRequestReport = async () => {
		const request = debugRequests()?.requests[debugRequestsSelection()];
		if (!request) return;
		if (!request.reportPath) {
			// `Enter` is advertised unconditionally, so a request that has not
			// reported yet says why nothing happened instead of doing nothing.
			const pending =
				request.status === "queued" || request.status === "running";
			notify(
				pending
					? `${request.id} has no report file yet`
					: `${request.id} produced no report`,
				pending ? "info" : "warning",
			);
			return;
		}
		try {
			// The path is recomputed from this workflow's own identity before the
			// opener sees it: the stored row is not trusted for a filesystem open.
			await openDebugRequestReport(data().state, request);
		} catch (error) {
			notify(error instanceof Error ? error.message : String(error), "error");
		}
	};
	const workflowGraphOpen = () => modalOpen("workflow-graph");
	const setWorkflowGraphOpen = (open: boolean) =>
		open
			? openModal("workflow-graph", "dashboard")
			: closeModal("workflow-graph");
	// `g` on the Change panel: one dialog for every definition, so the keybind is
	// never a dead key. A workflow whose pin could not be resolved has no graph;
	// the dialog says so instead of the key silently doing nothing.
	const openWorkflowGraph = () => {
		setWorkflowGraphOffset(0);
		setWorkflowGraphOpen(true);
		props.keymap.setData("modal.active", "workflow-graph");
	};
	const presetSwitcherOpen = () => modalOpen("preset-switcher");
	const closePresetSwitcher = () => {
		closeModal("preset-switcher");
		props.keymap.setData("modal.active", "none");
	};
	const openPresetSwitcher = () => {
		const current = data().state.selectedPreset;
		// The picker still offers configuration defaults when the config cannot be
		// read, but an empty list must not read as "no presets configured": the
		// failure is reported.
		const catalog = presetCatalog(data().state.repository);
		if (catalog.error)
			notify(`Agent presets could not be read: ${catalog.error}`, "error");
		const configured = catalog.names;
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
					prompt:
						data().state.phase === "debug.review"
							? "Press Enter to review the debug report"
							: data().state.phase === "stage.review"
								? "Press Enter to review the stage test report"
								: "Press Enter to review changed files",
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
			case "setup-review":
				return {
					prompt: "Press Enter to review the environment drafts",
					action: "setup-review",
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
		if (
			action.key === "plan-review" ||
			action.key === "wiki-review" ||
			action.key === "setup-review"
		) {
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
			setVerdict({
				title: `${artifactSurfaceLabel(data().state.definition?.id)} · ${item.value}`,
				content,
			});
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
	const runRefresh = (force: boolean) => {
		if (refreshDisposed) return;
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
					setDashboardLoaded(true);
					lastRefreshError = undefined;
					const selectedRunId = agentPanelData().agents[selectedAgent()]?.runId;
					setData(next);
					traceTui("tui.dashboard.refresh", {
						surface: "dashboard",
						action: "refresh",
					});
					setSelectedAgent((index) => {
						const agents = agentPanelData().agents;
						const retained = selectedRunId
							? agents.findIndex((agent) => agent.runId === selectedRunId)
							: -1;
						return retained >= 0
							? retained
							: Math.min(index, Math.max(0, agents.length - 1));
					});
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
	const runRefreshLive = () => {
		if (refreshDisposed) return;
		// A view update must not overtake a full observation that started after it
		// was requested, and a newer live request supersedes this one. Track both
		// generations instead of serializing behind `refreshRunning`: the live read
		// is cheap and is the path that keeps a streaming workflow moving.
		const generation = ++liveGeneration;
		const fullGeneration = refreshGeneration;
		liveController?.abort();
		liveController = new AbortController();
		void loadDashboardSeed(props.repo, props.workflowId, liveController.signal)
			.then((live) => {
				if (
					!live ||
					refreshDisposed ||
					generation !== liveGeneration ||
					fullGeneration !== refreshGeneration
				)
					return;
				setData((current) => mergeDashboardLive(current, live));
				traceTui("tui.dashboard.refresh", {
					surface: "dashboard",
					action: "refresh-live",
				});
			})
			.catch((error) => {
				if (refreshDisposed || error instanceof DOMException) return;
				traceTui(
					"tui.dashboard.refresh",
					{ surface: "dashboard", action: "refresh-live" },
					"error",
				);
			});
	};
	// Reads are spaced by `REFRESH_MIN_INTERVAL_MS`: a streaming agent used to
	// start the next read the moment the previous one finished, so a burst of
	// workflow events turned into back-to-back reads of identical data.
	const refreshThrottle = throttle(runRefresh, REFRESH_MIN_INTERVAL_MS);
	const refreshLiveThrottle = throttle(runRefreshLive, REFRESH_MIN_INTERVAL_MS);
	const refresh = (force = false) => {
		// A full observation supersedes a queued view-only update.
		refreshLiveThrottle.cancel();
		// `force` is the safety resync's authoritative read; a push-event refresh
		// must not force the review's file list past the cache.
		refreshReviewFiles?.(force);
		if (props.profile === "test") {
			setData(load());
			traceTui("tui.dashboard.refresh", {
				surface: "dashboard",
				action: "refresh",
			});
			return;
		}
		refreshThrottle.trigger(force);
	};
	/** Apply the workflow view without reading telemetry, Git, evidence or
	 * artifacts. Progress events use this; a drain boundary (settled/error), an
	 * action, and the safety resync still use the full `refresh`. */
	const refreshLive = () => {
		if (props.profile === "test" || !gatewayOrUndefined()) {
			refresh();
			return;
		}
		refreshLiveThrottle.trigger();
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
	refreshReviewFiles = (force) => void reviewFeature.refreshReviewFiles(force);
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
		reviewView,
		stageWikiUpdateAvailable,
		stagePlanReview,
		rejectPlanAvailable,
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
		// A hidden dashboard clears the modal stack. Never restore a saved modal
		// kind from a credential/question popup after the user returns: that kind
		// no longer has a live dialog to own the keymap.
		modalBeforeCredential = undefined;
		modalBeforeQuestion = undefined;
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
		agentSessionOpen()
			? agentSessionKeybindCatalog()
			: reviewOpen() && reviewKind() === "stage"
				? stageReportReviewKeybindCatalog(
						stageWikiUpdateAvailable(),
						reviewView(),
					)
				: reviewOpen() && stagePlanReview()
					? stagePlanReviewKeybindCatalog(rejectPlanAvailable(), reviewView())
					: evidenceViewOpen()
						? evidenceSubviewKeybindCatalog({
								flow: stageJournal()?.flowPage !== undefined,
							})
						: dashboardDetailKeybindCatalog({
								artifactsVisible: artifacts().length > 0,
								definitionId: data().state.definition?.id,
							}),
	);
	// The shell footer and `?` help read the active surface catalog from the
	// shared store; the route publishes the panel-scoped catalog here, or the
	// agent session's and the evidence view's own keys while a page replaced the
	// grid. A composition
	// root that parks the dashboard (the shell's sidebar panel) keeps its own
	// catalog instead, so a parked dashboard never overwrites it.
	createEffect(() => {
		if (props.active && !props.active()) return;
		setActiveKeybindCatalog(
			keybindCatalog(),
			// A page owns every key while it is open, so the panel context (which scopes
			// the footer to the focused panel) is suppressed on both of them.
			agentSessionOpen() || evidenceViewOpen()
				? undefined
				: panelContext(activePanel()),
		);
	});
	const helpMaxOffset = () =>
		Math.max(
			0,
			helpModalRowCount(keybindCatalog()) -
				Math.max(5, Math.floor(dimensions().height * 0.78) - 5),
		);
	const verdictLines = createMemo(() =>
		Math.max(4, Math.floor(dimensions().height * 0.75) - 5),
	);
	// The graph dialog scrolls like the verdict reader: one window of rows inside
	// the modal, bounded here so the key handler can clamp without re-deriving
	// the row list.
	// The modal reserves one body row for its pinned definition label/version.
	const workflowGraphLines = () => Math.max(3, verdictLines() - 1);
	// Dashboard observations use Schema.Unknown; normalize this graph once and
	// share it with both the dialog and its scroll bounds.
	const workflowGraph = createMemo(() =>
		decodeWorkflowDefinitionGraph(data().state.definitionGraph),
	);
	const workflowGraphMaxOffset = () => {
		const graph = workflowGraph();
		if (!graph) return 0;
		const rows = workflowGraphRows(
			graph,
			data().state.stepId ?? data().state.phase,
		);
		return Math.max(0, rows.length - workflowGraphLines());
	};
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

	// Refresh is driven by the server event stream when a transport is
	// configured: the server owns the execution-coordinator listeners and
	// publishes `workflow.updated`. A transport-less run (demo/tests) falls back
	// to local file watches. The effect depends only on the active flag: reading
	// `data()` untracked keeps the subscription and its safety timer alive
	// across refreshes instead of tearing them down on every `setData` (which
	// would open an event-loss window).
	createEffect(() => {
		if (props.profile === "test") return;
		if (props.active && !props.active()) return;
		const state = untrack(() => data().state);
		const debounced = debounce(() => {
			refresh();
		}, 200);
		if (serverOwnsExecutionEvents()) {
			// Attached: the server owns execution and publishes `workflow.updated`;
			// the data layer applies each envelope to the cache.
			const dispose = subscribeDataEvents({
				onEvent: (event) => {
					if (event.domain !== "workflow") return;
					if (event.resource && event.resource !== props.repo) return;
					// A progress event names the workflow whose effect committed. Every
					// dashboard in the repository used to re-read for every other
					// workflow's progress; only the affected one needs the update.
					if (event.runId && event.runId !== props.workflowId) return;
					const payload = event.payload;
					const phase =
						typeof payload === "object" &&
						payload !== null &&
						"phase" in payload
							? (payload as { phase?: unknown }).phase
							: undefined;
					if (phase === "progress") {
						// An effect commit changes the view, not the telemetry log or the
						// worktree Git state. Overlay the view and leave the full read for a
						// drain boundary or the safety resync. The live throttle is
						// leading-and-trailing, so the first commit paints immediately and a
						// burst still collapses to one read a second.
						refreshLive();
						return;
					}
					debounced.trigger();
				},
				onResync: () => refresh(true),
			});
			// Safety resync: even with push events, a dropped/missed update must not
			// leave the view stale forever. A forced read bypasses the cache.
			const disposeResync = startSafetyResync(refresh);
			onCleanup(() => {
				debounced.cancel();
				refreshLiveThrottle.cancel();
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
		const disposeResync = startSafetyResync(refresh);
		onCleanup(() => {
			debounced.cancel();
			disposeWatch();
			disposeResync();
		});
	});

	// Component-scope so the agent prompt's focus gating and the keymap self-heal
	// can both read it. Whether any dashboard dialog (the question form, help, a
	// picker, findings, the error modal, …) currently owns the keyboard.
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
			workflowGraphOpen() ||
			presetSwitcherOpen() ||
			reviewOpen() ||
			reviewCommentMode() ||
			activeErrorModal() != null
		);

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
				: onWorkflowExecutionProgress(props.repo, (workflowId) => {
						if (props.active && !props.active()) return;
						if (workflowId === props.workflowId) refreshLive();
					});
		// The cheap first paint, so the hydrate below can wait for it (see the
		// `refresh()` call at the end of this mount).
		let seedPainted: Promise<unknown> = Promise.resolve();
		if (props.profile !== "test") {
			const seedController = new AbortController();
			seedPainted = loadDashboardSeed(
				props.repo,
				props.workflowId,
				seedController.signal,
			)
				.then((seed) => {
					if (seed && !refreshDisposed && !dashboardLoaded()) setData(seed);
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
		if (props.profile === "test") refresh();
		// Hydrate after the seed has painted, never before it. The seed is the
		// cheap workflow-view read the Agents panel renders from; the full
		// observation reads the whole telemetry log and runs Git synchronously on
		// this event loop when the server is in-process, so starting it in the same
		// tick buried the seed's write behind that read and left the panel on its
		// loading placeholder for the length of the observation.
		else
			void seedThenHydrate(
				seedPainted,
				renderer,
				() => refresh(),
				() => refreshDisposed,
			);
		onCleanup(() => {
			refreshDisposed = true;
			agentSessionStopProjection();
			refreshController?.abort();
			liveController?.abort();
			refreshLiveThrottle.cancel();
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
		selectedDecision,
		setSelectedDecision,
		openEvidenceView,
		artifacts,
		data: agentPanelData,
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
		...(props.onBack ? { onBack: props.onBack } : {}),
		openFindingInEditor: async (path, line) => {
			artifactController?.signal.throwIfAborted();
			await openFindingInEditor(data().state, { path, line });
		},
		openDeveloperReview,
		openPlanReview,
		openVerifierResult,
		openRequiredUserAction,
		openPresetSwitcher,
		openAgentSession,
		openCost: () => setCostOpen(true),
		openDebugRequests,
		openWorkflowGraph,
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
			setVerdict({
				title: `${artifactSurfaceLabel(data().state.definition?.id)} · ${artifact}`,
				content: read ?? "",
			});
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
	const evidenceViewKeyHandler = createEvidenceSubviewKeyHandler({
		rows: () => evidenceListRows(),
		selectedIndex: selectedEvidence,
		setSelectedIndex: setSelectedEvidence,
		reportScroll: () => evidenceSubviewScrollbox,
		dimensions,
		openEvidence: (entry) => void openEvidence(entry),
		copyEvidencePath,
		openEvidenceFlow: () => void openEvidenceFlow(),
		close: backEvidenceView,
		notify,
	});
	onMount(() => {
		props.keymap.setData("app.view", "detail");
		// A shell run request can open the session before mount; do not reset
		// its field while installing the grid and session keymap layers.
		props.keymap.setData("agent.view", agentSessionOpen() ? "session" : "none");
		// Same for the evidence subview: only `Enter` on the Evidence panel opens
		// it, and the grid's layer requires this field.
		props.keymap.setData("evidence.view", "none");
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
						// A `stage_login` hand-off offers only Done and Abort: there is no custom
						// response, so the row past the last option is not reachable
						// (add-stage-interactive-login).
						const offersCustom = current.kind !== "login-handoff";
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
							setQuestionSelection((index) =>
								Math.min(
									offersCustom ? customIndex : customIndex - 1,
									index + 1,
								),
							);
						else if (key === "k" || key === "up")
							setQuestionSelection((index) => Math.max(0, index - 1));
						else if (key === "enter" || key === "return") {
							if (offersCustom && questionSelection() === customIndex) {
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
		const disposeDebugRequests = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "debug-requests",
			priority: 1000,
			activeModal: "debug-requests",
			commands: [
				{
					name: "debug-requests.handle",
					run: ({ event }) => {
						if (routeModalHelp(event.name.toLowerCase())) return true;
						// The whole key surface is one pure function, so the dialog's
						// read-only actions are exactly what the tests assert.
						const action = debugRequestsKeyAction(event, {
							selection: debugRequestsSelection(),
							offset: debugRequestsOffset(),
							count: debugRequests()?.requests.length ?? 0,
						});
						if (action.kind === "close") {
							setDebugRequestsOpen(false);
							props.keymap.setData("modal.active", "none");
						} else if (action.kind === "select")
							setDebugRequestsSelection(action.index);
						else if (action.kind === "scroll")
							setDebugRequestsOffset(action.offset);
						else if (action.kind === "open")
							void openSelectedDebugRequestReport();
						return true;
					},
				},
			],
			bindings: ["escape", "enter", "return", "j", "k", "J", "K", "?"].map(
				(key) => ({ key, cmd: "debug-requests.handle" }),
			),
		});
		const disposeWorkflowGraph = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "workflow-graph",
			priority: 1000,
			activeModal: "workflow-graph",
			commands: [
				{
					name: "workflow-graph.handle",
					run: ({ event }) => {
						const key = event.name.toLowerCase();
						if (routeModalHelp(key)) return true;
						if (key === "escape") {
							setWorkflowGraphOpen(false);
							props.keymap.setData("modal.active", "none");
						} else if (key === "j" || key === "down")
							setWorkflowGraphOffset((value) =>
								Math.min(workflowGraphMaxOffset(), value + 1),
							);
						else if (key === "k" || key === "up")
							setWorkflowGraphOffset((value) => Math.max(0, value - 1));
						return true;
					},
				},
			],
			bindings: ["escape", "j", "k", "up", "down", "?"].map((key) => ({
				key,
				cmd: "workflow-graph.handle",
			})),
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
							reviewKind() === "plan" ||
							reviewKind() === "wiki" ||
							reviewKind() === "setup"
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
							else if (
								reviewKind() === "developer" &&
								data().state.definition?.id === "debug"
							)
								// A report-only investigation has no changed file to anchor to: the
								// comment is the follow-up itself, anchored to the report artifact.
								setReviewComments((comments) => [
									...comments,
									{ filePath: "debug-report.md", line: 1, body },
								]);
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
								void openFindingInEditor(data().state, finding).catch(
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
		// The agent session modal keeps its input focused, so scrolling binds to
		// keys that never insert text (page/ctrl combos) rather than j/k, which
		// the user must be able to type into a message.
		// The agent session view is a page of the dashboard body, so it takes the
		// keyboard from the panel grid through the `agent.view` field (and only
		// while no dialog is on top): scrolling its transcript, and leaving it for
		// the grid on Escape. The prompt input stays focused and owns text keys.
		// The evidence subview is the second page of the dashboard body, gated on its
		// own field so it never opens with the agent session's key layer. It takes
		// every key it declares — the sidebar selection, both file actions, the report
		// scroll and Escape back to the grid — and nothing else, so an unbound key
		// still reaches the shell.
		const disposeEvidenceView = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "evidence-view",
			priority: 1000,
			evidenceView: "open",
			activeModal: "none",
			commands: [
				{
					name: "evidence-view.handle",
					run: ({ event }) => {
						if (!evidenceViewOpen()) return false;
						return evidenceViewKeyHandler(event);
					},
				},
			],
			bindings: EVIDENCE_VIEW_KEYS.map((key) => ({
				key,
				cmd: "evidence-view.handle",
			})),
		});
		const disposeAgentSession = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "agent-session",
			priority: 1000,
			agentView: "session",
			activeModal: "none",
			commands: [
				{
					name: "agent-session.handle",
					run: ({ event }) => {
						const name = event.name.toLowerCase();
						if (name === "escape") {
							backAgentSession();
							return true;
						}
						const box = agentSessionScrollbox;
						if (!box) return false;
						const page = Math.max(1, Math.floor(dimensions().height / 3));
						if (name === "pageup") box.scrollBy(-page);
						else if (name === "pagedown") box.scrollBy(page);
						else if (name === "u" && event.ctrl) box.scrollBy(-page);
						else if (name === "d" && event.ctrl) box.scrollBy(page);
						return true;
					},
				},
			],
			bindings: ["pageup", "pagedown", "ctrl+u", "ctrl+d", "escape"].map(
				(key) => ({ key, cmd: "agent-session.handle" }),
			),
		});
		// The model/thinking picker owns the keyboard while it is open (the
		// prompt input is unfocused then), so ordinary letters are free for
		// filtering.
		const disposeAgentSessionPicker = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "agent-session-picker",
			priority: 1100,
			agentView: "picker",
			commands: [
				{
					name: "agent-session-picker.handle",
					run: ({ event }) => {
						// Only the open picker owns the keyboard. Without its handler
						// (view gone) the key must fall through to the dashboard
						// layers instead of being swallowed by this letter-wide layer.
						const handler = agentSessionPickerHandler;
						if (!handler) return false;
						return handler(event);
					},
				},
			],
			bindings: SESSION_PICKER_KEYS.map((key) => ({
				key,
				cmd: "agent-session-picker.handle",
			})),
		});
		const dispose = props.keymap.registerLayer({
			...(props.shellFeature ? { shellFeature: "workflows" } : {}),
			name: "detail",
			priority: 100,
			appView: "detail",
			activeModal: "none",
			// The grid keeps its keys only while neither page has replaced it.
			agentView: "none",
			evidenceView: "none",
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
				"g",
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
			disposeDebugRequests();
			disposeWorkflowGraph();
			disposePresetSwitcher();
			disposeHelp();
			disposeReviewComment();
			disposeDeveloperReview();
			disposePlanRejection();
			disposePlanReview();
			disposeFindings();
			disposeVerdict();
			disposeAgentSession();
			disposeAgentSessionPicker();
			disposeEvidenceView();
			// The unmounted pages must not leave their keymap fields parking the grid
			// layers of whatever surface mounts next.
			props.keymap.setData("agent.view", "none");
			props.keymap.setData("evidence.view", "none");
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
		// Self-heal: reconcile keymap modal data with real modal state.
		createEffect(() => {
			if (!anyModalOpen()) props.keymap.setData("modal.active", "none");
		});
		// A hidden agent session must never leave the keymap parked on its view
		// (it takes keys the panel grid also needs), so a close that raced the
		// view's own reset cannot swallow the dashboard keybinds. The field is
		// separate from `modal.active`: this is a page, not a dialog.
		const repairAgentView = () => {
			if (!agentSessionOpen()) {
				const view = props.keymap.getData?.("agent.view");
				if (view === "session" || view === "picker")
					props.keymap.setData("agent.view", "none");
			}
			// The evidence subview gets the same repair: a page that closed (or never
			// opened) must not leave the grid without its keys.
			if (
				!evidenceViewOpen() &&
				props.keymap.getData?.("evidence.view") === "open"
			)
				props.keymap.setData("evidence.view", "none");
		};
		createEffect(repairAgentView);
		// The effect above only re-runs when the session state changes, so any
		// later writer that parks the field again (a picker closing, a shell
		// overlay restoring its saved value) would leave the dashboard's layers
		// unreachable. Repair the field before every dispatch instead, so the very
		// keystroke that would have been swallowed already sees the right layer.
		const disposeAgentSessionRepair = props.keymap.intercept(
			"key",
			repairAgentView,
		);
		onCleanup(disposeAgentSessionRepair);
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
			if (
				action.key === "plan-review" ||
				action.key === "wiki-review" ||
				action.key === "setup-review"
			) {
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
								flexDirection: "column",
								gap: 1,
							}}
							// The agent session page takes the body: the grid stays mounted
							// (hidden, so its scroll positions survive the round trip) and
							// hands the keyboard over through the `agent.view` keymap field.
							// The evidence subview is the other such page and follows
							// `evidence.view`.
							visible={!agentSessionOpen() && !evidenceViewOpen()}
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
										onFocusRequest={() => focusPanelFromPointer(0)}
										onScrollBoxReady={(box) => {
											changeScroll = box as ScrollBoxRenderable;
										}}
									/>
									<Show when={artifacts().length > 0}>
										<OpenSpecPanel
											artifacts={artifacts()}
											active={activePanel() === 6}
											selectedIndex={selectedArtifact()}
											title={artifactSurfaceLabel(data().state.definition?.id)}
											onSelectIndex={setSelectedArtifact}
											onActivateRow={activatePanelRow(setSelectedArtifact)}
											onFocusRequest={() => focusPanelFromPointer(6)}
										/>
									</Show>
									{/* Always rendered, empty state included: a newly started
								    workflow must show where its decisions will land. */}
									<ClassifierPanel
										entries={classifications()}
										active={activePanel() === CLASSIFIER_PANEL}
										selectedIndex={selectedDecision()}
										onSelectIndex={setSelectedDecision}
										onActivateRow={activatePanelRow(setSelectedDecision)}
										onFocusRequest={() =>
											focusPanelFromPointer(CLASSIFIER_PANEL)
										}
									/>
								</box>
								<AgentsPanel
									data={agentPanelData()}
									focusedRunId={focusedAgentRunId()}
									historicalRunId={historicalAgentRunId()}
									active={activePanel() === 1}
									selectedIndex={selectedAgent()}
									narrow={dimensions().width < 90}
									activity={rowAgentActivity}
									statusPending={agentStatusPending}
									detailsPending={!dashboardLoaded()}
									onSelectIndex={setSelectedAgent}
									onActivateRow={activatePanelRow(setSelectedAgent)}
									onFocusRequest={() => focusPanelFromPointer(1)}
								/>
							</box>
							{/* Read-only, and always rendered with its empty state: the
							    evidence a run produced is never a panel that appears late. The
							    panel is the one-line summary; `Enter` opens the subview, which
							    is where the entries are listed and the report is read. */}
							<EvidencePanel
								entries={evidence().entries}
								journal={stageJournal()}
								active={activePanel() === EVIDENCE_PANEL}
								height={evidencePanelHeight()}
								state={evidenceState()}
								error={evidenceError()}
								onFocusRequest={() => focusPanelFromPointer(EVIDENCE_PANEL)}
							/>
						</box>
						<Show when={agentSessionOpen() && agentSession()}>
							{(session) => (
								<AgentSessionView
									role={session().role}
									blocks={agentSessionBlocks()}
									{...agentSessionMetadata()}
									{...(agentSessionMetadata().model
										? {
												contextWindow:
													agentSessionContextWindows()[
														agentSessionMetadata().model as string
													],
											}
										: {})}
									models={agentSessionModels()}
									thinkingLevels={agentSessionThinkingLevels()}
									draft={agentSessionDraft()}
									history={overlays.agentSessionHistory()}
									onDraftChange={(value) =>
										overlays.setAgentSessionDraft(value)
									}
									onHistoryAppend={rememberAgentSessionInput}
									onSubmit={submitAgentSession}
									onAbort={abortAgentSession}
									onBack={backAgentSession}
									onConfigure={configureAgentSession}
									onCompact={compactAgentSession}
									// The prompt reads keys only while the dashboard owns the keyboard:
									// the shell sidebar/overlay or a dashboard dialog parks the
									// keymap, so the input must blur too instead of swallowing the
									// surface's keys.
									inputActive={() =>
										(props.active?.() ?? true) &&
										!(props.overlay?.() ?? false) &&
										!anyModalOpen()
									}
									// The view is not a dialog, so `?` opens the page's
									// keybind help the way the panel grid does.
									onHelp={() => {
										setHelp(true);
										setHelpOffset(0);
										props.keymap.setData("modal.active", "help");
									}}
									onScrollBoxReady={(box: ScrollBoxRenderable) => {
										agentSessionScrollbox = box;
									}}
									onPickerKeyReady={(handler) => {
										agentSessionPickerHandler = handler;
									}}
									onPickerActiveChange={(active) => {
										// A picker closing after the view was left must not re-park
										// the keymap on the view; the grid only regains its keys
										// at "none".
										props.keymap.setData(
											"agent.view",
											agentSessionOpen()
												? active
													? "picker"
													: "session"
												: "none",
										);
									}}
								/>
							)}
						</Show>
						{/* The evidence subview, the grid's other page: the run's report beside
						    every entry the manifest holds. It is a page rather than a dialog so
						    the list keeps the panel's own tap and key behaviour, and it hands
						    the keyboard over through the `evidence.view` keymap field. */}
						<Show when={evidenceViewOpen()}>
							<EvidenceSubview
								entries={evidence().entries}
								journal={stageJournal()}
								// The grid's own grouping: the selection clamp, the key handler and
								// this list share one row list per refresh.
								rows={() => evidenceListRows()}
								state={evidenceState()}
								error={evidenceError()}
								report={reportText}
								reportState={reportState()}
								reportError={reportError()}
								kitty={kittyGraphics()}
								images={reportImages}
								selectedIndex={selectedEvidence()}
								pathOf={evidencePathOf}
								onScrollBoxReady={(box: ScrollBoxRenderable) => {
									evidenceSubviewScrollbox = box;
								}}
								onSelectIndex={setSelectedEvidence}
								onActivateRow={(index) => {
									// A tap on an already selected row is the pointer's `Enter`: the
									// same two actions, resolved in one place.
									const row = evidenceListRows()[index];
									if (row?.entry) void openEvidence(row.entry);
									else if (row?.step !== undefined) void openEvidenceFlow();
								}}
							/>
						</Show>
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
								onSelectIndex: setPlanRejectionSelection,
							}
						: undefined
				}
				cost={costOpen() ? { rows: data().costBreakdown } : undefined}
				debugRequests={
					debugRequestsOpen()
						? {
								requests: debugRequests()?.requests ?? [],
								state: debugRequestsState(),
								...(debugRequestsError()
									? { error: debugRequestsError() }
									: {}),
								selectedIndex: debugRequestsSelection(),
								offset: debugRequestsOffset(),
							}
						: undefined
				}
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
				workflowGraph={
					workflowGraphOpen()
						? {
								definition: {
									label: data().state.definition?.label ?? "unknown",
									version: data().state.definition?.version ?? 0,
								},
								...(data().state.definitionOrigin
									? { origin: data().state.definitionOrigin }
									: {}),
								...(workflowGraph() ? { graph: workflowGraph() } : {}),
								currentStep: data().state.stepId ?? data().state.phase,
								lines: workflowGraphLines(),
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
				stageReportKeybinds={
					reviewKind() === "stage"
						? stageReportReviewKeybindsForView(
								stageWikiUpdateAvailable(),
								reviewView(),
							)
						: undefined
				}
				stagePlanKeybinds={
					stagePlanReview()
						? stagePlanReviewKeybindsForView(
								rejectPlanAvailable(),
								reviewView(),
							)
						: undefined
				}
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

/** @jsxImportSource @opentui/solid */
import {
  TextAttributes,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { join } from "node:path";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  approvalFor,
  applyRepair,
  focusAgent,
  focusGitPane,
  focusReturnWorkspace,
  loadDashboard,
  loadDeveloperReviewFindings,
  loadLocalChanges,
  loadLocalDiff,
  loadVerifierFindings,
  loadVerifierReport,
  openFindingInEditor,
  openSpecArtifact,
  openSpecArtifacts,
  previewRepair,
  requiredUserActionFor,
  runWorkflow,
  saveDeveloperReview,
  testDashboard,
  type DashboardData,
  type DeveloperReviewComment,
  type DeveloperReviewFinding,
  type LocalChange,
  type RequiredUserActionItem,
} from "./data";
import { watchDirectories } from "./watchRefresh";
import { formatDuration } from "../../workflow/format";
import { Badge } from "./ui/Badge";
import { HighlightedText } from "./ui/Highlight";
import { Layout } from "./ui/Layout";
import { Panel } from "./ui/Panel";
import { VerdictModal } from "./ui/VerdictModal";
import { ScrollableContent } from "./ui/ScrollableContent";
import { VerificationTimelineModal } from "./ui/VerificationTimelineModal";
import { FindingsModal, type FindingEvent } from "./ui/FindingsModal";
import { CostModal } from "./ui/CostModal";
import { EventsModal } from "./ui/EventsModal";
import { HelpModal, type HelpSection } from "./ui/HelpModal";
import { uiColors } from "./ui/colors";
import { NotificationOverlay } from "./ui/Notification";
import { notify } from "./notifications";
import { copyToClipboard } from "./clipboard";
import { applyTheme, saveThemeName, loadThemeName } from "./theme-settings";
import { getActiveThemeName, themeNames } from "./ui/theme";
import { ThemePickerModal } from "./ui/ThemePickerModal";
import { SelectableList } from "./ui/Selectable";
import { ListViewModal } from "./ui/ListViewModal";
import { TraceBrowser } from "./ui/TraceBrowser";
import { ChangedFilesView } from "./devenv-ui/components/ChangedFilesView";
import { DiffViewModal } from "./devenv-ui/components/DiffViewModal";
import type { Discussion } from "./devenv-ui/types";

export function App(props: {
  repo: string;
  change: string;
  profile?: "test";
  keymap: Keymap<any, KeyEvent>;
  /** Push the workflow header context up to the shell's global header. */
  onHeader?: (header: import('../otel/app/App').WorkflowHeaderInfo | null) => void;
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
  const load = () =>
    props.profile === "test"
      ? testDashboard(demoPhases[demoIndex()]!)
      : loadDashboard(props.repo, props.change);
  const [data, setData] = createSignal<DashboardData>(load());
  // Feed the shell's global header from the dashboard's single data source.
  createEffect(() => {
    props.onHeader?.({ change: data().state.changeId, phase: data().state.stepLabel ?? data().state.phase, branch: data().state.branch, updated: data().updated });
  });
  const [message, setMessage] = createSignal("");
  let lastQuitAt = 0;
  const [busy, setBusy] = createSignal(false);
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
  const [findings, setFindings] = createSignal<{
    title: string;
    events: FindingEvent[];
  }>();
  const [findingsReturnToVerification, setFindingsReturnToVerification] =
    createSignal(false);
  const [selectedFinding, setSelectedFinding] = createSignal(0);
  const openVerifierResult = (role: string, returnToVerification = false) => {
    setVerdictReturnToFindings(false);
    setVerdictReturnToUserAction(false);
    setFindingsReturnToVerification(returnToVerification);
    const parsed =
      props.profile === "test"
        ? undefined
        : loadVerifierFindings(props.repo, props.change, role);
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
        : loadVerifierReport(props.repo, props.change, role),
    );
    setVerdictOffset(0);
    props.keymap.setData("modal.active", "verdict");
  };
  const [verdictOffset, setVerdictOffset] = createSignal(0);
  const [verificationDetail, setVerificationDetail] = createSignal(false);
  const [eventsDetail, setEventsDetail] = createSignal(false);
  const [traceDetail, setTraceDetail] = createSignal(false);
  const [selectedEvent, setSelectedEvent] = createSignal(0);
  const [selectedVerification, setSelectedVerification] = createSignal(0);
  const [help, setHelp] = createSignal(false);
  const [themePicker, setThemePicker] = createSignal(false);
  const [completedPicker, setCompletedPicker] = createSignal(false);
  const [completedSelection, setCompletedSelection] = createSignal(0);
  const [actionReason, setActionReason] = createSignal("");
  const [actionConfirmed, setActionConfirmed] = createSignal(false);
  const [repairOpen, setRepairOpen] = createSignal(false);
  const [repairTargets, setRepairTargets] = createSignal<Array<{ targetStep: string; label: string; expiresRuns: string[]; retainedEvidence: string[] }>>([]);
  const [repairSelection, setRepairSelection] = createSignal(0);
  const [repairReason, setRepairReason] = createSignal("");
  const [repairConfirmed, setRepairConfirmed] = createSignal(false);
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
      .filter((finding) => finding.path && finding.line)
      .map((finding) => {
        const position = {
          base_sha: "",
          start_sha: "",
          head_sha: "",
          old_path: finding.path!,
          new_path: finding.path!,
          position_type: "text",
          new_line: finding.line,
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
        { key: "Tab / Shift+Tab", description: "Switch panel" },
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
        { key: "v", description: "View selected verifier verdict" },
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
          : loadLocalChanges(props.repo, props.change);
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
          : loadDeveloperReviewFindings(props.repo, props.change);
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
          : loadLocalDiff(props.repo, props.change, file),
      );
      setReviewLine(0);
      setReviewView("diff");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const finishDeveloperReview = async () => {
    if (busy()) return;
    setBusy(true);
    setMessage("Finishing developer review…");
    try {
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
        await saveDeveloperReview(props.repo, props.change, comments);
        const engineComments = comments.map(comment => ({ comment: comment.body, ...(comment.filePath ? { file: comment.filePath } : {}), ...(comment.line ? { line: comment.line } : {}), ...(comment.startLine ? { startLine: comment.startLine } : {}), ...(comment.endLine ? { endLine: comment.endLine } : {}), ...(comment.findingId ? { findingId: comment.findingId } : {}) }));
        setMessage(await runWorkflow(comments.length ? "review-comments" : "approve-review", props.repo, props.change, data().state.revision, comments.length ? JSON.stringify({ comments: engineComments }) : undefined));
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
    }
  };
  const gate = createMemo(() => {
    if (props.profile === "test")
      return {
        prompt: "Press Enter to advance demo phase",
        action: "next demo phase",
      };
    if (data().state.stepId === "core.developer-review") return { prompt: "Press Enter to review changed files", action: "review" };
    const actions = data().state.availableActions ?? []; if (actions.length > 1 || actions[0]?.confirmation !== 'none') return actions.length ? { prompt: "Press Enter to choose workflow action", action: "completed-actions" } : undefined;
    const action = actions[0]; if (action) return { prompt: `Press Enter: ${action.label}`, action: action.id };
    if (
      data().state.phase === "fix" &&
      data().agents.find((agent) => agent.role === "worker")?.status !== "idle"
    )
      return undefined;
    return approvalFor(data().state.phase);
  });
  const completedActions = () => data().state.availableActions?.map(action => ({ label: action.label, command: action.id, confirmation: action.confirmation })) ?? [];
  const actionSignature = createMemo(() => completedActions().map(action => `${action.command}:${action.confirmation}`).join('\0')); let previousActionSignature: string | undefined;
  createEffect(() => { const next = actionSignature(); if (previousActionSignature !== undefined && next !== previousActionSignature) { setCompletedSelection(0); setActionConfirmed(false); setActionReason('') } previousActionSignature = next });
  const openRequiredUserAction = () => {
    const action = requiredUserAction();
    if (!action || (promptedUserActionKey === action.key && activePanel() !== 0))
      return false;
    setUserActionSelection(0);
    setUserActionOpen(true);
    props.keymap.setData("modal.active", "user-action");
    return true;
  };
  // ponytail: legacy action ids from the pre-engine dashboard; new engine dispatches by id.
  const workflowActionId = (value: string) => ({ apply: "approve-plan" })[value] ?? value;
  const runRequiredUserAction = async (item: RequiredUserActionItem) => {
    if (item.kind === "dismiss") {
      setUserActionOpen(false);
      props.keymap.setData("modal.active", "none");
      return;
    }
    if (item.kind === "artifact") {
      setUserActionOpen(false);
      setVerdictReturnToFindings(false);
      setVerdictReturnToUserAction(true);
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
    if (item.kind === "review") {
      openDeveloperReview();
      return;
    }
    setBusy(true);
    setMessage(`Running ${item.label}…`);
    try {
      if (props.profile === "test") {
        setDemoIndex((index) => (index + 1) % demoPhases.length);
        setMessage("Advanced dummy workflow");
      } else
        setMessage(await runWorkflow(workflowActionId(item.value), props.repo, props.change, data().state.revision));
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const workflowStatus = createMemo(() => {
    const label = data().state.stepLabel ?? data().state.phase;
    const active = data().agents.find((agent) => agent.status === "working");
    if (!active) return { text: label, working: false };
    if (active.role === "planner") return { text: "Planning", working: true };
    if (active.role.endsWith("verifier"))
      return { text: "Verifying", working: true };
    return { text: "Applying", working: true };
  });

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
        : [
            join(props.repo, ".herdr-workflow", props.change),
            join(data().state.worktree, ".herdr-workflow", props.change),
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
        try { require('node:fs').appendFileSync(target, `${Date.now()} dash ${msg}\n`); } catch { /* noop */ }
      }
    };
    trace(`key=${key.name} modal.active=${props.keymap.getData?.('modal.active')}`);
    if (busy()) return;
    const name = key.name.toLowerCase();
    if (name === "q" || (key.ctrl && name === "c")) {
      const selection = renderer.getSelection()?.getSelectedText();
      if (key.ctrl && selection) {
        copyToClipboard(selection);
        notify("Selection copied", "success");
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
        copyToClipboard(selection);
        notify("Selection copied", "success");
      } else notify("No selection to copy", "warning");
      return;
    }
    if (name === "escape") {
      try {
        const workspace = (
          props.profile === "test"
            ? data()
            : loadDashboard(props.repo, props.change)
        ).state.returnWorkspace;
        if (!workspace)
          throw new Error(
            "No dashboard workspace recorded. Open this workflow from the overview first.",
          );
        focusReturnWorkspace(props.repo, props.change, workspace);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (name === "t" && key.shift) {
      applyTheme(themeNames[themeIndex()]!);
      setThemePicker(true);
      props.keymap.setData("modal.active", "theme");
      return;
    }
    if (name === "o" && key.shift) {
      try { setRepairTargets(previewRepair(props.repo, props.change)); setRepairSelection(0); setRepairReason(""); setRepairConfirmed(false); setRepairOpen(true); props.keymap.setData("modal.active", "repair"); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
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
      const agent = data().agents[selectedAgent()];
      if (!agent?.role.endsWith("verifier")) {
        setMessage("Select a verifier agent to view its verdict.");
        return;
      }
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
      name === "tab"
    ) {
      setActivePanel((panel) => {
        const order = [0, 6, 1, 2, 3, 4, 5];
        const index = order.indexOf(panel);
        return order[
          (index +
            (name === "k" || (name === "tab" && key.shift)
              ? order.length - 1
              : 1)) %
            order.length
        ]!;
      });
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
      if (openRequiredUserAction()) return;
      if (data().state.stepId === "core.developer-review") {
        openDeveloperReview();
        return;
      }
      if (activePanel() === 6) {
        const artifact = artifacts()[selectedArtifact()];
        if (artifact) {
          setVerdict({
            title: `OpenSpec · ${artifact}`,
            content: openSpecArtifact(data().state, artifact),
          });
          setVerdictOffset(0);
          props.keymap.setData("modal.active", "verdict");
        }
        return;
      }
      if (activePanel() === 5) {
        setTraceDetail(true);
        props.keymap.setData("modal.active", "traces");
        return;
      }
      if (activePanel() === 4) {
        try {
          focusGitPane(data().state);
        } catch (error) {
          setVerdictReturnToFindings(false);
          setVerdict({
            title: "Lazygit launch failed",
            content: error instanceof Error ? error.message : String(error),
          });
          setVerdictOffset(0);
          props.keymap.setData("modal.active", "verdict");
        }
        return;
      }
      if (activePanel() === 2) {
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
      if (activePanel() === 3) {
        setVerificationDetail(true);
        setSelectedVerification(0);
        props.keymap.setData("modal.active", "verification-detail");
        return;
      }
      if (activePanel() === 1) {
        const agent = data().agents[selectedAgent()];
        if (!agent) return;
        try {
          focusAgent(data().state, data().state.panes[agent.role]!);
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
      if (approval.action === "completed-actions") {
        setCompletedPicker(true);
        setCompletedSelection(0); setActionReason(""); setActionConfirmed(false);
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
            await runWorkflow(approval.action, props.repo, props.change, data().state.revision),
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
              applyTheme(items[next]!);
            } else if (key === "k" || key === "up") {
              const next = Math.max(0, themeIndex() - 1);
              setThemeIndex(next);
              applyTheme(items[next]!);
            } else if (key === "enter" || key === "return") {
              if (themeFiltering()) setThemeFiltering(false);
              else {
                saveThemeName(items[themeIndex()]!);
                setThemePicker(false);
                props.keymap.setData("modal.active", "none");
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
    const disposeRepair = props.keymap.registerLayer({
      name: "repair", priority: 1000, activeModal: "repair",
      commands: [{ name: "repair.handle", run: ({ event }) => { const key = event.name.toLowerCase(); if (key === "escape") { setRepairOpen(false); props.keymap.setData("modal.active", "none") } else if (key === "j" || key === "down") { setRepairSelection(index => Math.min(repairTargets().length - 1, index + 1)); setRepairConfirmed(false) } else if (key === "k" || key === "up") { setRepairSelection(index => Math.max(0, index - 1)); setRepairConfirmed(false) } else if (key === "backspace") { setRepairReason(value => value.slice(0, -1)); setRepairConfirmed(false) } else if (key === "enter" || key === "return") { const target = repairTargets()[repairSelection()]; if (!target || !repairReason().trim()) setMessage("Repair reason is required"); else if (!repairConfirmed()) setRepairConfirmed(true); else { try { applyRepair(props.repo, props.change, data().state.revision, target.targetStep, repairReason()); setRepairOpen(false); props.keymap.setData("modal.active", "none"); refresh(); setMessage(`Repaired to ${target.label}; resume separately`) } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); refresh() } } } else if (key.length === 1 && !event.ctrl && !event.meta) { setRepairReason(value => `${value}${key}`.slice(0, 256)); setRepairConfirmed(false) } else if (key === "space") { setRepairReason(value => `${value} `.slice(0, 256)); setRepairConfirmed(false) } return true } }],
      bindings: ["escape", "enter", "return", "j", "k", "up", "down", "backspace", "space", ..."abcdefghijklmnopqrstuvwxyz0123456789-_.".split("")].map(key => ({ key, cmd: "repair.handle" })),
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
            } else if (key === "j" || key === "down") { setCompletedSelection((index) => Math.min(Math.max(0, completedActions().length - 1), index + 1)); setActionConfirmed(false) }
            else if (key === "k" || key === "up") { setCompletedSelection((index) => Math.max(0, index - 1)); setActionConfirmed(false) }
            else if (key === 'backspace' && completedActions()[completedSelection()]?.confirmation === 'reason') { setActionReason(value => value.slice(0, -1)); setActionConfirmed(false) }
            else if (key === 'space' && completedActions()[completedSelection()]?.confirmation === 'reason') { setActionReason(value => `${value} `.slice(0, 2048)); setActionConfirmed(false) }
            else if (key.length === 1 && !event.ctrl && !event.meta && completedActions()[completedSelection()]?.confirmation === 'reason') { setActionReason(value => `${value}${key}`.slice(0, 2048)); setActionConfirmed(false) }
            else if (key === "enter" || key === "return") {
              const action = completedActions()[completedSelection()];
              if (!action) return true; if (action.confirmation === 'reason' && !actionReason().trim()) { setMessage('Action reason is required'); return true } if (action.confirmation !== 'none' && !actionConfirmed()) { setActionConfirmed(true); setMessage(`Press Enter again to confirm ${action.label}`); return true }
              setCompletedPicker(false);
              props.keymap.setData("modal.active", "none");
              setBusy(true);
              setMessage(`Running ${action.label}…`);
              void runWorkflow(action.command, props.repo, props.change, data().state.revision, action.confirmation === 'reason' ? JSON.stringify({ reason: actionReason().trim() }) : undefined)
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
      bindings: ["escape", "enter", "return", "j", "k", "up", "down", "backspace", "space", ..."abcdefghijklmnopqrstuvwxyz0123456789-_.".split("")].map(
        (key) => ({ key, cmd: "completed-picker.handle" }),
      ),
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
    const disposeVerification = props.keymap.registerLayer({
      name: "verification-detail",
      priority: 1000,
      activeModal: "verification-detail",
      commands: [
        {
          name: "verification.handle",
          run: ({ event }) => {
            const key = event.name.toLowerCase();
            const entries = data().verifierTimeline;
            if (key === "escape") {
              setVerificationDetail(false);
              props.keymap.setData("modal.active", "none");
            } else if (key === "j" || key === "down")
              setSelectedVerification((value) =>
                Math.min(entries.length - 1, value + 1),
              );
            else if (key === "k" || key === "up")
              setSelectedVerification((value) => Math.max(0, value - 1));
            else if (key === "enter" || key === "return") {
              const entry = entries[selectedVerification()];
              if (!entry) return true;
              try {
                setVerificationDetail(false);
                openVerifierResult(entry.role, true);
              } catch (error) {
                setVerdict({
                  title: `${entry.role} · result pending`,
                  content:
                    error instanceof Error ? error.message : String(error),
                });
                setVerdictOffset(0);
                props.keymap.setData("modal.active", "verdict");
              }
            }
            return true;
          },
        },
      ],
      bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
        (key) => ({ key, cmd: "verification.handle" }),
      ),
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
    const disposeTraces = props.keymap.registerLayer({
      name: "traces",
      priority: 1000,
      activeModal: "traces",
      commands: [
        {
          name: "traces.close",
          run: () => {
            setTraceDetail(false);
            props.keymap.setData("modal.active", "none");
            return true;
          },
        },
      ],
      bindings: [{ key: "escape", cmd: "traces.close" }],
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
            if (key === "escape") {
              setReviewCommentMode(false);
              setReviewCommentText("");
              props.keymap.setData("modal.active", "developer-review");
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
                setMessage("Could not map selected diff line to file line.");
              setReviewVisualMode(false);
              setReviewCommentMode(false);
              setReviewCommentText("");
              props.keymap.setData("modal.active", "developer-review");
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
            } else if (key === "f" && !event.shift)
              void finishDeveloperReview();
            else if (
              reviewView() === "files" &&
              (key === "/" || event.sequence === "/")
            ) {
              setReviewSearchMode(true);
              setReviewSearchQuery("");
              setReviewChangeIndex(0);
            } else if (
              reviewView() === "files" &&
              (key === "j" || key === "down")
            )
              setReviewChangeIndex((index) =>
                Math.min(
                  Math.max(0, reviewVisibleChanges().length - 1),
                  index + 1,
                ),
              );
            else if (reviewView() === "files" && (key === "k" || key === "up"))
              setReviewChangeIndex((index) => Math.max(0, index - 1));
            else if (
              reviewView() === "files" &&
              (key === "enter" || key === "return")
            )
              openReviewDiff();
            else if (reviewView() === "diff" && key === "v") {
              if (reviewVisualMode()) setReviewVisualMode(false);
              else {
                setReviewVisualStart(reviewLine());
                setReviewVisualMode(true);
              }
            } else if (reviewView() === "diff" && key === "n")
              cycleReviewComments(event.shift ? -1 : 1);
            else if (reviewView() === "diff" && key === "s")
              setReviewSplitView((split) =>
                split === null ? dimensions().width < 160 : !split,
              );
            else if (reviewView() === "diff" && (key === "j" || key === "down"))
              setReviewLine((line) =>
                Math.min(
                  Math.max(0, reviewSelectableLineCount() - 1),
                  line + 1,
                ),
              );
            else if (reviewView() === "diff" && (key === "k" || key === "up"))
              setReviewLine((line) => Math.max(0, line - 1));
            else if (
              reviewView() === "diff" &&
              (key === "space" || key === " ")
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
              setReviewCommentText("");
              setReviewCommentMode(true);
              props.keymap.setData("modal.active", "review-comment");
            }
            return true;
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
              const restore = findingsReturnToVerification();
              setFindings(undefined);
              setFindingsReturnToVerification(false);
              if (restore) {
                setVerificationDetail(true);
                props.keymap.setData("modal.active", "verification-detail");
              } else props.keymap.setData("modal.active", "none");
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
        "tab",
        "shift+tab",
        "up",
        "down",
        "enter",
        "return",
        "escape",
      ].map((key) => ({ key, cmd: "detail.handle" })),
    });
    onCleanup(() => {
      disposeTheme();
      disposeCompletedPicker();
      disposeRepair();
      disposeUserAction();
      disposeCost();
      disposeHelp();
      disposeVerification();
      disposeEvents();
      disposeTraces();
      disposeReviewComment();
      disposeDeveloperReview();
      disposeFindings();
      disposeVerdict();
      dispose();
    });
    const anyModalOpen = () =>
      !!(
        verdict() ||
        findings() ||
        verificationDetail() ||
        eventsDetail() ||
        traceDetail() ||
        help() ||
        themePicker() ||
        completedPicker() ||
        repairOpen() ||
        userActionOpen() ||
        costOpen() ||
        reviewOpen() ||
        reviewCommentMode()
      );
    // Self-heal: reconcile keymap modal data with real modal state.
    createEffect(() => {
      if (!anyModalOpen()) props.keymap.setData("modal.active", "none");
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
      setUserActionSelection(0);
      setUserActionOpen(true);
      props.keymap.setData("modal.active", "user-action");
    });
  });
  const doneTasks = createMemo(
    () => data().tasks.filter((task) => task.done).length,
  );
  const currentTask = createMemo(
    () => data().tasks.find((task) => !task.done)?.text ?? "All tasks complete",
  );
  const verificationSummary = createMemo(() => {
    const rows = data().verifierTimeline;
    const count = (status: string) =>
      rows.filter((row) => row.status.toLowerCase() === status).length;
    const reused = Object.keys(
      data().state.verificationReusedResults ?? {},
    ).length;
    return `run ${count("run")} · pass ${count("pass")} · fail ${count("fail")} · skip ${count("skipped")}${reused ? ` · reused:${reused}` : ""}`;
  });
  const prompt = createMemo(() =>
    data().state.status === "paused"
      ? "Verification paused · developer intervention required"
      : (gate()?.prompt ?? "Waiting for workflow activity"),
  );

  return (
    <box style={{ width: '100%', height: '100%' }}>
      <Layout
        content={
          <box
            backgroundColor={uiColors.bgBase}
            style={{
              width: "100%",
              height: "100%",
              flexDirection: "column",
              paddingTop: 1,
              paddingRight: 1,
              paddingBottom: 1,
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
                width="50%"
                height="100%"
                flexDirection="column"
                gap={1}
                flexShrink={0}
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
                      <Badge
                        text={workflowStatus().text}
                        appearance="badge"
                        highlight={
                          workflowStatus().working ? "highlight2" : "secondary"
                        }
                        animation={
                          workflowStatus().working ? "aurora" : "static"
                        }
                      />
                    </box>
                    <Show when={data().state.definition}>
                      {definition => <box flexDirection="row">
                        <box width={7}><text fg={uiColors.textMuted}>FLOW</text></box>
                        <text fg={uiColors.textSecondary}>{definition().label} · v{definition().version}</text>
                      </box>}
                    </Show>
                    <Show when={data().state.ticketNumber}>
                      <box flexDirection="row">
                        <box width={7}>
                          <text fg={uiColors.textMuted}>TICKET</text>
                        </box>
                        <HighlightedText
                          text={data().state.ticketNumber!}
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
                style={{ width: "50%", height: "100%", flexShrink: 0 }}
              >
                <SelectableList
                  items={data().agents}
                  selectedIndex={activePanel() === 1 ? selectedAgent() : -1}
                  renderItem={(agent, selected) => {
                    const timeline = () =>
                      data().verifierTimeline.find(
                        (item) => item.role === agent.role,
                      );
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
                        height={2}
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
                              {timeline()
                                ? (timeline()!.model ??
                                  agent.model ??
                                  "default")
                                : (agent.model ??
                                  (agent.role.endsWith("verifier")
                                    ? "Awaiting verification run"
                                    : "Interactive workflow agent"))}
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
                                  {agent.cost
                                    ? ` · $${agent.cost.toFixed(2)}`
                                    : ""}
                                  {entry().fallback ? " · fallback" : ""}
                                </text>
                              );
                            }}
                          </Show>
                        </box>
                      </box>
                    );
                  }}
                />
              </Panel>
            </box>
            <box
              style={{
                width: "100%",
                height: 5,
                flexShrink: 0,
                flexDirection: "column",
                gap: 1,
              }}
            >
              <box
                style={{
                  width: "100%",
                  height: 2,
                  flexDirection: "row",
                  gap: 1,
                }}
              >
                <Panel
                  title={`Current task · ${doneTasks()}/${data().tasks.length}`}
                  accent={uiColors.success}
                  active={activePanel() === 2}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    height: "100%",
                  }}
                >
                  <text
                    fg={
                      doneTasks() === data().tasks.length
                        ? uiColors.success
                        : uiColors.textPrimary
                    }
                  >
                    {doneTasks() === data().tasks.length ? "✓" : "○"}{" "}
                    {currentTask()}
                  </text>
                </Panel>
                <Panel
                  title="Verification"
                  accent={uiColors.info}
                  active={activePanel() === 3}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    height: "100%",
                  }}
                >
                  <text fg={uiColors.textSecondary}>
                    {verificationSummary()}
                  </text>
                </Panel>
              </box>
              <box
                style={{
                  width: "100%",
                  height: 2,
                  flexDirection: "row",
                  gap: 1,
                }}
              >
                <Panel
                  title="Git status"
                  accent={uiColors.warning}
                  active={activePanel() === 4}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    height: "100%",
                  }}
                >
                  <text
                    fg={
                      data().health.dirty ? uiColors.warning : uiColors.success
                    }
                  >
                    {data().health.dirty
                      ? `changed · ↑${data().health.ahead} ↓${data().health.behind}`
                      : `clean · ↑${data().health.ahead} ↓${data().health.behind}`}
                  </text>
                </Panel>
                <Panel
                  title={`Traces · ${data().traceSpans.length}`}
                  accent={uiColors.primary}
                  active={activePanel() === 5}
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    minWidth: 0,
                    height: "100%",
                  }}
                >
                  <text fg={uiColors.textSecondary}>
                    {data().traceSpans.at(-1)?.name ?? "No spans yet"}
                  </text>
                </Panel>
              </box>
            </box>
          </box>
        }
      />
      <Show when={repairOpen()}>
        <ListViewModal
          title={`Repair r${data().state.revision} · reason: ${repairReason() || "(type reason)"} · ${repairConfirmed() ? "ENTER confirms" : "ENTER previews"}`}
          fieldLabel="Compatible target"
          items={repairTargets().map(target => `${target.label} · expire [${target.expiresRuns.slice(0, 4).join(', ') || 'none'}${target.expiresRuns.length > 4 ? ', …' : ''}] · retain [${target.retainedEvidence.slice(0, 4).join(', ') || 'none'}${target.retainedEvidence.length > 4 ? ', …' : ''}]`)}
          selectedIndex={repairSelection()}
          help={[{ key: "j/k", action: "Target" }, { key: "type", action: "Reason" }, { key: "Enter×2", action: "Confirm" }, { key: "Esc", action: "Cancel" }]}
          renderItem={(item, selected) => <text fg={selected ? uiColors.primary : uiColors.textSecondary}>{item}</text>}
        />
      </Show>
      <Show when={completedPicker()}>
        <ListViewModal
          title={`Choose workflow action · ${actionReason() || (completedActions()[completedSelection()]?.confirmation === 'reason' ? 'type reason' : actionConfirmed() ? 'confirmed' : 'confirmation required')}`}
          fieldLabel="Action"
          items={completedActions().map(action => action.label)}
          selectedIndex={completedSelection()}
          help={[
            { key: "j/k", action: "Navigate" },
            { key: "type", action: "Reason when required" },
            { key: "Enter×2", action: "Confirm and run" },
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
          title={`⚠ ${requiredUserAction()!.title}`}
          fieldLabel={requiredUserAction()!.prompt}
          items={requiredUserAction()!.items}
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
      <Show when={traceDetail()}>
        <box
          position="absolute"
          top={2}
          left={2}
          right={2}
          bottom={2}
          backgroundColor={uiColors.bgBase}
          border
          borderColor={uiColors.primary}
          padding={1}
        >
          <TraceBrowser
            spans={data().traceSpans}
            change={data().state.changeId}
          />
        </box>
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
      <Show when={reviewOpen() && reviewView() === "files"}>
        <box
          position="absolute"
          top={0}
          left={0}
          width={dimensions().width}
          height={dimensions().height}
          backgroundColor={uiColors.bgBase}
        >
          <ChangedFilesView
            changes={reviewChangesForView()}
            selectedIndex={reviewChangeIndex()}
            searchMode={reviewSearchMode()}
            searchQuery={reviewSearchQuery()}
            onClose={() => {
              setReviewOpen(false);
              props.keymap.setData("modal.active", "none");
            }}
          />
        </box>
      </Show>
      <Show when={reviewOpen() && reviewView() === "diff" && reviewDiffFile()}>
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
                    : loadLocalDiff(props.repo, props.change, file);
                setReviewChangeIndex(next);
                setReviewVisualMode(false);
                setReviewVisualStart(0);
                setReviewLine(0);
                setReviewDiff(diff);
              } catch (error) {
                setReviewChangeIndex(previous);
                setMessage(error instanceof Error ? error.message : String(error));
              }
            }}
          />
        )}
      </Show>
      <Show when={verificationDetail()}>
        <VerificationTimelineModal
          startedAt={data().state.verificationStartedAt}
          entries={data().verifierTimeline}
          selected={selectedVerification()}
        />
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
          />
        )}
      </Show>
    </box>
  );
}

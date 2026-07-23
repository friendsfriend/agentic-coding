/** @jsxImportSource @opentui/solid */
import {
  TextAttributes,
  type KeyEvent,
  type ScrollBoxRenderable,
} from "@opentui/core";
import type { Binding, Keymap } from "@opentui/keymap";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
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
  focusAgent,
  focusWorkspace,
  loadDashboard,
  loadDeveloperReviewFindings,
  loadLocalChanges,
  loadLocalDiff,
  loadVerifierFindings,
  loadVerifierReport,
  openFindingInEditor,
  openSpecArtifact,
  openSpecArtifacts,
  operationalPhases,
  runWorkflow,
  saveDeveloperReview,
  testDashboard,
  type DashboardData,
  type DeveloperReviewComment,
  type DeveloperReviewFinding,
  type LocalChange,
} from "./data";
import { Badge } from "./ui/Badge";
import { HighlightedText } from "./ui/Highlight";
import { Header } from "./ui/Header";
import { Layout } from "./ui/Layout";
import { Panel } from "./ui/Panel";
import { StatusBar } from "./ui/StatusBar";
import { VerdictModal } from "./ui/VerdictModal";
import { ScrollableContent } from "./ui/ScrollableContent";
import { VerificationTimelineModal } from "./ui/VerificationTimelineModal";
import { FindingsModal, type FindingEvent } from "./ui/FindingsModal";
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
  const [message, setMessage] = createSignal("");
  let lastQuitAt = 0;
  const [busy, setBusy] = createSignal(false);
  let changeScroll: ScrollBoxRenderable | undefined;
  const [activePanel, setActivePanel] = createSignal(0);
  const [selectedAgent, setSelectedAgent] = createSignal(0);
  const [selectedArtifact, setSelectedArtifact] = createSignal(0);
  const artifacts = createMemo(() => openSpecArtifacts(data().state));
  const [verdict, setVerdict] = createSignal<{
    title: string;
    content: string;
  }>();
  const [verdictReturnToFindings, setVerdictReturnToFindings] =
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
  const [recovery, setRecovery] = createSignal(false);
  const [recoveryRequested, setRecoveryRequested] = createSignal(false);
  const [recoverySelection, setRecoverySelection] = createSignal(0);
  const [overridePicker, setOverridePicker] = createSignal(false);
  const [overrideConfirm, setOverrideConfirm] = createSignal(false);
  const [overrideSelection, setOverrideSelection] = createSignal(0);
  const [overridePhase, setOverridePhase] = createSignal<string>();
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
        old_line: comment.line,
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
        created_at: "",
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
          old_line: finding.line,
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
          created_at: "",
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
          findingId: finding.id,
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
        { key: "Shift+O", description: "Overwrite workflow phase" },
        { key: "v", description: "View selected verifier verdict" },
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
    const restore = verdictReturnToFindings();
    setVerdict(undefined);
    setVerdictReturnToFindings(false);
    if (restore) props.keymap.setData("modal.active", "findings");
    else props.keymap.setData("modal.active", "none");
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
                id: "demo-warning",
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
      const findingComments = reviewFindings()
        .filter((finding) => selectedReviewFindingIds().has(finding.id))
        .map((finding) => ({
          filePath: finding.path ?? "repository",
          line: finding.line ?? 1,
          body: `${finding.detail}${finding.fix ? ` Fix: ${finding.fix}` : ""}`,
          findingId: finding.id,
        }));
      const comments = [...reviewComments(), ...findingComments];
      if (props.profile !== "test") {
        await saveDeveloperReview(props.repo, props.change, comments);
        setMessage(
          await runWorkflow("finish-review", props.repo, props.change),
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
    }
  };
  const gate = createMemo(() => {
    if (props.profile === "test")
      return {
        prompt: "Press Enter to advance demo phase",
        action: "next demo phase",
      };
    if (
      data().state.phase === "fix" &&
      data().agents.find((agent) => agent.role === "worker")?.status !== "idle"
    )
      return undefined;
    return approvalFor(data().state.phase);
  });
  const workflowStatus = createMemo(() => {
    const phase = data().state.phase;
    const active = data().agents.find((agent) => agent.status === "working");
    if (!active) return { text: phase, working: false };
    if (active.role === "planner") return { text: "Planning", working: true };
    if (active.role.endsWith("verifier"))
      return { text: "Verifying", working: true };
    if (active.role === "archive") return { text: "Archiving", working: true };
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
    const timer = setInterval(refresh, 5000);
    onCleanup(() => clearInterval(timer));
  });

  const handleKey = async (key: KeyEvent) => {
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
        focusWorkspace(workspace);
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
      const index = operationalPhases.indexOf(data().state.phase);
      if (index < 0) {
        setMessage(`Phase overwrite unavailable for ${data().state.phase}.`);
        return;
      }
      setOverrideSelection(index);
      setOverridePicker(true);
      props.keymap.setData("modal.active", "override-picker");
      return;
    }
    if (name === "?") {
      setHelp(true);
      setHelpOffset(0);
      props.keymap.setData("modal.active", "help");
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
    if (name === "r" && key.shift) {
      setRecoveryRequested(true);
      setBusy(true);
      setMessage("Starting recovery analysis…");
      void runWorkflow("recover", props.repo, props.change)
        .then(setMessage)
        .catch((error) =>
          setMessage(error instanceof Error ? error.message : String(error)),
        )
        .finally(() => {
          setBusy(false);
          refresh();
        });
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
      if (data().state.phase === "developer-review") {
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
          focusAgent(data().state, data().state.panes.git!);
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
      setBusy(true);
      setMessage(`Running ${approval.action}…`);
      try {
        if (props.profile === "test") {
          setDemoIndex((index) => (index + 1) % demoPhases.length);
          setMessage("Advanced dummy workflow");
        } else {
          setMessage(
            await runWorkflow(approval.action, props.repo, props.change),
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
    const disposeRecovery = props.keymap.registerLayer({
      name: "recovery",
      priority: 1000,
      activeModal: "recovery",
      commands: [
        {
          name: "recovery.handle",
          run: ({ event }) => {
            const key = event.name.toLowerCase();
            if (key === "escape") {
              setRecovery(false);
              props.keymap.setData("modal.active", "none");
            } else if (key === "j" || key === "down") setRecoverySelection(1);
            else if (key === "k" || key === "up") setRecoverySelection(0);
            else if (key === "enter" || key === "return") {
              if (recoverySelection() === 1) {
                setRecovery(false);
                props.keymap.setData("modal.active", "none");
                return true;
              }
              if (!data().recoveryPlan) return true;
              setRecovery(false);
              props.keymap.setData("modal.active", "none");
              setBusy(true);
              void runWorkflow("apply-recovery", props.repo, props.change)
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
      bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
        (key) => ({ key, cmd: "recovery.handle" }),
      ),
    });
    const disposeOverridePicker = props.keymap.registerLayer({
      name: "override-picker",
      priority: 1000,
      activeModal: "override-picker",
      commands: [
        {
          name: "override-picker.handle",
          run: ({ event }) => {
            if (busy()) return true;
            const key = event.name.toLowerCase();
            if (key === "escape") {
              setOverridePicker(false);
              props.keymap.setData("modal.active", "none");
            } else if (key === "j" || key === "down")
              setOverrideSelection((index) =>
                Math.min(operationalPhases.length - 1, index + 1),
              );
            else if (key === "k" || key === "up")
              setOverrideSelection((index) => Math.max(0, index - 1));
            else if (key === "enter" || key === "return") {
              const phase = operationalPhases[overrideSelection()];
              if (!phase) return true;
              setOverridePhase(phase);
              setOverridePicker(false);
              setOverrideSelection(1);
              setOverrideConfirm(true);
              props.keymap.setData("modal.active", "override-confirm");
            }
            return true;
          },
        },
      ],
      bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
        (key) => ({ key, cmd: "override-picker.handle" }),
      ),
    });
    const disposeOverrideConfirm = props.keymap.registerLayer({
      name: "override-confirm",
      priority: 1000,
      activeModal: "override-confirm",
      commands: [
        {
          name: "override-confirm.handle",
          run: ({ event }) => {
            if (busy()) return true;
            const key = event.name.toLowerCase();
            if (key === "escape") {
              setOverrideConfirm(false);
              props.keymap.setData("modal.active", "none");
            } else if (key === "j" || key === "down") setOverrideSelection(1);
            else if (key === "k" || key === "up") setOverrideSelection(0);
            else if (key === "enter" || key === "return") {
              if (overrideSelection() === 1 || !overridePhase()) {
                setOverrideConfirm(false);
                props.keymap.setData("modal.active", "none");
                return true;
              }
              const phase = overridePhase()!;
              setOverrideConfirm(false);
              props.keymap.setData("modal.active", "none");
              setBusy(true);
              setMessage(`Overwriting phase with ${phase}…`);
              void runWorkflow(
                "override-phase",
                props.repo,
                props.change,
                phase,
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
      bindings: ["escape", "enter", "return", "j", "k", "up", "down"].map(
        (key) => ({ key, cmd: "override-confirm.handle" }),
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
      disposeRecovery();
      disposeOverridePicker();
      disposeOverrideConfirm();
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
  });

  createEffect(() => {
    if (recoveryRequested() && data().recoveryPlan) {
      setRecoveryRequested(false);
      setRecoverySelection(0);
      setRecovery(true);
      props.keymap.setData("modal.active", "recovery");
    }
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
    const cost = data().telemetrySummary.reduce(
      (sum, row) => sum + row.cost,
      0,
    );
    const reused = Object.keys(
      data().state.verificationReusedResults ?? {},
    ).length;
    return `run ${count("run")} · pass ${count("pass")} · fail ${count("fail")} · skip ${count("skipped")}${reused ? ` · reused:${reused}` : ""} · $${cost.toFixed(2)}`;
  });
  const prompt = createMemo(() =>
    data().state.phase === "paused"
      ? "Verification paused · developer intervention required"
      : (gate()?.prompt ?? "Waiting for workflow activity"),
  );
  const stallBanner = createMemo(() => {
    const phase = data().state.phase;
    if (phase === "paused") return "Workflow paused";
    if (
      !["explore", "apply", "fix", "triage", "verify", "archive"].includes(
        phase,
      ) ||
      data().agents.some((agent) => agent.status === "working")
    )
      return undefined;
    const since =
      data().state.phaseStartedAt ??
      data().state.verificationStartedAt ??
      data().state.createdAt;
    const minutes = since
      ? Math.floor((Date.now() - Date.parse(since)) / 60000)
      : 0;
    return minutes >= 10 ? `${phase} idle for ${minutes}m` : undefined;
  });

  return (
    <box width={dimensions().width} height={dimensions().height}>
      <Layout
        header={
          <Header
            change={data().state.changeId}
            phase={data().state.phase}
            branch={data().state.branch}
            updated={data().updated}
          />
        }
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
            <Show when={stallBanner()}>
              {(message) => (
                <box
                  width="100%"
                  height={1}
                  flexShrink={0}
                  backgroundColor={uiColors.warning}
                  paddingLeft={1}
                  paddingRight={1}
                  flexDirection="row"
                >
                  <text fg={uiColors.bgBase}>
                    WORKFLOW MAY BE STALLED · {message()}
                  </text>
                  <box flexGrow={1} />
                  <text fg={uiColors.bgBase}>Shift+R recovery</text>
                </box>
              )}
            </Show>
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
                    <Show
                      when={
                        data().state.workflowModules ||
                        data().state.phase !== "closed"
                      }
                    >
                      <box flexDirection="row">
                        <box width={7}>
                          <text fg={uiColors.textMuted}>TYPE</text>
                        </box>
                        <text fg={uiColors.textSecondary}>
                          {(data().state.workflowModules ?? [
                            "plan",
                            "plan-approval",
                            "apply-verify",
                            "developer-approval",
                            "archive",
                          ])[0] === "plan"
                            ? "standard"
                            : "direct-apply"}{" "}
                          ·{" "}
                          {
                            (
                              data().state.workflowModules ?? [
                                "plan",
                                "plan-approval",
                                "apply-verify",
                                "developer-approval",
                                "archive",
                              ]
                            ).length
                          }{" "}
                          modules
                        </text>
                      </box>
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
                            {(entry) => (
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
                                {entry().durationSeconds !== undefined
                                  ? ` · ${entry().durationSeconds}s`
                                  : ""}
                                {entry().cost
                                  ? ` · $${(entry().cost ?? 0).toFixed(2)}`
                                  : ""}
                                {entry().fallback ? " · fallback" : ""}
                              </text>
                            )}
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
        footer={
          <StatusBar
            prompt={
              activePanel() === 1
                ? "Selected agent"
                : activePanel() === 3
                  ? "Verification timeline"
                  : prompt()
            }
            approval={activePanel() !== 1 && !!gate() && !busy()}
            keybinds={[
              ...(activePanel() === 2
                ? [{ key: "Enter", action: "view tasks" }]
                : activePanel() === 3
                  ? [{ key: "Enter", action: "view timeline" }]
                  : activePanel() === 4
                    ? [{ key: "Enter", action: "open lazygit" }]
                    : activePanel() === 5
                      ? [{ key: "Enter", action: "view traces" }]
                      : activePanel() === 6
                        ? [{ key: "Enter", action: "open artifact" }]
                        : activePanel() !== 1 && !!gate() && !busy()
                          ? [{ key: "Enter", action: "approve" }]
                          : activePanel() === 1
                            ? [
                                { key: "Enter", action: "focus agent" },
                                { key: "v", action: "view verdict" },
                              ]
                            : []),
              ...(gate() ? [{ key: "Shift+R", action: "recover" }] : []),
              { key: "Shift+O", action: "overwrite phase" },
              { key: "r", action: "refresh" },
              { key: "Esc", action: "dashboard" },
              { key: "q", action: "quit" },
            ]}
          />
        }
      />
      <Show when={recovery()}>
        <ListViewModal
          title="Recovery"
          fieldLabel="Choose action"
          items={[
            `Apply: ${data().recoveryPlan?.action ?? "unavailable"}${data().recoveryPlan?.role ? ` · ${data().recoveryPlan?.role}` : ""}`,
            "Cancel",
          ]}
          selectedIndex={recoverySelection()}
          help={[
            { key: "j/k", action: "Navigate" },
            { key: "Enter", action: "Confirm" },
            { key: "Esc", action: "Cancel" },
          ]}
          renderItem={(item, selected) => (
            <text fg={selected ? uiColors.primary : uiColors.textSecondary}>
              {item}
            </text>
          )}
        />
      </Show>
      <Show when={overridePicker()}>
        <ListViewModal
          title="Overwrite workflow phase"
          fieldLabel="Choose phase"
          items={operationalPhases}
          selectedIndex={overrideSelection()}
          help={[
            { key: "j/k", action: "Navigate" },
            { key: "Enter", action: "Continue" },
            { key: "Esc", action: "Cancel" },
          ]}
          renderItem={(item, selected) => (
            <text fg={selected ? uiColors.primary : uiColors.textSecondary}>
              {item}
            </text>
          )}
        />
      </Show>
      <Show when={overrideConfirm()}>
        <ListViewModal
          title={`Overwrite ${data().state.phase} → ${overridePhase() ?? ""}`}
          fieldLabel="Confirm overwrite"
          items={["Overwrite phase", "Cancel"]}
          selectedIndex={overrideSelection()}
          help={[
            { key: "j/k", action: "Navigate" },
            { key: "Enter", action: "Confirm" },
            { key: "Esc", action: "Cancel" },
          ]}
          renderItem={(item, selected) => (
            <text fg={selected ? uiColors.warning : uiColors.textSecondary}>
              {item}
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { decodeJsonl, type TraceSpan } from "./traces";

export interface WorkflowState {
  changeId: string;
  phase: string;
  repository: string;
  worktree: string;
  branch: string;
  workspace: string;
  verificationRound: number;
  baseCommit?: string;
  createdAt?: string;
  phaseStartedAt?: string;
  ticketNumber?: string;
  workerModel?: string;
  returnWorkspace?: string;
  verificationTier?: string;
  verificationRoles?: string[];
  verificationResults?: Record<string, unknown>;
  verificationReusedResults?: Record<string, unknown>;
  verificationStartedAt?: string;
  testVerifierStarted?: boolean;
  verificationTimeoutRoles?: string[];
  verificationRoleStartedAt?: Record<string, string>;
  verificationModels?: Record<string, string>;
  recoveryRunId?: string;
  planQuality?: {
    passed: boolean;
    issues: string[];
    specFiles: number;
    taskCount: number;
  };
  workflowModules?: string[];
  panes: Record<string, string>;
}

export interface WorkflowOverview {
  state: WorkflowState;
  workspaceOpen: boolean;
  tasks: [number, number];
  agents: Array<{ role: string; status: string; model?: string }>;
}

function openWorkspaceIds(): Set<string> | undefined {
  const result = Bun.spawnSync(["herdr", "workspace", "list"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  try {
    const workspaces = JSON.parse(result.stdout.toString()).result
      .workspaces as Array<{ workspace_id: string }>;
    return new Set(workspaces.map((workspace) => workspace.workspace_id));
  } catch {
    return undefined;
  }
}

export function listWorkflows(...roots: string[]): WorkflowOverview[] {
  const found: WorkflowOverview[] = [];
  const seen = new Set<string>();
  const openWorkspaces = openWorkspaceIds();
  const statuses = agentStatuses();
  const walk = (directory: string, depth: number) => {
    if (depth > 4 || !existsSync(directory)) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && entry.name === ".herdr-workflow") {
        let changes;
        try {
          changes = readdirSync(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const change of changes) {
          const statePath = join(path, change.name, "state.json");
          if (!change.isDirectory() || !existsSync(statePath)) continue;
          try {
            const state = JSON.parse(read(statePath)) as WorkflowState;
            if (seen.has(state.workspace)) continue;
            seen.add(state.workspace);
            const tasksFile = join(
              state.worktree,
              "openspec",
              "changes",
              state.changeId,
              "tasks.md",
            );
            const items = tasks(tasksFile);
            const workspaceOpen = openWorkspaces
              ? openWorkspaces.has(state.workspace)
              : state.phase !== "closed";
            found.push({
              state,
              workspaceOpen,
              tasks: [items.filter((item) => item.done).length, items.length],
              agents: Object.entries(state.panes)
                .filter(([role]) => !["git", "dashboard"].includes(role))
                .map(([role, pane]) => ({
                  role,
                  status:
                    statuses.get(pane) ??
                    (workspaceOpen ? "not started" : "closed"),
                  model:
                    role === "worker"
                      ? state.workerModel
                      : state.verificationModels?.[role],
                })),
            });
          } catch {
            /* ignore stale state */
          }
        }
        continue;
      }
      if (
        entry.name.startsWith(".") ||
        ["node_modules", "target", "dist", "build"].includes(entry.name)
      )
        continue;
      if (entry.isDirectory()) walk(path, depth + 1);
    }
  };
  if (roots.length === 0)
    roots = [join(homedir(), "development"), process.cwd()];
  for (const root of roots) walk(root, 0);
  return found.sort((a, b) => a.state.changeId.localeCompare(b.state.changeId));
}

export interface LocalChange {
  oldPath?: string;
  newPath: string;
  linesAdded: number;
  linesDeleted: number;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
}

export interface DeveloperReviewComment {
  filePath: string;
  line: number;
  startLine?: number;
  endLine?: number;
  body: string;
  findingId?: string;
}

export interface DeveloperReviewFinding {
  id: string;
  severity: "warning" | "info";
  path?: string;
  line?: number;
  detail: string;
  evidence?: string;
  fix?: string;
}

export interface DashboardData {
  state: WorkflowState;
  request: string;
  proposal: string;
  tasks: Array<{ done: boolean; text: string }>;
  review: string;
  reviewHistory: string[];
  agents: Array<{ role: string; status: string; model?: string }>;
  updated: string;
  health: { dirty: boolean; ahead: number; behind: number; branch: string };
  age: string;
  currentTask: string;
  events: Array<{
    at: string;
    event: string;
    role?: string;
    model?: string;
    cost?: number;
    status?: number;
    tier?: string;
    roles?: string[];
    reports?: string[];
    fallback?: string;
  }>;
  verifierTimeline: Array<{
    role: string;
    status: string;
    durationSeconds?: number;
    model?: string;
    cost?: number;
    providerErrors: number;
    fallback: boolean;
  }>;
  telemetrySummary: Array<{
    model: string;
    durationSeconds: number;
    errors: number;
    fallbacks: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  traceSpans: TraceSpan[];
  recoveryPlan?: { recoveryId: string; action: string; role?: string };
}

export const operationalPhases = [
  "explore",
  "proposed",
  "apply",
  "fix",
  "triage",
  "verify",
  "paused",
  "developer-review",
  "archive",
  "committing",
  "completed",
];

const read = (path: string) =>
  existsSync(path) ? readFileSync(path, "utf8") : "";

function summary(path: string) {
  const lines = read(path)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line && !line.startsWith("#") && !line.startsWith("<!--"),
    );
  return (
    lines
      .slice(0, 3)
      .map((line) => line.replace(/^[-*]\s+/, ""))
      .join(" ") || "Not created yet"
  );
}

function tasks(path: string) {
  return [...read(path).matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)].map(
    (match) => ({
      done: match[1]!.toLowerCase() === "x",
      text: match[2]!.trim(),
    }),
  );
}

function reviewHistory(root: string) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((file) => /^round-\d+-consolidated\.md$/.test(file))
    .sort()
    .map((file) => {
      const verdict =
        read(join(root, file)).match(
          /^Overall verdict: (PASS|FAIL|PENDING)$/m,
        )?.[1] ?? "UNKNOWN";
      return `${file}: ${verdict}`;
    });
}

function latestReview(root: string) {
  return reviewHistory(root).at(-1) ?? "Not run";
}

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const error = result.stderr.toString().trim();
    if (error) console.error(`git ${args.join(" ")}: ${error}`);
    return null;
  }
  return result.stdout.toString().trim();
}
function gitResult(repo: string, ...args: string[]) {
  return Bun.spawnSync(["git", ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "ignore",
  });
}
function telemetryEvents(path: string): Array<Record<string, any>> {
  return read(path)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function validRecoveryPlan(
  state: WorkflowState,
  plan: unknown,
): plan is { recoveryId: string; action: string; role?: string } {
  if (!plan || typeof plan !== "object") return false;
  const value = plan as Record<string, unknown>;
  if (
    value.recoveryId !== state.recoveryRunId ||
    typeof value.action !== "string"
  )
    return false;
  const expectedKeys =
    value.action === "record-verifier-result"
      ? ["recoveryId", "action", "role"]
      : ["recoveryId", "action"];
  if (!expectedKeys.every((key) => key in value)) return false;
  if (value.action === "retry-verification")
    return ["apply", "fix", "paused"].includes(state.phase);
  if (value.action === "dispatch-triage") return state.phase === "triage";
  return (
    value.action === "record-verifier-result" &&
    state.phase === "verify" &&
    typeof value.role === "string" &&
    [
      ...(state.verificationRoles ?? [
        "security-verifier",
        "agents-verifier",
        "quality-verifier",
        "performance-verifier",
        "openspec-verifier",
      ]),
      "test-verifier",
    ].includes(value.role)
  );
}

function agentStatuses() {
  const result = Bun.spawnSync(["herdr", "agent", "list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return new Map<string, string>();
  try {
    const agents = JSON.parse(result.stdout.toString()).result.agents as Array<{
      pane_id: string;
      agent_status: string;
    }>;
    return new Map(agents.map((agent) => [agent.pane_id, agent.agent_status]));
  } catch {
    return new Map<string, string>();
  }
}

export function loadVerifierFindings(
  repo: string,
  change: string,
  role: string,
) {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const path = join(
    state.worktree,
    ".herdr-workflow",
    change,
    "reviews",
    `round-${state.verificationRound}-${role}.findings.jsonl`,
  );
  if (!existsSync(path)) return undefined;
  const events = read(path)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  return {
    title: `${role} · round ${state.verificationRound}`,
    events: events as Array<{
      type: string;
      verdict?: string;
      severity?: string;
      path?: string;
      line?: number;
      detail?: string;
      evidence?: string;
      changedCode?: string;
      fix?: string;
    }>,
  };
}

export function loadDeveloperReviewFindings(
  repo: string,
  change: string,
): DeveloperReviewFinding[] {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const path = join(
    state.worktree,
    ".herdr-workflow",
    change,
    "reviews",
    "findings.json",
  );
  if (!existsSync(dirname(path)))
    throw new Error(`Review directory not found: ${dirname(path)}`);
  if (!existsSync(path)) return [];
  let payload: {
    rounds?: Record<string, Array<Record<string, unknown>>>;
  };
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  return (payload.rounds?.[String(state.verificationRound)] ?? [])
    .filter(
      (item) =>
        (item.severity === "warning" || item.severity === "info") &&
        (item.status === "new" || item.status === "unfixed") &&
        typeof item.id === "string" &&
        typeof item.detail === "string",
    )
    .map((item) => ({
      id: item.id as string,
      severity: item.severity as "warning" | "info",
      path: typeof item.path === "string" ? item.path : undefined,
      line: typeof item.line === "number" ? item.line : undefined,
      detail: item.detail as string,
      evidence: typeof item.evidence === "string" ? item.evidence : undefined,
      fix: typeof item.fix === "string" ? item.fix : undefined,
    }));
}

export function loadVerifierReport(repo: string, change: string, role: string) {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const reviews = join(state.worktree, ".herdr-workflow", change, "reviews");
  const jsonl = join(
    reviews,
    `round-${state.verificationRound}-${role}.findings.jsonl`,
  );
  if (existsSync(jsonl)) {
    const entries = read(jsonl)
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const content =
      entries
        .map((entry) => {
          if (entry.type === "verdict")
            return `# Verdict\n${String(entry.verdict ?? "UNKNOWN")}`;
          return [
            `# ${(entry.severity ?? "info").toString().toUpperCase()} · ${entry.path ?? "repository"}`,
            entry.line ? `Line ${entry.line}` : "",
            String(entry.detail ?? ""),
            entry.evidence
              ? `Evidence: ${entry.evidence}`
              : entry.changedCode
                ? `Changed code: ${entry.changedCode}`
                : "",
            entry.fix ? `Resolution: ${entry.fix}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n\n") || "# No findings";
    return { title: `${role} · round ${state.verificationRound}`, content };
  }
  const markdown = join(reviews, `round-${state.verificationRound}-${role}.md`);
  if (!existsSync(markdown))
    throw new Error(`No verdict result yet for ${role}.`);
  return {
    title: `${role} · round ${state.verificationRound}`,
    content: read(markdown),
  };
}

export function loadLocalChanges(repo: string, change: string): LocalChange[] {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const base = state.baseCommit ?? "HEAD";
  const changes = new Map<string, LocalChange>();
  const numstat =
    git(
      repo,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--numstat",
      base,
      "--",
    ) ?? "";
  for (const line of numstat.split(/\r?\n/).filter(Boolean)) {
    const [added, deleted, path] = line.split("\t");
    if (!path) continue;
    changes.set(path, {
      newPath: path,
      linesAdded: Number(added) || 0,
      linesDeleted: Number(deleted) || 0,
      newFile: false,
      deletedFile: false,
      renamedFile: false,
    });
  }
  const statuses =
    git(
      repo,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--name-status",
      base,
      "--",
    ) ?? "";
  for (const line of statuses.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") && parts[2]) {
      const existing = changes.get(parts[2]) ?? {
        newPath: parts[2],
        linesAdded: 0,
        linesDeleted: 0,
        newFile: false,
        deletedFile: false,
        renamedFile: true,
      };
      existing.oldPath = parts[1];
      existing.renamedFile = true;
      changes.set(parts[2], existing);
      changes.delete(parts[1]!);
    } else if (parts[1]) {
      const path = parts[1];
      const existing = changes.get(path) ?? {
        newPath: path,
        linesAdded: 0,
        linesDeleted: 0,
        newFile: false,
        deletedFile: false,
        renamedFile: false,
      };
      existing.newFile = status === "A";
      existing.deletedFile = status === "D";
      changes.set(path, existing);
    }
  }
  for (const line of (git(repo, "status", "--short") ?? "")
    .split(/\r?\n/)
    .filter(Boolean)) {
    if (!line.startsWith("?? ")) continue;
    const path = line.slice(3);
    if (path === ".herdr-workflow" || path.startsWith(".herdr-workflow/"))
      continue;
    if (changes.has(path)) continue;
    const result = gitResult(
      repo,
      "diff",
      "--no-index",
      "--numstat",
      "/dev/null",
      path,
    );
    const [added] = result.stdout.toString().trim().split("\t");
    changes.set(path, {
      newPath: path,
      linesAdded: Number(added) || 0,
      linesDeleted: 0,
      newFile: true,
      deletedFile: false,
      renamedFile: false,
    });
  }
  return [...changes.values()].sort((a, b) =>
    a.newPath.localeCompare(b.newPath),
  );
}

export function loadLocalDiff(
  repo: string,
  change: string,
  file: LocalChange,
): string {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const base = state.baseCommit ?? "HEAD";
  const paths =
    file.oldPath && file.oldPath !== file.newPath
      ? [file.oldPath, file.newPath]
      : [file.newPath];
  const result = gitResult(
    repo,
    "diff",
    "--no-ext-diff",
    "--find-renames",
    base,
    "--",
    ...paths,
  );
  if (result.stdout.toString()) return result.stdout.toString();
  if (!file.newFile) return "";
  return gitResult(
    repo,
    "diff",
    "--no-ext-diff",
    "--no-index",
    "/dev/null",
    file.newPath,
  ).stdout.toString();
}

export async function saveDeveloperReview(
  repo: string,
  change: string,
  comments: DeveloperReviewComment[],
) {
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const path = join(
    state.worktree,
    ".herdr-workflow",
    change,
    "reviews",
    "developer-review.json",
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ comments }, null, 2) + "\n");
}

export function loadDashboard(repo: string, change: string): DashboardData {
  Bun.spawnSync(
    ["herdr-workflow", "check-timeout", "--repo", repo, "--change", change],
    { stdout: "ignore", stderr: "ignore" },
  );
  const state = JSON.parse(
    read(join(repo, ".herdr-workflow", change, "state.json")),
  ) as WorkflowState;
  const workflowRoot = join(state.worktree, ".herdr-workflow", change);
  const changeRoot = join(state.worktree, "openspec", "changes", change);
  const statuses = agentStatuses();
  const closedPlannerPhases = new Set([
    "verify",
    "fix",
    "paused",
    "developer-review",
    "archive",
    "completed",
    "closed",
  ]);
  const telemetry = telemetryEvents(join(workflowRoot, "telemetry.jsonl"));
  const roles = [
    ...(state.verificationRoles ?? []),
    ...(state.testVerifierStarted ? ["test-verifier"] : []),
  ];
  const results = state.verificationResults ?? {};
  const verifierTimeline = roles.map((role) => {
    const result = results[role] as { verdict?: string } | undefined;
    const roleEvents = telemetry.filter((event) => event.role === role);
    const responseErrors = roleEvents.filter(
      (event) =>
        event.event === "provider_response" && Number(event.status) >= 400,
    ).length;
    const started = state.verificationRoleStartedAt?.[role];
    const ended = [...roleEvents]
      .reverse()
      .find((event) => event.event === "verifier_result")?.at;
    const durationSeconds = started
      ? Math.max(
          0,
          Math.floor(
            ((ended ? Date.parse(ended) : Date.now()) - Date.parse(started)) /
              1000,
          ),
        )
      : undefined;
    return {
      role,
      cost: roleEvents
        .filter((event) => event.event === "model_usage")
        .reduce((sum, event) => sum + Number(event.cost ?? 0), 0),
      status:
        result?.verdict ??
        (state.verificationTimeoutRoles?.includes(role)
          ? "TIMEOUT"
          : (statuses.get(state.panes[role] ?? "") ?? "RUN")),
      durationSeconds,
      model: state.verificationModels?.[role],
      providerErrors: responseErrors,
      fallback: roleEvents.some(
        (event) => event.event === "provider_launch_fallback",
      ),
    };
  });
  const summaryByModel = new Map<
    string,
    {
      model: string;
      durationSeconds: number;
      errors: number;
      fallbacks: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    }
  >();
  for (const event of telemetry) {
    const model = String(event.model ?? "unknown");
    const summary = summaryByModel.get(model) ?? {
      model,
      durationSeconds: 0,
      errors: 0,
      fallbacks: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    if (event.event === "verifier_result")
      summary.durationSeconds += Number(event.duration_seconds ?? 0);
    if (event.event === "provider_response" && Number(event.status) >= 400)
      summary.errors++;
    if (event.event === "provider_launch_fallback") summary.fallbacks++;
    if (event.event === "model_usage") {
      summary.inputTokens += Number(event.inputTokens ?? 0);
      summary.outputTokens += Number(event.outputTokens ?? 0);
      summary.cost += Number(event.cost ?? 0);
    }
    summaryByModel.set(model, summary);
  }
  return {
    state,
    request: summary(join(workflowRoot, "request.md")),
    proposal: summary(join(changeRoot, "proposal.md")),
    tasks: tasks(join(changeRoot, "tasks.md")),
    review: latestReview(join(workflowRoot, "reviews")),
    reviewHistory: reviewHistory(join(workflowRoot, "reviews")),
    agents: Object.entries(state.panes)
      .filter(([role]) => !["git", "dashboard"].includes(role))
      .map(([role, pane]) => ({
        role,
        status:
          statuses.get(pane) ??
          (role === "planner" && closedPlannerPhases.has(state.phase)
            ? "closed"
            : "not started"),
        model:
          role === "worker"
            ? state.workerModel
            : state.verificationModels?.[role],
      })),
    updated: new Date().toLocaleTimeString(),
    health: {
      dirty: !!(git(state.worktree, "status", "--porcelain") ?? ""),
      ahead:
        Number(
          git(state.worktree, "rev-list", "--count", "@{upstream}..HEAD") ??
            "",
        ) || 0,
      behind:
        Number(
          git(state.worktree, "rev-list", "--count", "HEAD..@{upstream}") ??
            "",
        ) || 0,
      branch: git(state.worktree, "branch", "--show-current") ?? "",
    },
    age: state.createdAt
      ? `${Math.max(0, Math.floor((Date.now() - Date.parse(state.createdAt)) / 3600000))}h`
      : "unknown",
    currentTask:
      state.phase === "explore"
        ? "Planner exploring change"
        : state.phase === "apply" || state.phase === "fix"
          ? (tasks(join(changeRoot, "tasks.md")).find((task) => !task.done)
              ?.text ?? "Worker completing tasks")
          : state.phase === "verify"
            ? "Verification in progress"
            : state.phase === "committing"
              ? "Pushing changes"
              : state.phase,
    events: telemetry
      .slice(-20)
      .map((event) => ({
        at: new Date(event.at).toLocaleTimeString(),
        event: String(event.event),
        role: event.role as string | undefined,
        model: event.model as string | undefined,
        cost: Number(event.cost ?? 0) || undefined,
        status: Number(event.status ?? 0) || undefined,
        tier: event.tier as string | undefined,
        roles: event.roles as string[] | undefined,
        reports: event.reports as string[] | undefined,
        fallback: event.fallback as string | undefined,
      })),
    verifierTimeline,
    telemetrySummary: [...summaryByModel.values()],
    traceSpans: decodeJsonl(read(join(workflowRoot, "traces.jsonl"))),
    recoveryPlan: (() => {
      try {
        const plan: unknown = JSON.parse(
          read(join(workflowRoot, "reviews", "recovery-plan.json")),
        );
        return validRecoveryPlan(state, plan) ? plan : undefined;
      } catch {
        return undefined;
      }
    })(),
  };
}

export function testDashboard(phase = "proposed"): DashboardData {
  const applying = [
    "apply",
    "verify",
    "developer-review",
    "archive",
    "committing",
    "completed",
    "closed",
  ].includes(phase);
  const verified = [
    "developer-review",
    "archive",
    "committing",
    "completed",
    "closed",
  ].includes(phase);
  const archived = ["completed", "closed"].includes(phase);
  return {
    state: {
      changeId: "demo-optional-realisation-date",
      phase,
      repository: "/demo/customer-mw",
      worktree: "/demo/worktrees/demo-optional-realisation-date",
      branch: "feature/demo-optional-realisation-date",
      workspace: "demo",
      verificationRound: verified ? 2 : phase === "verify" ? 1 : 0,
      ticketNumber: "12345",
      panes: {
        dashboard: "demo:p1",
        planner: "demo:p2",
        worker: "demo:p3",
        "security-verifier": "demo:p4",
        "agents-verifier": "demo:p5",
        "test-verifier": "demo:p6",
        "quality-verifier": "demo:p7",
        "performance-verifier": "demo:p8",
        "openspec-verifier": "demo:p9",
        git: "demo:p10",
      },
    },
    request:
      "Make preferredLatestRealisationDate optional and default it to null.",
    proposal:
      "Update API contract, persistence mapping, form defaults, and regression coverage while preserving existing supplied values.",
    tasks: [
      { done: applying, text: "Make API field optional and nullable" },
      { done: applying, text: "Use null as default value" },
      { done: verified, text: "Update frontend form handling" },
      { done: verified, text: "Add regression tests" },
      { done: archived, text: "Archive OpenSpec change" },
    ],
    review: verified
      ? "round-2.md: PASS"
      : phase === "verify"
        ? "round-1.md: FAIL"
        : "Not run",
    reviewHistory: verified
      ? ["round-1-consolidated.md: CLEAR", "round-2-consolidated.md: CLEAR"]
      : [],
    agents: [
      { role: "planner", status: applying ? "closed" : "idle" },
      {
        role: "worker",
        status:
          phase === "apply" ? "working" : applying ? "idle" : "not started",
      },
      ...[
        "security-verifier",
        "agents-verifier",
        "quality-verifier",
        "performance-verifier",
        "openspec-verifier",
      ].map((role) => ({
        role,
        status:
          phase === "verify" ? "working" : verified ? "done" : "not started",
      })),
      {
        role: "test-verifier",
        status:
          phase === "verify"
            ? "not started"
            : verified
              ? "done"
              : "not started",
      },
      ...(phase === "archive" || archived
        ? [{ role: "archive", status: archived ? "done" : "working" }]
        : []),
    ],
    updated: new Date().toLocaleTimeString(),
    health: {
      dirty: false,
      ahead: 0,
      behind: 0,
      branch: "feature/demo-optional-realisation-date",
    },
    age: "2h",
    currentTask: applying
      ? "Apply next implementation task"
      : "Planner exploring change",
    events: [
      {
        at: "10:42",
        event: "verification_started",
        tier: "standard",
        roles: ["security-verifier", "quality-verifier"],
      },
      {
        at: "10:40",
        event: "pi_agent_start",
        role: "worker",
        model: "claude-sonnet",
      },
    ],
    verifierTimeline:
      phase === "verify"
        ? [
            {
              role: "security-verifier",
              status: "PASS",
              durationSeconds: 42,
              model: "claude-sonnet",
              providerErrors: 0,
              fallback: false,
            },
            {
              role: "quality-verifier",
              status: "PASS",
              durationSeconds: 78,
              model: "claude-sonnet",
              providerErrors: 0,
              fallback: false,
            },
            {
              role: "test-verifier",
              status: "RUN",
              durationSeconds: 184,
              model: "claude-sonnet",
              providerErrors: 0,
              fallback: false,
            },
          ]
        : [],
    telemetrySummary: [
      {
        model: "claude-sonnet",
        durationSeconds: 304,
        errors: 0,
        fallbacks: 0,
        inputTokens: 12300,
        outputTokens: 3400,
        cost: 0.12,
      },
    ],
    traceSpans: [],
  };
}

export function approvalFor(phase: string) {
  return (
    {
      proposed: { prompt: "Press Enter to approve apply", action: "apply" },
      fix: { prompt: "Press Enter to retry verification", action: "verify" },
      paused: {
        prompt: "Press Enter to resume verification",
        action: "verify",
      },
      "developer-review": {
        prompt: "Press Enter to review changed files",
        action: "review",
      },
      completed: {
        prompt: "Press Enter to close Herdr workspace",
        action: "close",
      },
    } as Record<string, { prompt: string; action: string }>
  )[phase];
}

export function availableModels(): string[] {
  const result = Bun.spawnSync(["pi", "--list-models"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0)
    return ["openai-codex/gpt-5.6-luna", "opencode-go/deepseek-v4-flash"];
  const models = result.stdout
    .toString()
    .split(/\r?\n/)
    .flatMap((line) => {
      const columns = line.trim().split(/\s+/);
      if (
        columns.length < 2 ||
        columns[0] === "provider" ||
        columns[0] === "---"
      )
        return [];
      return [`${columns[0]}/${columns[1]}`];
    });
  return [...new Set(models)];
}

export function herdrAvailable() {
  return Bun.which("herdr") !== null;
}

export function notifyHerdrError(message: string) {
  if (!herdrAvailable()) return false;
  return (
    Bun.spawnSync(
      [
        "herdr",
        "notification",
        "show",
        "Workflow execution failed",
        "--body",
        message,
        "--sound",
        "request",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exitCode === 0
  );
}

export function focusWorkspace(workspace: string) {
  const result = Bun.spawnSync(["herdr", "workspace", "focus", workspace], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      (
        result.stderr.toString() ||
        result.stdout.toString() ||
        "workspace focus failed"
      ).trim(),
    );
}

function openSpecRoot(state: WorkflowState) {
  const changes = join(state.worktree, "openspec", "changes");
  const active = join(changes, state.changeId);
  if (existsSync(active)) return active;
  const archive = join(changes, "archive");
  try {
    const entry = readdirSync(archive).find(
      (name) => name === state.changeId || name.endsWith(`-${state.changeId}`),
    );
    return entry ? join(archive, entry) : active;
  } catch {
    return active;
  }
}
export function openSpecArtifacts(state: WorkflowState) {
  try {
    return Array.from(
      new Bun.Glob("**/*.md").scanSync({ cwd: openSpecRoot(state) }),
    ).sort();
  } catch {
    return [];
  }
}
export function openSpecArtifact(state: WorkflowState, artifact: string) {
  return read(join(openSpecRoot(state), artifact));
}

export function openFindingInEditor(
  state: WorkflowState,
  finding: { path?: string; line?: number },
) {
  if (!finding.path) throw new Error("Finding has no file path.");
  const file = join(state.worktree, finding.path);
  const tab = Bun.spawnSync(
    [
      "herdr",
      "tab",
      "create",
      "--workspace",
      state.workspace,
      "--label",
      `finding:${finding.path.split("/").at(-1)}`,
      "--focus",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (tab.exitCode !== 0)
    throw new Error(
      (tab.stderr.toString() || "editor tab creation failed").trim(),
    );
  const pane = JSON.parse(tab.stdout.toString()).result.root_pane
    .pane_id as string;
  const editor = process.env.EDITOR || "vi";
  const command = `${editor} +${finding.line ?? 1} ${JSON.stringify(file)}`;
  const run = Bun.spawnSync(["herdr", "pane", "run", pane, command], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0)
    throw new Error((run.stderr.toString() || "editor launch failed").trim());
}

export function focusAgent(state: WorkflowState, pane: string) {
  focusWorkspace(state.workspace);
  const paneInfo = Bun.spawnSync(["herdr", "pane", "get", pane], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (paneInfo.exitCode !== 0)
    throw new Error(
      (paneInfo.stderr.toString() || "agent pane not found").trim(),
    );
  const tabId = JSON.parse(paneInfo.stdout.toString()).result.pane
    .tab_id as string;
  const tab = Bun.spawnSync(["herdr", "tab", "focus", tabId], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tab.exitCode !== 0)
    throw new Error((tab.stderr.toString() || "agent tab focus failed").trim());
  for (let attempt = 0; attempt < 8; attempt++) {
    const layoutResult = Bun.spawnSync(
      ["herdr", "pane", "layout", "--pane", pane],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (layoutResult.exitCode !== 0)
      throw new Error(
        (layoutResult.stderr.toString() || "agent pane layout failed").trim(),
      );
    const layout = JSON.parse(layoutResult.stdout.toString()).result.layout as {
      focused_pane_id: string;
      panes: Array<{
        pane_id: string;
        rect: { x: number; y: number; width: number; height: number };
      }>;
    };
    if (layout.focused_pane_id === pane) return;
    const current = layout.panes.find(
      (item) => item.pane_id === layout.focused_pane_id,
    );
    const target = layout.panes.find((item) => item.pane_id === pane);
    if (!current || !target)
      throw new Error("agent pane not present in focused tab");
    const dx =
      target.rect.x +
      target.rect.width / 2 -
      (current.rect.x + current.rect.width / 2);
    const dy =
      target.rect.y +
      target.rect.height / 2 -
      (current.rect.y + current.rect.height / 2);
    const direction =
      Math.abs(dx) >= Math.abs(dy)
        ? dx > 0
          ? "right"
          : "left"
        : dy > 0
          ? "down"
          : "up";
    const focused = Bun.spawnSync(
      [
        "herdr",
        "pane",
        "focus",
        "--pane",
        current.pane_id,
        "--direction",
        direction,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (focused.exitCode !== 0)
      throw new Error(
        (focused.stderr.toString() || "agent pane focus failed").trim(),
      );
  }
  throw new Error("could not reach agent pane");
}

export function focusWorkflow(workflow: WorkflowOverview) {
  const returnWorkspace = process.env.HERDR_WORKSPACE_ID;
  if (!returnWorkspace)
    throw new Error("Dashboard is not running inside a Herdr workspace.");
  const state = workflow.state;
  const result = Bun.spawnSync(
    [
      "herdr-workflow",
      "set-return",
      "--repo",
      state.repository,
      "--change",
      state.changeId,
      "--workspace",
      returnWorkspace,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0)
    throw new Error(
      (
        result.stderr.toString() ||
        result.stdout.toString() ||
        "failed to set return workspace"
      ).trim(),
    );
  focusWorkspace(state.workspace);
}

export function discoverChanges(repo: string): string[] {
  const changesDir = join(repo, "openspec", "changes");
  if (!existsSync(changesDir)) return [];
  try {
    return readdirSync(changesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "archive")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function discoverProjects(): Array<{
  name: string;
  path: string;
  openspec: boolean;
}> {
  const result = Bun.spawnSync(["herdr-workflow", "projects"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return [];
  try {
    return JSON.parse(result.stdout.toString());
  } catch {
    return [];
  }
}

export function startWorkflowWizard() {
  const script = `read -r -p 'Repository path: ' repo; read -r -p 'Ticket identifier (optional): ' ticket; read -r -p 'Change ID: ' change; read -r -p 'Task: ' task; read -r -p 'Mode (worktree/checkout): ' mode; read -r -p 'Worker model: ' worker; args=(start --repo "$repo" --change "$change" --task "$task" --mode "\${mode:-worktree}" --worker "$worker"); if [[ -n "$ticket" ]]; then args+=(--ticket "$ticket"); fi; herdr-workflow "\${args[@]}"`;
  return (
    Bun.spawnSync(["bash", "-lc", script], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }).exitCode === 0
  );
}

export async function startWorkflow(input: {
  repo: string;
  ticket: string;
  change: string;
  task?: string;
  mode: string;
  worker: string;
  workflowType?: string;
  sshPassphrase?: string;
}) {
  const repo = input.repo.startsWith("~")
    ? resolve(input.repo.replace("~", homedir()))
    : resolve(input.repo);
  const workflowType =
    input.workflowType === "quick"
      ? "no-openspec"
      : (input.workflowType ?? "standard");
  const args = [
    "herdr-workflow",
    "start",
    "--repo",
    repo,
    "--change",
    input.change,
    "--mode",
    input.mode,
    "--worker",
    input.worker,
    "--workflow-type",
    workflowType,
  ];
  if (input.task) args.push("--task", input.task);
  if (input.ticket) args.push("--ticket", input.ticket);
  const env = {
    ...process.env,
    ...(input.sshPassphrase
      ? { HERDR_SSH_PASSPHRASE: input.sshPassphrase }
      : {}),
  };
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error((stderr || stdout || "start failed").trim());
  return stdout.trim() || "Workflow started";
}

export async function runWorkflow(
  action: string,
  repo: string,
  change: string,
  argument?: string,
) {
  const args = ["herdr-workflow", action, "--repo", repo, "--change", change];
  if (argument) args.push(argument);
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error((stderr || stdout || `${action} failed`).trim());
  return stdout.trim() || `${action} complete`;
}

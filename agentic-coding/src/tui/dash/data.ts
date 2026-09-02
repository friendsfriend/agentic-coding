import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { directionBetween, Herdr, type Rect } from "../../herdr-client.ts";
import type {
	DeveloperDialogueRecord,
	WorkflowView,
} from "../../workflow/contracts.ts";
import {
	canonicalStorePath,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	researchWorkflowTarget,
	wikiWorkflowDataRoot,
	wikiWorkflowTarget,
} from "../../workflow/runtime.ts";
import {
	readConcept,
	renderDocument,
	snapshotList,
	snapshotRead,
} from "../../workflow/wiki.ts";
import {
	answerWorkflowQuestion,
	consumeReturnWorkspace,
	dashboardState,
	discoverProjectsInProcess,
	listPresetNames,
	listWorkflowViews,
	previewWorkflowRepair,
	repairWorkflow,
	runWorkflowAction,
	setReturnInProcess,
	startWorkflowInProcess,
	viewToDashboardState,
} from "./engine";

export { listPresetNames };

const herdr = new Herdr();

export interface WorkflowState {
	changeId: string;
	phase: string;
	stepId?: string;
	stepLabel?: string;
	revision: number;
	definition?: { id: string; version: number; digest: string; label: string };
	status: string;
	health: { valid: boolean; attention: string[]; diagnostic?: string };
	availableActions?: Array<{ id: string; label: string; confirmation: string }>;
	repository: string;
	worktree: string;
	branch: string;
	task?: string;
	workspace: string;
	verificationRound: number;
	baseCommit?: string;
	createdAt?: string;
	phaseStartedAt?: string;
	prCreated?: boolean;
	prUrl?: string | null;
	ticketNumber?: string;
	workerModel?: string;
	returnWorkspace?: string;
	verificationTier?: string;
	verificationRoles?: string[];
	runs: Array<{
		id: string;
		stepId: string;
		role: string;
		attempt: number;
		status: string;
		runtime: string;
		profile: string;
		model?: string;
		paneId?: string;
		outputPath?: string;
		outputDigest?: string;
	}>;
	verificationResults?: Record<string, unknown>;
	verificationReusedResults?: Record<string, unknown>;
	verificationStartedAt?: string;
	testVerifierStarted?: boolean;
	verificationTimeoutRoles?: string[];
	verificationRoleStartedAt?: Record<string, string>;
	verificationModels?: Record<string, string>;
	developerDialogue?: DeveloperDialogueRecord[];
	pendingQuestions?: DeveloperDialogueRecord[];
	planQuality?: {
		passed: boolean;
		issues: string[];
		specFiles: number;
		taskCount: number;
	};
	panes: Record<string, string>;
}

export interface WorktreeGitStatus {
	/** False when Git could not be inspected (missing or non-Git worktree). */
	available: boolean;
	/** Bounded reason shown when unavailable. */
	diagnostic?: string;
	branch?: string;
	changedFiles: number;
	addedFiles: number;
	deletedFiles: number;
	/** Undefined when the branch has no configured upstream. */
	ahead?: number;
	behind?: number;
	noUpstream: boolean;
}

export interface WorkflowOverview {
	state: WorkflowState;
	workspaceOpen: boolean;
	tasks: [number, number];
	// WorkflowOverview agents: role/status/model plus lifetime cost.
	agents: Array<{
		role: string;
		status: string;
		runtime?: string;
		model?: string;
		cost?: number;
	}>;
}

function openWorkspaceIds(): Set<string> | undefined {
	try {
		const workspaces = herdr.call("workspace", "list").workspaces as Array<{
			workspace_id: string;
		}>;
		return new Set(workspaces.map((workspace) => workspace.workspace_id));
	} catch {
		return undefined;
	}
}

export function listWorkflows(...roots: string[]): WorkflowOverview[] {
	const found: WorkflowOverview[] = [];
	const seen = new Set<string>();
	const openWorkspaces = openWorkspaceIds();
	const addRepository = (repo: string) => {
		try {
			if (!existsSync(canonicalStorePath(repo))) return;
		} catch {
			return;
		}
		let views: WorkflowView[];
		try {
			views = listWorkflowViews(repo);
		} catch {
			return;
		}
		for (const view of views) {
			try {
				if (seen.has(view.workflowId)) continue;
				seen.add(view.workflowId);
				const state = viewToDashboardState(view) as WorkflowState;
				const items = tasks(
					join(
						state.worktree,
						"openspec",
						"changes",
						state.changeId,
						"tasks.md",
					),
				);
				const workspaceOpen = Boolean(
					state.workspace &&
						state.health.valid &&
						state.status !== "closed" &&
						(openWorkspaces?.has(state.workspace) ?? true),
				);
				found.push({
					state,
					workspaceOpen,
					tasks: [items.filter((item) => item.done).length, items.length],
					agents: view.runs.map((run) => ({
						role: run.role,
						status: run.status,
						runtime: run.runtime,
						model: run.model,
					})),
				});
			} catch {}
		}
	};
	const walk = (directory: string, depth: number) => {
		if (depth > 4 || !existsSync(directory)) return;
		if (existsSync(join(directory, ".git"))) {
			addRepository(directory);
			return;
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries)
			if (
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				!["node_modules", "target", "dist", "build"].includes(entry.name)
			)
				walk(join(directory, entry.name), depth + 1);
	};
	if (!roots.length) roots = [join(homedir(), "development"), process.cwd()];
	for (const root of roots) walk(root, 0);
	// UI-only wiki reviews live in the centralized target store rather than a
	// Git repository, so include them in the same canonical home list.
	addRepository(wikiWorkflowTarget());
	addRepository(researchWorkflowTarget());
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

function sourceLines(value: string): string[] {
	if (!value) return [];
	return value.replace(/\r?\n$/, "").split(/\r?\n/);
}
function wikiLineCounts(
	before: string,
	after: string,
): { added: number; deleted: number } {
	const oldLines = before ? sourceLines(before) : [];
	const newLines = after ? sourceLines(after) : [];
	let previous = new Array(newLines.length + 1).fill(0) as number[];
	for (const oldLine of oldLines) {
		const current = [0];
		for (let index = 0; index < newLines.length; index++)
			current.push(
				oldLine === newLines[index]
					? (previous[index] ?? 0) + 1
					: Math.max(current[index] ?? 0, previous[index + 1] ?? 0),
			);
		previous = current;
	}
	const common = previous[newLines.length] ?? 0;
	return { added: newLines.length - common, deleted: oldLines.length - common };
}
export function loadWikiSnapshotChanges(
	repo: string,
	change: string,
): LocalChange[] {
	const state = dashboardState(repo, change) as WorkflowState;
	return snapshotList(change, state.worktree).map((id) => {
		const before = snapshotRead(change, id, state.worktree) ?? "";
		let after = "";
		try {
			const current = readConcept(id);
			after = renderDocument(current.frontmatter, current.body);
		} catch {
			/* the concept was deleted; the snapshot remains reviewable */
		}
		const counts = wikiLineCounts(
			before.trim() === "<!-- okf tombstone: concept did not exist -->"
				? ""
				: before,
			after,
		);
		return {
			newPath: id,
			linesAdded: counts.added,
			linesDeleted: counts.deleted,
			newFile:
				!before ||
				before.trim() === "<!-- okf tombstone: concept did not exist -->",
			deletedFile: !after,
			renamedFile: false,
		};
	});
}

export function loadWikiSnapshotDiff(
	repo: string,
	change: string,
	id: string,
): string {
	const state = dashboardState(repo, change) as WorkflowState;
	const snapshot = snapshotRead(change, id, state.worktree) ?? "";
	const before =
		snapshot.trim() === "<!-- okf tombstone: concept did not exist -->"
			? ""
			: snapshot;
	let after = "";
	try {
		const current = readConcept(id);
		after = renderDocument(current.frontmatter, current.body);
	} catch {
		/* deleted concepts have an empty current side */
	}
	const oldLines = sourceLines(before);
	const newLines = sourceLines(after);
	const lcs: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
		new Array(newLines.length + 1).fill(0),
	);
	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		const row = lcs[oldIndex];
		if (!row) continue;
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--)
			row[newIndex] =
				oldLines[oldIndex] === newLines[newIndex]
					? (lcs[oldIndex + 1]?.[newIndex + 1] ?? 0) + 1
					: Math.max(
							lcs[oldIndex + 1]?.[newIndex] ?? 0,
							row[newIndex + 1] ?? 0,
						);
	}

	const body: string[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (oldIndex >= oldLines.length) {
			body.push(`+${newLines[newIndex] ?? ""}`);
			newIndex++;
		} else if (newIndex >= newLines.length) {
			body.push(`-${oldLines[oldIndex] ?? ""}`);
			oldIndex++;
		} else if (oldLines[oldIndex] === newLines[newIndex]) {
			body.push(` ${oldLines[oldIndex] ?? ""}`);
			oldIndex++;
			newIndex++;
		} else if (
			(lcs[oldIndex + 1]?.[newIndex] ?? 0) >=
			(lcs[oldIndex]?.[newIndex + 1] ?? 0)
		) {
			body.push(`-${oldLines[oldIndex] ?? ""}`);
			oldIndex++;
		} else {
			body.push(`+${newLines[newIndex] ?? ""}`);
			newIndex++;
		}
	}

	const oldStart = oldLines.length ? 1 : 0;
	const newStart = newLines.length ? 1 : 0;
	const diff = [
		`--- a/${id}`,
		`+++ b/${id}`,
		...(body.length
			? [
					`@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
					...body,
				]
			: []),
	];
	return diff.join("\n");
}

export interface DeveloperReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
	findingId?: string;
}

export interface PlanReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
}
export type WikiReviewComment = PlanReviewComment;

export interface DeveloperReviewFinding {
	id: string;
	originalId: string;
	severity: "warning" | "info";
	path?: string;
	line?: number;
	detail: string;
	evidence?: string;
	fix?: string;
}

export interface DashboardTask {
	done: boolean;
	text: string;
}

export interface TaskViewport {
	visibleTasks: DashboardTask[];
	start: number;
	activeIndex: number | undefined;
	activePosition: number | undefined;
	activeRow: number | undefined;
}

/** Return the five-row task window centered on the first incomplete task. */
export function getTaskViewport(tasks: DashboardTask[]): TaskViewport {
	const activeIndex = tasks.findIndex((task) => !task.done);
	const start =
		tasks.length <= 5
			? 0
			: activeIndex === -1
				? tasks.length - 5
				: Math.max(0, Math.min(activeIndex - 2, tasks.length - 5));
	const visibleTasks = tasks.slice(start, start + 5);
	const hasActiveTask = activeIndex !== -1;

	return {
		visibleTasks,
		start,
		activeIndex: hasActiveTask ? activeIndex : undefined,
		activePosition: hasActiveTask ? activeIndex + 1 : undefined,
		activeRow: hasActiveTask ? activeIndex - start : undefined,
	};
}

export interface FindingCounts {
	critical: number;
	warning: number;
	info: number;
}

export interface DashboardData {
	state: WorkflowState;
	request: string;
	proposal: string;
	tasks: DashboardTask[];
	review: string;
	reviewHistory: string[];
	agents: Array<{
		role: string;
		status: string;
		runtime?: string;
		model?: string;
		cost?: number;
		metrics?: AgentUsageMetrics;
		findingCounts?: FindingCounts;
	}>;
	updated: string;
	health: { dirty: boolean; ahead: number; behind: number; branch: string };
	gitStatus: WorktreeGitStatus;
	age: string;
	currentTask: string;
	events: Array<{
		at: string;
		event: string;
		role?: string;
		model?: string;
		cost?: number;
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		status?: number;
		tier?: string;
		roles?: string[];
		reports?: string[];
		fallback?: string;
	}>;
	verifierTimeline: Array<{
		role: string;
		status: string;
		rawStatus?: string;
		diagnostic?: string;
		durationSeconds?: number;
		model?: string;
		providerErrors: number;
		fallback: boolean;
	}>;
	costBreakdown: Array<Omit<CostRow, "messages"> & { messages: CostMessage[] }>;
}

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
			done: match[1]?.toLowerCase() === "x",
			text: match[2]?.trim(),
		}),
	);
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
		stderr: "pipe",
	});
}

const unavailableGitStatus = (diagnostic: string): WorktreeGitStatus => ({
	available: false,
	diagnostic: diagnostic.replace(/\s+/g, " ").slice(0, 96),
	branch: undefined,
	changedFiles: 0,
	addedFiles: 0,
	deletedFiles: 0,
	ahead: undefined,
	behind: undefined,
	noUpstream: true,
});

/** Workflow metadata never counts toward overview Git status. */
const isWorkflowMetadataPath = (path: string) =>
	path === ".herdr-workflow" || path.startsWith(".herdr-workflow/");

/**
 * Inspect a workflow worktree's Git state: branch, distinct changed/added/
 * deleted file counts (porcelain status, paths deduplicated), and upstream
 * ahead/behind counts. Best-effort: a missing or non-Git worktree yields an
 * unavailable result with a bounded diagnostic instead of throwing.
 */
export function worktreeGitStatus(worktree: string): WorktreeGitStatus {
	if (!existsSync(worktree)) return unavailableGitStatus("worktree not found");
	// One synchronous invocation per worktree carries everything: -b adds the
	// branch header (branch...upstream [ahead N, behind M]), -uall expands
	// untracked directories into files, core.quotePath=false keeps paths raw.
	const status = gitResult(
		worktree,
		"-c",
		"core.quotePath=false",
		"status",
		"--porcelain=v1",
		"-b",
		"-uall",
	);
	if (status.exitCode !== 0)
		return unavailableGitStatus(
			status.stderr.toString().trim() || "git status failed",
		);
	const lines = status.stdout.toString().split(/\r?\n/).filter(Boolean);
	const result: WorktreeGitStatus = {
		available: true,
		branch: undefined,
		changedFiles: 0,
		addedFiles: 0,
		deletedFiles: 0,
		ahead: undefined,
		behind: undefined,
		noUpstream: true,
	};
	// Path-keyed so a path staged and modified again counts once; per path the
	// classification precedence is deleted > added > changed (modified/renamed).
	const rank = { changed: 0, added: 1, deleted: 2 } as const;
	const kinds = new Map<string, keyof typeof rank>();
	for (const line of lines) {
		if (line.startsWith("## ")) {
			applyBranchHeader(line.slice(3), result);
			continue;
		}
		const code = line.slice(0, 2);
		let path = line.slice(3);
		const arrow = path.indexOf(" -> ");
		if (arrow >= 0) path = path.slice(arrow + 4); // renames count the destination
		if (!path || isWorkflowMetadataPath(path)) continue;
		const kind = code.includes("D")
			? "deleted"
			: code.includes("A") || code.trim() === "??"
				? "added"
				: "changed";
		const previous = kinds.get(path);
		if (!previous || rank[kind] > rank[previous]) kinds.set(path, kind);
	}
	for (const kind of kinds.values()) result[`${kind}Files` as const]++;
	return result;
}

/** Parse the porcelain -b branch header into branch/upstream/ahead/behind. */
function applyBranchHeader(head: string, result: WorktreeGitStatus) {
	if (head.startsWith("No commits yet on ")) {
		result.branch = head.slice("No commits yet on ".length);
		return;
	}
	if (head.startsWith("HEAD (no branch)")) return; // detached: no branch/upstream
	const dots = head.indexOf("...");
	if (dots === -1) {
		result.branch = head;
		return;
	}
	result.branch = head.slice(0, dots);
	const info = head.slice(dots + 3);
	const bracket = info.indexOf(" [");
	const upstream = bracket >= 0 ? info.slice(0, bracket) : info;
	const suffix = bracket >= 0 ? info.slice(bracket + 2).replace(/\]$/, "") : "";
	result.noUpstream = !upstream.trim() || suffix === "gone";
	// A configured-but-gone upstream has no meaningful counts; per the contract
	// ahead/behind stay undefined whenever there is no usable upstream.
	if (result.noUpstream) return;
	// The header only lists non-zero counts; zero values are implicit.
	const aheadMatch = /\bahead (\d+)/.exec(suffix);
	result.ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
	const behindMatch = /\bbehind (\d+)/.exec(suffix);
	result.behind = behindMatch ? Number(behindMatch[1]) : 0;
}
function telemetryEvents(path: string): Array<Record<string, unknown>> {
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

export interface CostRow {
	role: string;
	messages: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

export interface CostMessage {
	at: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cost: number;
}

/** Usage-event names: current bridges emit `runtime.usage`, legacy files
 * `model_usage`. Both feed cost and per-agent metric aggregation. */
export const USAGE_EVENT_NAMES = new Set(["runtime.usage", "model_usage"]);

function isUsageEvent(event: Record<string, unknown>): boolean {
	return USAGE_EVENT_NAMES.has(String(event.event));
}

/** Compact per-agent metrics shown in the Agents panel. Fields the telemetry
 * never recorded stay undefined so the panel can omit them instead of showing
 * zero placeholders that could be mistaken for measured values. */
export interface AgentUsageMetrics {
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	durationSeconds?: number;
	tokensPerSecond?: number;
}

interface MetricAccumulator extends AgentUsageMetrics {
	generationMs?: number;
	firstAt?: number;
	lastAt?: number;
	hasUsage?: boolean;
	cacheInputsComplete?: boolean;
}

/** Aggregate per-role agent metrics from a workflow's telemetry events:
 * summed cost/tokens/cache-read from usage events, wall-clock duration from
 * the role's first to last timestamped event (lifecycle or usage), and output
 * tokens per second preferring summed per-message generation time over the
 * wall-clock span. Roles without any metric are omitted from the result. */
export function agentMetrics(
	events: Array<Record<string, unknown>>,
): Map<string, AgentUsageMetrics> {
	const byRole = new Map<string, MetricAccumulator>();
	for (const event of events) {
		const role = event.role;
		if (typeof role !== "string") continue;
		const row = byRole.get(role) ?? {};
		byRole.set(role, row);
		const at = Date.parse(String(event.at ?? ""));
		if (Number.isFinite(at)) {
			row.firstAt = row.firstAt === undefined ? at : Math.min(row.firstAt, at);
			row.lastAt = row.lastAt === undefined ? at : Math.max(row.lastAt, at);
		}
		if (!isUsageEvent(event)) continue;
		const cacheInputsComplete = [
			"inputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		].every((field) => {
			const value = event[field];
			return typeof value === "number" && Number.isFinite(value) && value >= 0;
		});
		row.cacheInputsComplete =
			(row.cacheInputsComplete ?? true) && cacheInputsComplete;
		for (const field of [
			"cost",
			"inputTokens",
			"outputTokens",
			"cacheReadTokens",
			"cacheWriteTokens",
		] as const) {
			const value = event[field];
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
				continue;
			row[field] = (row[field] ?? 0) + value;
			row.hasUsage = true;
		}
		const durationMs = event.durationMs;
		if (
			typeof durationMs === "number" &&
			Number.isFinite(durationMs) &&
			durationMs > 0
		)
			row.generationMs = (row.generationMs ?? 0) + durationMs;
	}
	const result = new Map<string, AgentUsageMetrics>();
	for (const [role, row] of byRole) {
		const durationSeconds =
			row.firstAt !== undefined &&
			row.lastAt !== undefined &&
			row.lastAt > row.firstAt
				? Math.max(0, Math.round((row.lastAt - row.firstAt) / 1000))
				: undefined;
		const outputTokens = row.outputTokens ?? 0;
		const generationSeconds = (row.generationMs ?? 0) / 1000;
		const tokensPerSecond =
			outputTokens > 0 && generationSeconds > 0
				? Math.round((outputTokens / generationSeconds) * 10) / 10
				: undefined;
		if (!row.hasUsage && durationSeconds === undefined) continue;
		result.set(role, {
			...(row.cost !== undefined ? { cost: row.cost } : {}),
			...(row.inputTokens !== undefined
				? { inputTokens: row.inputTokens }
				: {}),
			...(row.outputTokens !== undefined
				? { outputTokens: row.outputTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheReadTokens !== undefined
				? { cacheReadTokens: row.cacheReadTokens }
				: {}),
			...(row.cacheInputsComplete && row.cacheWriteTokens !== undefined
				? { cacheWriteTokens: row.cacheWriteTokens }
				: {}),
			...(durationSeconds !== undefined ? { durationSeconds } : {}),
			...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
		});
	}
	return result;
}

/** Per-role lifetime cost from model_usage rows (one per assistant message).
 * Accepts both `runtime.usage` and legacy `model_usage` event names. */
export function costSummary(events: Array<Record<string, unknown>>): CostRow[] {
	const byRole = new Map<string, CostRow>();
	for (const event of events) {
		const role = event.role;
		if (!isUsageEvent(event) || typeof role !== "string") continue;
		const row = byRole.get(role) ?? {
			role,
			messages: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cost: 0,
		};
		row.messages += 1;
		row.inputTokens += Number(event.inputTokens ?? 0);
		row.outputTokens += Number(event.outputTokens ?? 0);
		row.totalTokens += Number(event.totalTokens ?? 0);
		row.cost += Number(event.cost ?? 0);
		byRole.set(role, row);
	}
	return [...byRole.values()].sort((a, b) => b.cost - a.cost);
}

/** Per-message cost rows for one role, oldest first. */
export function costMessages(
	events: Array<Record<string, unknown>>,
	role: string,
): CostMessage[] {
	return events
		.filter((event) => isUsageEvent(event) && event.role === role)
		.sort((a, b) => String(a.at).localeCompare(String(b.at)))
		.map((event) => ({
			at: String(event.at ?? ""),
			inputTokens: Number(event.inputTokens ?? 0),
			outputTokens: Number(event.outputTokens ?? 0),
			totalTokens: Number(event.totalTokens ?? 0),
			cost: Number(event.cost ?? 0),
		}));
}

/** Hours spent in the current phase (phase start, falling back to creation). */
export function phaseAgeHours(
	state: { phase: string; phaseStartedAt?: string; createdAt?: string },
	now: number,
): number {
	const at = state.phaseStartedAt ?? state.createdAt;
	if (!at) return 0;
	const age = (now - Date.parse(at)) / 3_600_000;
	return Math.max(0, Math.floor(age));
}

/** True when a workflow has sat in a non-terminal phase longer than the threshold. */
export function isStale(
	state: {
		phase: string;
		status?: string;
		phaseStartedAt?: string;
		createdAt?: string;
	},
	now: number,
	thresholdHours = 6,
): boolean {
	if (state.status === "completed" || state.status === "closed") return false;
	const at = state.phaseStartedAt ?? state.createdAt;
	if (!at) return false;
	return (now - Date.parse(at)) / 3_600_000 > thresholdHours;
}

function agentStatuses() {
	try {
		const agents = herdr.call("agent", "list").agents as Array<{
			pane_id: string;
			agent_status: string;
		}>;
		return new Map(agents.map((agent) => [agent.pane_id, agent.agent_status]));
	} catch {
		return new Map<string, string>();
	}
}

interface VerifierFinding {
	id: string;
	severity: "critical" | "warning" | "info";
	detail: string;
	path?: string;
	line?: number;
	status?: string;
	evidence?: string;
	changedCode?: string;
	fix?: string;
}
function verifierFinding(value: unknown): VerifierFinding | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== "string" ||
		!["critical", "warning", "info"].includes(String(item.severity)) ||
		typeof item.detail !== "string"
	)
		return undefined;
	return {
		id: item.id,
		severity: item.severity as VerifierFinding["severity"],
		detail: item.detail,
		...(typeof item.path === "string" ? { path: item.path } : {}),
		...(typeof item.line === "number" ? { line: item.line } : {}),
		...(typeof item.status === "string" ? { status: item.status } : {}),
		...(typeof item.evidence === "string" ? { evidence: item.evidence } : {}),
		...(typeof item.changedCode === "string"
			? { changedCode: item.changedCode }
			: {}),
		...(typeof item.fix === "string" ? { fix: item.fix } : {}),
	};
}
function committedVerifierRun(
	run: WorkflowState["runs"][number],
):
	| { run: WorkflowState["runs"][number]; findings: VerifierFinding[] }
	| undefined {
	if (
		run.status !== "completed" ||
		!run.outputPath ||
		!run.outputDigest ||
		!existsSync(run.outputPath)
	)
		return undefined;
	try {
		const bytes = readFileSync(run.outputPath);
		if (createHash("sha256").update(bytes).digest("hex") !== run.outputDigest)
			return undefined;
		const envelope = JSON.parse(bytes.toString("utf8")) as {
			runId?: unknown;
			schemaId?: unknown;
			schemaVersion?: unknown;
			payload?: { findings?: unknown };
		};
		if (
			envelope.runId !== run.id ||
			envelope.schemaId !== "core.findings" ||
			envelope.schemaVersion !== 1 ||
			!Array.isArray(envelope.payload?.findings)
		)
			return undefined;
		const findings = envelope.payload.findings.map(verifierFinding);
		if (findings.some((item) => !item)) return undefined;
		return { run, findings: findings as VerifierFinding[] };
	} catch {
		return undefined;
	}
}
function committedVerifierOutput(state: WorkflowState, role: string) {
	const run = state.runs
		.filter(
			(item) =>
				item.stepId === "core.verification" &&
				item.attempt === state.verificationRound &&
				item.role === role,
		)
		.at(-1);
	return run ? committedVerifierRun(run) : undefined;
}

/** Count each validated finding once while preserving explicit zero severities. */
export function countVerifierFindings(
	findings: Array<Pick<VerifierFinding, "severity">>,
): FindingCounts {
	const counts: FindingCounts = { critical: 0, warning: 0, info: 0 };
	for (const finding of findings) counts[finding.severity]++;
	return counts;
}

/** Current-round committed finding counts for one verifier, when available. */
export function verifierFindingCounts(
	state: WorkflowState,
	role: string,
): FindingCounts | undefined {
	const output = committedVerifierOutput(state, role);
	return output ? countVerifierFindings(output.findings) : undefined;
}
function verificationHistory(state: WorkflowState): string[] {
	const attempts = [
		...new Set(
			state.runs
				.filter((run) => run.stepId === "core.verification")
				.map((run) => run.attempt),
		),
	].sort((a, b) => a - b);
	return attempts.map((attempt) => {
		const runs = state.runs.filter(
			(run) => run.stepId === "core.verification" && run.attempt === attempt,
		);
		const reports = runs
			.filter((run) => run.status === "completed")
			.map(committedVerifierRun);
		const verdict = runs.some((run) =>
			["pending", "working"].includes(run.status),
		)
			? "PENDING"
			: reports.some((report) =>
						report?.findings.some((finding) => finding.severity === "critical"),
					)
				? "FAIL"
				: reports.some((report) => report === undefined)
					? "EVIDENCE ERROR"
					: runs.some((run) => run.status === "failed")
						? "FAILED"
						: runs.some((run) => run.status === "blocked")
							? "BLOCKED"
							: runs.some((run) => run.status === "expired")
								? "EXPIRED"
								: reports.length &&
										runs.every((run) => run.status === "completed")
									? "PASS"
									: "PENDING";
		return `round-${attempt}: ${verdict}`;
	});
}

export const dashboardTestHelpers = {
	committedVerifierOutput,
	verificationHistory,
};

export function loadVerifierFindings(
	repo: string,
	change: string,
	role: string,
) {
	const state = dashboardState(repo, change) as WorkflowState;
	const output = committedVerifierOutput(state, role);
	if (!output) return undefined;
	const events = output.findings.map((finding) => ({
		...finding,
		type: "finding",
	}));
	return {
		title: `${role} · round ${output.run.attempt}`,
		events: events as Array<{
			type: string;
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
	const state = dashboardState(repo, change) as WorkflowState;
	const findings = state.runs
		.filter(
			(run) =>
				run.stepId === "core.verification" &&
				run.attempt === state.verificationRound,
		)
		.flatMap((run) =>
			(committedVerifierRun(run)?.findings ?? []).map((finding) => ({
				...finding,
				runId: run.id,
			})),
		);
	return findings
		.filter(
			(item) =>
				(item.severity === "warning" || item.severity === "info") &&
				(item.status === undefined ||
					item.status === "new" ||
					item.status === "unfixed") &&
				typeof item.id === "string" &&
				typeof item.detail === "string",
		)
		.map((item) => ({
			id: `${item.runId}:${item.id}`,
			originalId: item.id,
			severity: item.severity as "warning" | "info",
			path: typeof item.path === "string" ? item.path : undefined,
			line: typeof item.line === "number" ? item.line : undefined,
			detail: item.detail,
			evidence: typeof item.evidence === "string" ? item.evidence : undefined,
			fix: typeof item.fix === "string" ? item.fix : undefined,
		}));
}

export function loadVerifierReport(repo: string, change: string, role: string) {
	const state = dashboardState(repo, change) as WorkflowState;
	const output = committedVerifierOutput(state, role);
	if (!output) throw new Error(`No committed report yet for ${role}.`);
	const derivedVerdict = output.findings.some(
		(entry) => entry.severity === "critical",
	)
		? "FAIL"
		: "PASS";
	const content =
		[
			`# Verdict (derived)\n${derivedVerdict}`,
			...output.findings.map((entry) =>
				[
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
					.join("\n"),
			),
		].join("\n\n") || "# No findings";
	return { title: `${role} · round ${output.run.attempt}`, content };
}

export function loadLocalChanges(repo: string, change: string): LocalChange[] {
	const state = dashboardState(repo, change) as WorkflowState;
	const base = state.baseCommit ?? "HEAD";
	const changes = new Map<string, LocalChange>();
	const numstat =
		git(
			state.worktree,
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
			state.worktree,
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
			changes.delete(parts[1]);
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
	for (const line of (git(state.worktree, "status", "--short") ?? "")
		.split(/\r?\n/)
		.filter(Boolean)) {
		if (!line.startsWith("?? ")) continue;
		const path = line.slice(3);
		if (path === ".herdr-workflow" || path.startsWith(".herdr-workflow/"))
			continue;
		if (changes.has(path)) continue;
		const result = gitResult(
			state.worktree,
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
	const state = dashboardState(repo, change) as WorkflowState;
	const base = state.baseCommit ?? "HEAD";
	const paths =
		file.oldPath && file.oldPath !== file.newPath
			? [file.oldPath, file.newPath]
			: [file.newPath];
	const result = gitResult(
		state.worktree,
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
		state.worktree,
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
	const state = dashboardState(repo, change) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		change,
		"reviews",
		"developer-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export async function savePlanReview(
	repo: string,
	change: string,
	comments: PlanReviewComment[],
) {
	const state = dashboardState(repo, change) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		change,
		"reviews",
		"plan-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export async function saveWikiReview(
	repo: string,
	change: string,
	comments: WikiReviewComment[],
) {
	const state = dashboardState(repo, change) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		change,
		"reviews",
		"wiki-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export function loadWikiReviewComments(
	repo: string,
	change: string,
): WikiReviewComment[] {
	const state = dashboardState(repo, change) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		change,
		"reviews",
		"wiki-review.json",
	);
	try {
		const parsed = JSON.parse(read(path)) as { comments?: unknown };
		if (!Array.isArray(parsed.comments)) return [];
		return parsed.comments.flatMap((value) => {
			if (!value || typeof value !== "object") return [];
			const item = value as Record<string, unknown>;
			const line = Number(item.line);
			return typeof item.filePath === "string" &&
				typeof item.body === "string" &&
				Number.isInteger(line) &&
				line > 0
				? [
						{
							filePath: item.filePath,
							line,
							...(typeof item.startLine === "number"
								? { startLine: item.startLine }
								: {}),
							...(typeof item.endLine === "number"
								? { endLine: item.endLine }
								: {}),
							body: item.body,
						},
					]
				: [];
		});
	} catch {
		return [];
	}
}

export function loadPlanReviewComments(
	repo: string,
	change: string,
): PlanReviewComment[] {
	const state = dashboardState(repo, change) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		change,
		"reviews",
		"plan-review.json",
	);
	try {
		const parsed = JSON.parse(read(path)) as { comments?: unknown };
		if (!Array.isArray(parsed.comments)) return [];
		return (parsed.comments as unknown[]).flatMap((value) => {
			if (!value || typeof value !== "object") return [];
			const item = value as Record<string, unknown>;
			if (typeof item.filePath !== "string" || typeof item.body !== "string")
				return [];
			const line = Number(item.line);
			if (!Number.isInteger(line) || line < 1) return [];
			return [
				{
					filePath: item.filePath,
					line,
					...(typeof item.startLine === "number"
						? { startLine: item.startLine }
						: {}),
					...(typeof item.endLine === "number"
						? { endLine: item.endLine }
						: {}),
					body: item.body,
				},
			];
		});
	} catch {
		return [];
	}
}

export function loadDashboard(repo: string, change: string): DashboardData {
	const state = dashboardState(repo, change) as WorkflowState;
	const workflowRoot =
		isResearchWorkflowTarget(repo) || state.definition?.id === "research"
			? join(wikiWorkflowDataRoot(), change)
			: join(state.worktree, ".herdr-workflow", change);
	const changeRoot = join(state.worktree, "openspec", "changes", change);
	const statuses = agentStatuses();

	const telemetry = telemetryEvents(join(workflowRoot, "telemetry.jsonl"));
	const verifierRuns = state.runs.filter(
		(run) =>
			run.stepId === "core.verification" &&
			run.attempt === state.verificationRound,
	);
	const verifierTimeline = verifierRuns.map((run) => {
		const role = run.role;
		const committed =
			run.status === "completed"
				? committedVerifierOutput(state, role)
				: undefined;
		const verdict =
			run.status === "completed"
				? !committed
					? "EVIDENCE ERROR"
					: committed.findings.some(
								(finding) => finding.severity === "critical",
							)
						? "FAIL"
						: "PASS"
				: ["pending", "working"].includes(run.status)
					? "RUN"
					: ["failed", "blocked"].includes(run.status)
						? "FAIL"
						: "SKIPPED";
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
						((ended ? Date.parse(String(ended)) : Date.now()) -
							Date.parse(String(started))) /
							1000,
					),
				)
			: undefined;
		return {
			role,
			status: verdict,
			rawStatus: run.status,
			...(!committed && run.status === "completed"
				? {
						diagnostic:
							"Committed verifier artifact missing, unreadable, malformed, or digest-mismatched",
					}
				: {}),
			durationSeconds,
			model: state.verificationModels?.[role],
			providerErrors: responseErrors,
			fallback: roleEvents.some(
				(event) => event.event === "provider_launch_fallback",
			),
		};
	});
	const costByRole = new Map(
		costSummary(telemetry).map((row) => [row.role, row]),
	);
	const metricsByRole = agentMetrics(telemetry);
	const costBreakdown = costSummary(telemetry).map((row) => ({
		...row,
		messages: costMessages(telemetry, row.role),
	}));
	const reviewHistory = verificationHistory(state);
	const gitStatus = worktreeGitStatus(state.worktree);
	return {
		state,
		request: state.task?.trim()
			? state.task
			: summary(join(workflowRoot, "request.md")),
		proposal: summary(join(changeRoot, "proposal.md")),
		tasks: tasks(join(changeRoot, "tasks.md")),
		review: reviewHistory.at(-1) ?? "Not run",
		reviewHistory,
		agents: Object.entries(state.panes)
			.filter(([role]) => !["git", "dashboard"].includes(role))
			.map(([role, pane]) => {
				const run = [...state.runs]
					.reverse()
					.find((item) => item.role === role);
				return {
					role,
					status:
						statuses.get(pane) ??
						(role === "planner" && state.stepId !== "core.plan"
							? "closed"
							: "not started"),
					runtime: run?.runtime,
					model: run?.model,
					cost: costByRole.get(role)?.cost,
					metrics: metricsByRole.get(role),
					findingCounts: role.endsWith("verifier")
						? verifierFindingCounts(state, role)
						: undefined,
				};
			}),
		updated: new Date().toLocaleTimeString(),
		health: {
			dirty:
				gitStatus.available &&
				gitStatus.changedFiles + gitStatus.addedFiles + gitStatus.deletedFiles >
					0,
			ahead: gitStatus.ahead ?? 0,
			behind: gitStatus.behind ?? 0,
			branch: gitStatus.branch ?? "",
		},
		gitStatus,
		age: state.createdAt
			? `${Math.max(0, Math.floor((Date.now() - Date.parse(state.createdAt)) / 3600000))}h`
			: "unknown",
		currentTask:
			state.stepId === "core.implementation"
				? (tasks(join(changeRoot, "tasks.md")).find((task) => !task.done)
						?.text ?? "Worker completing tasks")
				: (state.stepLabel ?? state.phase),
		events: telemetry.slice(-20).map((event) => ({
			at: new Date(String(event.at)).toLocaleTimeString(),
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
		costBreakdown,
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
	// Demo telemetry mirrors what the pi bridge emits: runtime lifecycle plus
	// per-message usage rows carrying cache/duration/tok-s fields. Metrics are
	// derived through the real aggregation so fixtures cannot drift from it.
	const demoTelemetry: Array<Record<string, unknown>> = [
		{ event: "runtime.started", role: "planner", at: "2026-01-01T10:35:00Z" },
		{
			event: "runtime.usage",
			role: "planner",
			at: "2026-01-01T10:41:55Z",
			inputTokens: 2100,
			outputTokens: 400,
			cacheReadTokens: 1680,
			cacheWriteTokens: 0,
			cost: 0.08,
			durationMs: 52000,
		},
		{ event: "runtime.settled", role: "planner", at: "2026-01-01T10:41:58Z" },
		{ event: "runtime.started", role: "worker", at: "2026-01-01T10:42:00Z" },
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:44:12Z",
			inputTokens: 5200,
			outputTokens: 1400,
			cacheReadTokens: 4200,
			cacheWriteTokens: 100,
			cost: 0.21,
			durationMs: 61000,
		},
		{
			event: "runtime.usage",
			role: "worker",
			at: "2026-01-01T10:48:03Z",
			inputTokens: 4800,
			outputTokens: 1100,
			cacheReadTokens: 3900,
			cacheWriteTokens: 200,
			cost: 0.21,
			durationMs: 55000,
		},
		{
			event: "runtime.started",
			role: "security-verifier",
			at: "2026-01-01T10:49:30Z",
		},
		{
			event: "runtime.usage",
			role: "security-verifier",
			at: "2026-01-01T10:50:20Z",
			inputTokens: 3200,
			outputTokens: 600,
			cacheReadTokens: 2600,
			cacheWriteTokens: 0,
			cost: 0.05,
			durationMs: 30000,
		},
		// Partial coverage: lifecycle events only, so duration renders without
		// inventing token or cost values.
		{
			event: "runtime.started",
			role: "agents-verifier",
			at: "2026-01-01T10:50:40Z",
		},
		{
			event: "runtime.settled",
			role: "agents-verifier",
			at: "2026-01-01T10:51:30Z",
		},
		{
			event: "runtime.started",
			role: "quality-verifier",
			at: "2026-01-01T10:50:00Z",
		},
		{
			event: "runtime.usage",
			role: "quality-verifier",
			at: "2026-01-01T10:51:07Z",
			inputTokens: 4100,
			outputTokens: 900,
			cacheReadTokens: 12300,
			cacheWriteTokens: 0,
			cost: 0.07,
			durationMs: 45000,
		},
	];
	const demoMetrics = agentMetrics(demoTelemetry);
	const demoFindingCounts: Record<string, FindingCounts | undefined> = {
		"security-verifier": { critical: 2, warning: 1, info: 0 },
		"quality-verifier": { critical: 0, warning: 3, info: 2 },
	};
	return {
		state: {
			changeId: "demo-optional-realisation-date",
			phase,
			revision: 0,
			status:
				phase === "closed"
					? "closed"
					: phase === "completed"
						? "completed"
						: "active",
			health: { valid: true, attention: [] },
			developerDialogue: [],
			pendingQuestions: [],
			runs: [],
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
				"usability-verifier": "demo:p8",
				"performance-verifier": "demo:p9",
				"openspec-verifier": "demo:p10",
				git: "demo:p11",
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
			{
				role: "planner",
				status: applying ? "closed" : "idle",
				runtime: "pi",
				model: "provider/planner",
				cost: 0.08,
				metrics: demoMetrics.get("planner"),
			},
			{
				role: "worker",
				status:
					phase === "apply" ? "working" : applying ? "idle" : "not started",
				runtime: "opencode",
				model: "provider/worker",
				cost: 0.42,
				metrics: demoMetrics.get("worker"),
			},
			...[
				"security-verifier",
				"agents-verifier",
				"quality-verifier",
				"usability-verifier",
				"performance-verifier",
				"openspec-verifier",
			].map((role) => ({
				role,
				runtime: role === "security-verifier" ? "opencode-v2" : undefined,
				model: role === "security-verifier" ? "provider/security" : undefined,
				status:
					phase === "verify" ? "working" : verified ? "done" : "not started",
				metrics: demoMetrics.get(role),
				findingCounts: demoFindingCounts[role],
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
		gitStatus: {
			available: true,
			branch: "feature/demo-optional-realisation-date",
			changedFiles: 0,
			addedFiles: 0,
			deletedFiles: 0,
			ahead: 0,
			behind: 0,
			noUpstream: false,
		},
		age: "2h",
		currentTask: applying
			? "Apply next implementation task"
			: "Planner exploring change",
		events: [
			...demoTelemetry.map((event) => ({
				at: String(event.at).slice(11, 19),
				event: String(event.event),
				role: event.role as string | undefined,
				cost: Number(event.cost ?? 0) || undefined,
				inputTokens: event.inputTokens as number | undefined,
				outputTokens: event.outputTokens as number | undefined,
			})),
			{
				at: "10:42:00",
				event: "verification_started",
				tier: "openspec-full",
				roles: ["security-verifier", "quality-verifier"],
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
		costBreakdown: [
			{
				role: "worker",
				inputTokens: 10000,
				outputTokens: 2500,
				totalTokens: 12500,
				cost: 0.42,
				messages: [
					{
						at: "10:44:12",
						inputTokens: 5200,
						outputTokens: 1400,
						totalTokens: 6600,
						cost: 0.21,
					},
					{
						at: "10:48:03",
						inputTokens: 4800,
						outputTokens: 1100,
						totalTokens: 5900,
						cost: 0.21,
					},
				],
			},
			{
				role: "planner",
				inputTokens: 2100,
				outputTokens: 400,
				totalTokens: 2500,
				cost: 0.08,
				messages: [
					{
						at: "10:41:55",
						inputTokens: 2100,
						outputTokens: 400,
						totalTokens: 2500,
						cost: 0.08,
					},
				],
			},
			{
				role: "quality-verifier",
				inputTokens: 4100,
				outputTokens: 900,
				totalTokens: 5000,
				cost: 0.07,
				messages: [
					{
						at: "10:51:07",
						inputTokens: 4100,
						outputTokens: 900,
						totalTokens: 5000,
						cost: 0.07,
					},
				],
			},
			{
				role: "security-verifier",
				inputTokens: 3200,
				outputTokens: 600,
				totalTokens: 3800,
				cost: 0.05,
				messages: [
					{
						at: "10:50:20",
						inputTokens: 3200,
						outputTokens: 600,
						totalTokens: 3800,
						cost: 0.05,
					},
				],
			},
		],
	};
}

export type RequiredUserActionItem =
	| { label: string; kind: "artifact"; value: string }
	| { label: string; kind: "workflow"; value: string }
	| { label: string; kind: "review"; value: string }
	| { label: string; kind: "dismiss" };

export interface RequiredUserAction {
	key: string;
	title: string;
	prompt: string;
	items: RequiredUserActionItem[];
}

/** Dashboard-owned copy for `core.completed` action ids. An id the engine
 * reports with no entry here still renders, using the engine's own label
 * (design D1) — a missing translation degrades to a usable button rather
 * than disappearing. */
const COMPLETED_ACTION_LABELS: Record<string, string> = {
	"create-pr": "Create MR/PR",
	close: "Close Herdr workspace",
};

export function requiredUserActionFor(
	phase: string,
	prCreated = false,
	_artifacts: string[] = [],
	definitionId?: string,
	/** The engine view's available actions for the current step. `undefined`
	 * means no view carries this information at all (this dashboard's demo
	 * fixture, or a pre-engine store) and the legacy phase-derived set below
	 * applies. A present-but-empty array is authoritative and renders no
	 * action. */
	actions?: Array<{ id: string; label: string; confirmation: string }>,
): RequiredUserAction | undefined {
	const later = { label: "Not now", kind: "dismiss" } as const;
	if (actions !== undefined && actions.length === 0) return undefined;
	const hasAction = (id: string) =>
		actions === undefined || actions.some((action) => action.id === id);

	if (phase === "proposed" || phase === "core.plan-approval") {
		if (!hasAction("approve-plan")) return undefined;
		const proposal =
			definitionId === "openspec-propose" ||
			definitionId === "openspec-fusion-propose";
		return {
			key: "plan-review",
			title: "Action required · Plan review",
			prompt: proposal
				? "Review the OpenSpec artifacts before completing the proposal."
				: "Review the OpenSpec artifacts before the worker starts.",
			// Trigger-only: the action opens the plan review popup (artifact list)
			// directly, so there are no selectable items to render in the generic
			// ListViewModal.
			items: [],
		};
	}
	if (phase === "wiki-approval" || phase === "core.wiki-approval") {
		if (!hasAction("approve-wiki")) return undefined;
		return {
			key: "wiki-review",
			title: "Action required · Wiki review",
			prompt:
				definitionId === "wiki"
					? "Review knowledge changes before completion."
					: definitionId === "research"
						? "Review knowledge changes before closing research."
						: "Review knowledge changes before archival.",
			// Trigger-only: the action opens the wiki review popup (drafted-concept
			// list + markdown view + comment/approve/request-changes) directly, so
			// there are no selectable items to render in the generic ListViewModal.
			items: [],
		};
	}
	if (phase === "developer-review" || phase === "core.developer-review") {
		if (!hasAction("approve-review")) return undefined;
		return {
			// Stable key independent of legacy vs engine (`core.*`) phase naming,
			// so App.tsx's direct-open matching fires for both.
			key: "developer-review",
			title: "Action required · Developer review",
			prompt: "Review changed files before workflow continues.",
			// Trigger-only: the action opens the changed-files popup directly, so
			// there are no selectable items to render in the generic ListViewModal.
			items: [],
		};
	}
	if (phase === "research" || phase === "core.research") {
		if (!hasAction("close-research")) return undefined;
		return {
			key: "research",
			title: "Research active",
			prompt:
				"Ask follow-ups in the researcher session, or close research when finished. The researcher itself starts wiki drafting when the user explicitly requests it.",
			items: [
				{
					label: "Close research",
					kind: "workflow",
					value: "close-research",
				},
				later,
			],
		};
	}
	if (phase === "completed" || phase === "core.completed") {
		if (actions !== undefined) {
			// Availability comes entirely from the engine's action list: whatever
			// it reports (create-pr present or absent, per its close-only manifest
			// policy and whether a pull request already exists) is exactly what
			// renders, with no separate dashboard allowlist.
			const hasCreatePr = actions.some((action) => action.id === "create-pr");
			return {
				key: `${phase}:${hasCreatePr ? "pr-available" : "closed"}`,
				title: "Action required · Workflow complete",
				prompt: hasCreatePr
					? "Create MR/PR or close workspace."
					: "Close workspace when finished.",
				items: [
					...actions.map((action) => ({
						label: COMPLETED_ACTION_LABELS[action.id] ?? action.label,
						kind: "workflow" as const,
						value: action.id,
					})),
					later,
				],
			};
		}
		// Legacy fallback: no `actions` array at all, so there is no engine data
		// to consult. Derives close-only the pre-engine way.
		const proposal =
			definitionId === "openspec-propose" ||
			definitionId === "openspec-fusion-propose";
		const wikiOnly = definitionId === "wiki" || definitionId === "research";
		const closeOnly = proposal || wikiOnly;
		return {
			key: `${phase}:${closeOnly ? "proposal" : prCreated ? "pr-created" : "no-pr"}`,
			title: "Action required · Workflow complete",
			prompt: closeOnly
				? "Close workflow when finished."
				: prCreated
					? "Close workspace when finished."
					: "Create MR/PR or close workspace.",
			items: [
				...(!closeOnly && !prCreated
					? [
							{
								label: "Create MR/PR",
								kind: "workflow" as const,
								value: "create-pr",
							},
						]
					: []),
				{
					label: "Close Herdr workspace",
					kind: "workflow",
					value: "close",
				},
				later,
			],
		};
	}
	return undefined;
}

export function approvalFor(phase: string) {
	return (
		{
			proposed: {
				prompt: "Press Enter to approve plan",
				action: "approve-plan",
			},
			fix: { prompt: "Press Enter to retry verification", action: "verify" },
			"developer-review": {
				prompt: "Press Enter to review changed files",
				action: "review",
			},
			archive: {
				prompt: "Press Enter to advance archive",
				action: "archive",
			},
			committing: {
				prompt: "Press Enter to complete committing",
				action: "archive",
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

export function focusReturnWorkspace(
	repo: string,
	change: string,
	workspace: string,
) {
	focusWorkspace(workspace);
	consumeReturnWorkspace(repo, change, workspace);
}
export function focusWorkspace(workspace: string) {
	herdr.call("workspace", "focus", workspace);
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
	const pane = herdr.call(
		"tab",
		"create",
		"--workspace",
		state.workspace,
		"--label",
		`finding:${finding.path.split("/").at(-1)}`,
		"--focus",
	).root_pane.pane_id as string;
	const editor = process.env.EDITOR || "vi";
	const command = `${editor} +${finding.line ?? 1} ${JSON.stringify(file)}`;
	herdr.call("pane", "run", pane, command);
}

export function focusAgent(state: WorkflowState, pane: string) {
	focusWorkspace(state.workspace);
	const tabId = herdr.call("pane", "get", pane).pane.tab_id as string;
	herdr.call("tab", "focus", tabId);
	for (let attempt = 0; attempt < 8; attempt++) {
		const layout = herdr.call("pane", "layout", "--pane", pane).layout as {
			focused_pane_id: string;
			panes: Array<{ pane_id: string; rect: Rect }>;
		};
		if (layout.focused_pane_id === pane) return;
		const current = layout.panes.find(
			(item) => item.pane_id === layout.focused_pane_id,
		);
		const target = layout.panes.find((item) => item.pane_id === pane);
		if (!current || !target)
			throw new Error("agent pane not present in focused tab");
		const direction = directionBetween(current.rect, target.rect);
		herdr.call(
			"pane",
			"focus",
			"--pane",
			current.pane_id,
			"--direction",
			direction,
		);
	}
	throw new Error("could not reach agent pane");
}

export function focusWorkflow(workflow: WorkflowOverview) {
	const state = workflow.state;
	if (
		isWikiWorkflowTarget(state.repository) ||
		!state.repository ||
		state.definition?.id === "research"
	) {
		focusWorkspace(state.workspace);
		return;
	}
	const returnWorkspace = process.env.HERDR_WORKSPACE_ID;
	if (!returnWorkspace)
		throw new Error("Dashboard is not running inside a Herdr workspace.");
	setReturnInProcess(state.repository, state.changeId, returnWorkspace);
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
	try {
		return discoverProjectsInProcess();
	} catch {
		return [];
	}
}

export function startWorkflowWizard() {
	const script = `read -r -p 'Repository path: ' repo; read -r -p 'Ticket identifier (optional): ' ticket; read -r -p 'Change ID: ' change; read -r -p 'Task: ' task; read -r -p 'Mode (worktree/checkout): ' mode; args=(start --repo "$repo" --change "$change" --task "$task" --mode "\${mode:-worktree}"); if [[ -n "$ticket" ]]; then args+=(--ticket "$ticket"); fi; herdr-workflow "\${args[@]}"`;
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
	workflowType?: string;
	preset?: string;
}) {
	const repo =
		input.workflowType === "research" && !input.repo
			? ""
			: input.repo.startsWith("~")
				? resolve(input.repo.replace("~", homedir()))
				: resolve(input.repo);
	return startWorkflowInProcess({ ...input, repo });
}

export function previewRepair(repo: string, change: string) {
	return previewWorkflowRepair(repo, change);
}
export function applyRepair(
	repo: string,
	change: string,
	revision: number,
	targetStep: string,
	reason = "",
) {
	return repairWorkflow(repo, change, revision, targetStep, reason);
}

export function answerQuestion(
	repo: string,
	change: string,
	revision: number,
	questionId: string,
	answer:
		| { kind: "option" | "custom" | "cancel"; value?: string }
		| {
				groupId: string;
				responses: Array<{
					questionId: string;
					kind: "option" | "custom";
					value: string;
				}>;
		  }
		| { groupId: string; kind: "cancel" },
) {
	return answerWorkflowQuestion(repo, change, revision, questionId, answer);
}

export async function runWorkflow(
	action: string,
	repo: string,
	change: string,
	revision: number,
	argument?: string,
) {
	return runWorkflowAction(action, repo, change, revision, argument);
}

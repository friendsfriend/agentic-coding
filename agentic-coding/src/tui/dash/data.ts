import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { directionBetween, Herdr, type Rect } from "../../herdr-client.ts";
import type { WorkflowView } from "../../workflow/contracts.ts";
import { canonicalStorePath } from "../../workflow/runtime.ts";
import {
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
	planQuality?: {
		passed: boolean;
		issues: string[];
		specFiles: number;
		taskCount: number;
	};
	panes: Record<string, string>;
}

export interface WorkflowOverview {
	state: WorkflowState;
	workspaceOpen: boolean;
	tasks: [number, number];
	agents: Array<{
		role: string;
		status: string;
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

export interface PlanReviewComment {
	filePath: string;
	line: number;
	startLine?: number;
	endLine?: number;
	body: string;
}

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
		model?: string;
		cost?: number;
	}>;
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
		stderr: "ignore",
	});
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

/** Per-role lifetime cost from model_usage rows (one per assistant message). */
export function costSummary(events: Array<Record<string, unknown>>): CostRow[] {
	const byRole = new Map<string, CostRow>();
	for (const event of events) {
		const role = event.role;
		if (event.event !== "model_usage" || typeof role !== "string") continue;
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
		.filter((event) => event.event === "model_usage" && event.role === role)
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
	const bytes = readFileSync(run.outputPath);
	if (createHash("sha256").update(bytes).digest("hex") !== run.outputDigest)
		return undefined;
	try {
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
	const workflowRoot = join(state.worktree, ".herdr-workflow", change);
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
	const costBreakdown = costSummary(telemetry).map((row) => ({
		...row,
		messages: costMessages(telemetry, row.role),
	}));
	return {
		state,
		request: summary(join(workflowRoot, "request.md")),
		proposal: summary(join(changeRoot, "proposal.md")),
		tasks: tasks(join(changeRoot, "tasks.md")),
		review: verificationHistory(state).at(-1) ?? "Not run",
		reviewHistory: verificationHistory(state),
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
					model: run?.model ?? run?.profile ?? run?.runtime,
					cost: costByRole.get(role)?.cost,
				};
			}),
		updated: new Date().toLocaleTimeString(),
		health: {
			dirty: !!(git(state.worktree, "status", "--porcelain") ?? ""),
			ahead:
				Number(
					git(state.worktree, "rev-list", "--count", "@{upstream}..HEAD") ?? "",
				) || 0,
			behind:
				Number(
					git(state.worktree, "rev-list", "--count", "HEAD..@{upstream}") ?? "",
				) || 0,
			branch: git(state.worktree, "branch", "--show-current") ?? "",
		},
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
			{ role: "planner", status: applying ? "closed" : "idle", cost: 0.08 },
			{
				role: "worker",
				status:
					phase === "apply" ? "working" : applying ? "idle" : "not started",
				cost: 0.42,
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
			{
				at: "10:41",
				event: "model_usage",
				role: "planner",
				inputTokens: 2100,
				outputTokens: 400,
				totalTokens: 2500,
				cost: 0.08,
			},
			{
				at: "10:44",
				event: "model_usage",
				role: "worker",
				inputTokens: 5200,
				outputTokens: 1400,
				totalTokens: 6600,
				cost: 0.21,
			},
			{
				at: "10:48",
				event: "model_usage",
				role: "worker",
				inputTokens: 4800,
				outputTokens: 1100,
				totalTokens: 5900,
				cost: 0.21,
			},
			{
				at: "10:50",
				event: "model_usage",
				role: "security-verifier",
				inputTokens: 3200,
				outputTokens: 600,
				totalTokens: 3800,
				cost: 0.05,
			},
			{
				at: "10:51",
				event: "model_usage",
				role: "quality-verifier",
				inputTokens: 4100,
				outputTokens: 900,
				totalTokens: 5000,
				cost: 0.07,
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
	| { label: string; kind: "dismiss" };

export interface RequiredUserAction {
	key: string;
	title: string;
	prompt: string;
	items: RequiredUserActionItem[];
}

export function requiredUserActionFor(
	phase: string,
	prCreated = false,
	_artifacts: string[] = [],
	definitionId?: string,
): RequiredUserAction | undefined {
	const later = { label: "Not now", kind: "dismiss" } as const;
	if (phase === "proposed" || phase === "core.plan-approval") {
		const proposal =
			definitionId === "standard-propose" || definitionId === "fusion-propose";
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
	if (phase === "developer-review" || phase === "core.developer-review")
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
	if (phase === "completed" || phase === "core.completed") {
		const proposal =
			definitionId === "standard-propose" || definitionId === "fusion-propose";
		return {
			key: `${phase}:${proposal ? "proposal" : prCreated ? "pr-created" : "no-pr"}`,
			title: "Action required · Workflow complete",
			prompt: proposal
				? "Close workflow when finished."
				: prCreated
					? "Close workspace when finished."
					: "Create MR/PR or close workspace.",
			items: [
				...(!proposal && !prCreated
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
				...(!proposal
					? [
							{
								label: "Close and delete worktree",
								kind: "workflow" as const,
								value: "close-clean",
							},
						]
					: []),
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
	const returnWorkspace = process.env.HERDR_WORKSPACE_ID;
	if (!returnWorkspace)
		throw new Error("Dashboard is not running inside a Herdr workspace.");
	const state = workflow.state;
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
	const repo = input.repo.startsWith("~")
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

export async function runWorkflow(
	action: string,
	repo: string,
	change: string,
	revision: number,
	argument?: string,
) {
	return runWorkflowAction(action, repo, change, revision, argument);
}

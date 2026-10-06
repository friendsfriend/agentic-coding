/** Dashboard observation and execution I/O: filesystem, Git, telemetry,
 * and in-process workflow engine reads/writes. Every function here performs
 * external reads or launches work — deterministic display projections live in
 * `projections.ts`, and the review feature in `review.ts`. */
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
	LocalChange,
	WorktreeGitStatus,
} from "../../contracts/integration";
import type {
	DashboardData,
	DeveloperReviewComment,
	DeveloperReviewFinding,
	FindingCounts,
	PlanReviewComment,
	VerifierFinding,
	WikiReviewComment,
	WorkflowOverview,
	WorkflowState,
} from "../../contracts/workflow";
import type { WorkflowView } from "../../contracts/workflow.ts";
import { effectiveManifestPolicy } from "../../workflow/definitions.ts";
import {
	fetchProjectCatalog,
	loadProjectCatalog,
	type ProjectOption,
	projectCanonicalRoots,
	projectIdentForPath,
} from "../../workflow/project-catalog.ts";
import {
	agentMetrics,
	costMessages,
	costSummary,
	countVerifierFindings,
} from "../../workflow/run-projections";
import { latestRunsByRole } from "../../workflow/run-projections.ts";
import {
	canonicalStorePath,
	isResearchWorkflowTarget,
	isWikiWorkflowTarget,
	researchWorkflowTarget,
	wikiWorkflowDataRoot,
	wikiWorkflowTarget,
	workflowTargets,
} from "../../workflow/runtime.ts";
import {
	readConcept,
	renderDocument,
	snapshotList,
	snapshotRead,
} from "../../workflow/wiki.ts";
import {
	answerWorkflowQuestion,
	dashboardState,
	discoverProjectsInProcess,
	listWorkflowViews,
	previewWorkflowRepair,
	repairWorkflow,
	requestWorkflowExecution,
	runWorkflowAction,
	startWorkflowInProcess,
	viewToDashboardState,
	workflowExecutionError,
} from "./engine.ts";

export type DashboardObservation =
	| { kind: "dashboard"; repo: string; workflowId: string }
	| { kind: "workflows" }
	| { kind: "projects" }
	| { kind: "artifacts"; state: WorkflowState }
	| { kind: "artifact-content"; state: WorkflowState; artifact: string }
	| { kind: "wiki-changes"; repo: string; workflowId: string }
	| { kind: "wiki-diff"; repo: string; workflowId: string; file: LocalChange }
	| { kind: "local-changes"; repo: string; workflowId: string }
	| {
			kind: "local-diff";
			repo: string;
			workflowId: string;
			file: LocalChange;
	  }
	| {
			kind: "verifier-findings";
			repo: string;
			workflowId: string;
			role: string;
	  }
	| {
			kind: "verifier-report";
			repo: string;
			workflowId: string;
			role: string;
	  }
	| { kind: "developer-review-findings"; repo: string; workflowId: string }
	| { kind: "repair-preview"; repo: string; workflowId: string }
	| { kind: "changes"; repo: string }
	| { kind: "branches"; repo: string };

/** Run an observation in-process. This is the server-side dispatch the HTTP
 * transport exposes (expose-unified-bun-backend, task 2.2): the TUI reaches it
 * through the typed client, and a headless caller may run it directly with no
 * transport. It only reads/renders — never initializes, migrates or mutates. */
export async function runLocalObservation(
	observation: DashboardObservation,
	signal?: AbortSignal,
): Promise<unknown> {
	if (signal?.aborted)
		throw new DOMException("observation cancelled", "AbortError");
	switch (observation.kind) {
		case "workflows":
			return listWorkflowsFromCatalog();
		case "projects":
			return discoverProjects();
		case "dashboard":
			return loadDashboard(observation.repo, observation.workflowId);
		case "artifacts":
			return openSpecArtifacts(observation.state);
		case "artifact-content":
			return openSpecArtifact(observation.state, observation.artifact);
		case "wiki-changes":
			return loadWikiSnapshotChanges(observation.repo, observation.workflowId);
		case "wiki-diff":
			return loadWikiSnapshotDiff(
				observation.repo,
				observation.workflowId,
				observation.file.newPath,
			);
		case "local-changes":
			return loadLocalChanges(observation.repo, observation.workflowId);
		case "local-diff":
			return loadLocalDiff(
				observation.repo,
				observation.workflowId,
				observation.file,
			);
		case "verifier-findings":
			return loadVerifierFindings(
				observation.repo,
				observation.workflowId,
				observation.role,
			);
		case "verifier-report":
			return loadVerifierReport(
				observation.repo,
				observation.workflowId,
				observation.role,
			);
		case "developer-review-findings":
			return loadDeveloperReviewFindings(
				observation.repo,
				observation.workflowId,
			);
		case "repair-preview":
			return previewWorkflowRepair(observation.repo, observation.workflowId);
		case "changes":
			return discoverChanges(observation.repo);
		case "branches":
			return discoverBranches(observation.repo);
	}
}

/** Run one observation in-process. This module is the server-owned
 * implementation; the TUI adapter decides whether to reach the server over the
 * transport or call this directly (establish-opencode-boundaries, task 2.4). */
async function observeAsync<T>(
	observation: DashboardObservation,
	signal?: AbortSignal,
): Promise<T> {
	return (await runLocalObservation(observation, signal)) as T;
}

export function listWorkflows(...roots: string[]): WorkflowOverview[] {
	return buildWorkflows(roots);
}

/** The target that owns a workflow's rows. For a repository-backed store that
 * is the root that read the row — including a legacy wiki/research row that
 * predates the shared store, whose rows still live in a repository. Only the
 * shared wiki/research store needs disambiguation: it is one file serving two
 * targets, so the reading root cannot name the target the workflow was started
 * with, while the manifest's declared target kind can. */
function workflowTargetFor(repo: string, definitionId: string): string {
	if (!isWikiWorkflowTarget(repo) && !isResearchWorkflowTarget(repo))
		return repo;
	try {
		switch (effectiveManifestPolicy({ id: definitionId }).targetKind) {
			case "wiki":
				return wikiWorkflowTarget();
			case "research":
				return researchWorkflowTarget();
			default:
				return repo;
		}
	} catch {
		// A removed or unavailable definition has no policy, and a row without a
		// definition is still a row: the root that read it is the only key left.
		return repo;
	}
}

function buildWorkflows(roots: string[]): WorkflowOverview[] {
	const found: WorkflowOverview[] = [];
	const seen = new Set<string>();
	const addRepository = (repo: string) => {
		let store: string;
		try {
			store = canonicalStorePath(repo);
			if (!existsSync(store)) return;
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
				const target = workflowTargetFor(repo, view.definition.id);
				// Identity is the store file, not the target: the wiki and research
				// targets are one file, so both passes read the same rows and the
				// second must not list them again under its own key.
				const identity = `${store}\0${view.workflowId}`;
				if (seen.has(identity)) continue;
				seen.add(identity);
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
				found.push({
					state,
					target,
					// Read-side default mirrors the view: a snapshot without the
					// attribution is operator-started work.
					startedBy: view.startedBy ?? "developer",
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
	// Explicit catalog roots only: the recursive development-root/cwd fallback
	// is removed so an unconfigured repository can never appear automatically.
	for (const root of roots) addRepository(root);
	// UI-only wiki reviews live in the centralized target store rather than a
	// Git repository, so include them in the same canonical home list.
	addRepository(wikiWorkflowTarget());
	addRepository(researchWorkflowTarget());
	return found.sort((a, b) =>
		a.state.workflowId.localeCompare(b.state.workflowId),
	);
}

export function listWorkflowsAsync(
	signal?: AbortSignal,
): Promise<WorkflowOverview[]> {
	return observeAsync<WorkflowOverview[]>({ kind: "workflows" }, signal);
}

/** Load workflow history from the canonical project catalog. Repository reads
 * are de-duplicated by canonical root, so linked worktrees share history
 * instead of duplicating it, and each overview is linked back to its stable
 * configured project ident (the environment <-> workflow cross-link). */
/** Every root the sidebar reads: the configured project catalog plus the
 * targets a workflow was started in. A workflow started in a directory of the
 * operator's choosing owns its store there, and only the registry remembers the
 * directory, so leaving it out would hide that workflow from the panel. */
export function workflowRoots(catalogRoots: readonly string[]): string[] {
	return [...new Set([...catalogRoots, ...workflowTargets()])].sort();
}

export async function listWorkflowsFromCatalog(
	serverUrl?: string,
): Promise<WorkflowOverview[]> {
	const catalog = await loadProjectCatalog({ baseUrl: serverUrl });
	const overviews = buildWorkflows(
		workflowRoots(projectCanonicalRoots(catalog)),
	);
	return overviews.map((overview) => ({
		...overview,
		projectIdent: projectIdentForPath(catalog, overview.state.repository),
	}));
}

export function discoverProjectsAsync(
	signal?: AbortSignal,
): Promise<ProjectOption[]> {
	return observeAsync({ kind: "projects" }, signal);
}

export function openSpecArtifactsAsync(
	state: WorkflowState,
	signal?: AbortSignal,
): Promise<string[]> {
	return observeAsync({ kind: "artifacts", state }, signal);
}

export function openSpecArtifactAsync(
	state: WorkflowState,
	artifact: string,
	signal?: AbortSignal,
): Promise<string> {
	return observeAsync({ kind: "artifact-content", state, artifact }, signal);
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
	workflowId: string,
): LocalChange[] {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	return snapshotList(state.changeId || state.workflowId, state.worktree).map(
		(id) => {
			const before =
				snapshotRead(state.changeId || state.workflowId, id, state.worktree) ??
				"";
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
		},
	);
}

export function loadWikiSnapshotDiff(
	repo: string,
	workflowId: string,
	id: string,
): string {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const snapshot =
		snapshotRead(state.changeId || state.workflowId, id, state.worktree) ?? "";
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
	if (oldLines.length > 4000 || newLines.length > 4000)
		throw new Error("wiki diff exceeds bounded observation size");
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
/** The untracked-path walk is the expensive half of `git status`: a full tree
 * scan (~100 ms here) against ~10 ms for the tracked half, and it is the half a
 * viewer tolerates lagging. Only that half is cached; branch, ahead/behind and
 * tracked/staged/deleted state stay authoritative on every read. */
const UNTRACKED_PATHS_TTL_MS = 3_000;
const untrackedPathsCache = new Map<string, { at: number; paths: string[] }>();

function untrackedPaths(worktree: string): string[] {
	const cached = untrackedPathsCache.get(worktree);
	const now = Date.now();
	if (cached && now - cached.at < UNTRACKED_PATHS_TTL_MS) return cached.paths;
	const listed = gitResult(
		worktree,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	);
	if (listed.exitCode !== 0) return cached?.paths ?? [];
	const paths = listed.stdout.toString().split("\0").filter(Boolean);
	// Keep the map bounded to the worktrees read inside one window: a long-lived
	// dash touches a new worktree per workflow.
	for (const [key, value] of untrackedPathsCache)
		if (now - value.at >= UNTRACKED_PATHS_TTL_MS)
			untrackedPathsCache.delete(key);
	untrackedPathsCache.set(worktree, { at: now, paths });
	return paths;
}

export function worktreeGitStatus(worktree: string): WorktreeGitStatus {
	if (!existsSync(worktree)) return unavailableGitStatus("worktree not found");
	// One synchronous invocation for the tracked half: -b adds the branch header
	// (branch...upstream [ahead N, behind M]), -uno skips the untracked tree walk,
	// core.quotePath=false keeps paths raw. Untracked files come from a separately
	// cached listing so their count still matches `-uall`'s per-file expansion.
	const status = gitResult(
		worktree,
		"-c",
		"core.quotePath=false",
		"status",
		"--porcelain=v1",
		"-b",
		"-uno",
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
	// Untracked paths are added to the same map so the rank rule still counts a
	// path once and never shadows a staged record for the same path.
	for (const path of untrackedPaths(worktree)) {
		if (isWorkflowMetadataPath(path)) continue;
		if (!kinds.has(path)) kinds.set(path, "added");
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
const MAX_TELEMETRY_BYTES = 4 * 1024 * 1024;
function telemetryText(path: string): string {
	try {
		const size = statSync(path).size;
		if (size <= MAX_TELEMETRY_BYTES) return readFileSync(path, "utf8");
		const fd = openSync(path, "r");
		try {
			const buffer = Buffer.alloc(MAX_TELEMETRY_BYTES);
			readSync(fd, buffer, 0, buffer.length, size - buffer.length);
			const firstLine = buffer.indexOf(10);
			return buffer.toString("utf8", firstLine + 1);
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}
function telemetryEvents(path: string): Array<Record<string, unknown>> {
	return telemetryText(path)
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
		...(typeof item.recommendation === "string"
			? { recommendation: item.recommendation }
			: {}),
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
/** Latest `core.verification` run per verifier role, across every round.
 *
 * The Agents panel renders one row per role, so a role's verifier evidence —
 * finding counts and verdict — must be read from the run that row represents:
 * the role's newest verification run, whichever round it belongs to. Rounds
 * select a subset of the catalog, so a verifier that a later round did not
 * re-select has no run in that round at all; reading only the newest round
 * dropped such a role's committed result and left a `completed` row with
 * neither findings nor a verdict. */
function latestVerifierRuns(state: WorkflowState) {
	return latestRunsByRole(
		state.runs.filter((run) => run.stepId === "core.verification"),
	);
}
function committedVerifierOutput(state: WorkflowState, role: string) {
	const run = latestVerifierRuns(state).get(role);
	return run ? committedVerifierRun(run) : undefined;
}

/** Committed finding counts for one verifier's latest run, when available. */
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
	workflowId: string,
	role: string,
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const output = committedVerifierOutput(state, role);
	if (!output) return undefined;
	const events = output.findings.map((finding) => ({
		...finding,
		verifier: role,
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
			recommendation?: string;
			fix?: string;
			verifier?: string;
		}>,
	};
}

export function loadDeveloperReviewFindings(
	repo: string,
	workflowId: string,
): DeveloperReviewFinding[] {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const findings = state.runs
		.filter(
			(run) =>
				run.stepId === "core.verification" &&
				run.attempt === state.verificationRound,
		)
		.flatMap((run) =>
			(committedVerifierRun(run)?.findings ?? []).map((finding) => ({
				...finding,
				verifier: run.role,
				runId: run.id,
			})),
		);
	// The verify-only family reviews a round the verifiers already failed: its
	// findings review is where the critical findings get selected for the worker,
	// so that step sees them. The developer review of a passing change keeps its
	// advisory-only list, because a critical finding there would already have
	// looped back to the implementation step.
	const includeCritical = state.stepId === "core.findings-review";
	return findings
		.filter(
			(item) =>
				(includeCritical
					? item.severity === "critical" ||
						item.severity === "warning" ||
						item.severity === "info"
					: item.severity === "warning" || item.severity === "info") &&
				(item.status === undefined ||
					item.status === "new" ||
					item.status === "unfixed") &&
				typeof item.id === "string" &&
				typeof item.detail === "string",
		)
		.map((item) => ({
			id: `${item.runId}:${item.id}`,
			originalId: item.id,
			severity: item.severity as "critical" | "warning" | "info",
			path: typeof item.path === "string" ? item.path : undefined,
			line: typeof item.line === "number" ? item.line : undefined,
			detail: item.detail,
			recommendation:
				typeof item.recommendation === "string"
					? item.recommendation
					: undefined,
			evidence: typeof item.evidence === "string" ? item.evidence : undefined,
			fix: typeof item.fix === "string" ? item.fix : undefined,
			verifier: item.verifier,
		}));
}

export function loadVerifierReport(
	repo: string,
	workflowId: string,
	role: string,
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
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
					entry.recommendation
						? `## Recommended fix\n${entry.recommendation}`
						: entry.fix
							? `Resolution: ${entry.fix}`
							: "",
				]
					.filter(Boolean)
					.join("\n"),
			),
		].join("\n\n") || "# No findings";
	return { title: `${role} · round ${output.run.attempt}`, content };
}

export function loadLocalChanges(
	repo: string,
	workflowId: string,
): LocalChange[] {
	const state = dashboardState(repo, workflowId) as WorkflowState;
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
	// Untracked files come from the shared cached listing that the dashboard's
	// Git status uses: `git status -uall` pays the same ~100 ms tree walk for the
	// same paths, and paid it again on every review refresh. Either way a file
	// created inside a brand-new directory is its own reviewable row instead of a
	// single "?? dir/" entry whose diff errors.
	for (const path of untrackedPaths(state.worktree)) {
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

export function loadWikiSnapshotChangesAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<LocalChange[]> {
	return observeAsync({ kind: "wiki-changes", repo, workflowId }, signal);
}

export function loadWikiSnapshotDiffAsync(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: AbortSignal,
): Promise<string> {
	return observeAsync({ kind: "wiki-diff", repo, workflowId, file }, signal);
}

export function loadLocalChangesAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<LocalChange[]> {
	return observeAsync({ kind: "local-changes", repo, workflowId }, signal);
}

export function loadLocalDiffAsync(
	repo: string,
	workflowId: string,
	file: LocalChange,
	signal?: AbortSignal,
): Promise<string> {
	return observeAsync({ kind: "local-diff", repo, workflowId, file }, signal);
}

/** Ask the server-owned execution coordinator to drain pending effects,
 * through the typed API when a client is configured. */
export async function requestWorkflowExecutionAsync(
	repo: string,
	workflowId?: string,
): Promise<void> {
	requestWorkflowExecution(repo, workflowId);
}

/** Verifier findings/report read through the typed backend API. The server runs
 * the same `dashboardState` projection; the dashboard no longer reads the
 * worktree directly for the verdict modal. */
export function loadVerifierFindingsAsync(
	repo: string,
	workflowId: string,
	role: string,
	signal?: AbortSignal,
): Promise<ReturnType<typeof loadVerifierFindings>> {
	return observeAsync(
		{ kind: "verifier-findings", repo, workflowId, role },
		signal,
	);
}

export function loadVerifierReportAsync(
	repo: string,
	workflowId: string,
	role: string,
	signal?: AbortSignal,
): Promise<ReturnType<typeof loadVerifierReport>> {
	return observeAsync(
		{ kind: "verifier-report", repo, workflowId, role },
		signal,
	);
}

export function loadDeveloperReviewFindingsAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<ReturnType<typeof loadDeveloperReviewFindings>> {
	return observeAsync(
		{ kind: "developer-review-findings", repo, workflowId },
		signal,
	);
}

/** Repair targets read through the typed backend API. */
export function previewRepairAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<ReturnType<typeof previewWorkflowRepair>> {
	return observeAsync({ kind: "repair-preview", repo, workflowId }, signal);
}

/** OpenSpec change ids read through the typed backend API. */
export function discoverChangesAsync(
	repo: string,
	signal?: AbortSignal,
): Promise<string[]> {
	return observeAsync({ kind: "changes", repo }, signal);
}

/** The branches a repository can be rebased from and onto. The current branch
 * and the local refs are what the source picker offers (a rebase attaches an
 * existing local branch), while the target picker may also name a remote ref. */
export interface BranchOptions {
	/** The checked-out branch, empty for a detached HEAD. */
	current: string;
	local: string[];
	remote: string[];
	/** The ref the target picker preselects: `origin/HEAD`'s target, else the
	 * first of main/master among the remote and local refs, else the current
	 * branch. Empty only for a repository with no branches at all. */
	default: string;
}

/** Local and remote branches of a checkout, read for the rebase launch's two
 * pickers. Every list is sorted and deduplicated, and a repository that is not
 * a Git checkout fails with a readable message instead of an empty list. */
export function discoverBranches(repo: string): BranchOptions {
	const head = gitResult(repo, "rev-parse", "--is-inside-work-tree");
	if (head.exitCode !== 0) throw new Error(`not a Git repository: ${repo}`);
	const current = gitResult(repo, "branch", "--show-current")
		.stdout.toString()
		.trim();
	const local = gitResult(
		repo,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads/",
	)
		.stdout.toString()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const remote = gitResult(
		repo,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/remotes/",
	)
		.stdout.toString()
		.split("\n")
		.map((line) => line.trim())
		// `<remote>/HEAD` is a symbolic ref, not a branch, and a bare `<remote>`
		// entry is the same ref written without its suffix.
		.filter(
			(line) => line !== "" && !line.endsWith("/HEAD") && line.includes("/"),
		);
	const originHead = gitResult(
		repo,
		"symbolic-ref",
		"-q",
		"--short",
		"refs/remotes/origin/HEAD",
	)
		.stdout.toString()
		.trim();
	const remoteName = originHead.split("/")[0] || "origin";
	// The preselected target must be a literal entry of the list the picker
	// offers (local + remote), so the default is resolved to one of those names
	// and never to a ref the list would not contain.
	const defaultTarget =
		(remote.includes(originHead) ? originHead : undefined) ??
		remote.find((name) => name === `${remoteName}/main`) ??
		remote.find((name) => name === `${remoteName}/master`) ??
		remote.find((name) => name.endsWith("/main")) ??
		remote.find((name) => name.endsWith("/master")) ??
		local.find((name) => name === "main" || name === "master") ??
		(local.includes(current) ? current : undefined) ??
		local[0] ??
		remote[0] ??
		"";
	return {
		current,
		local: [...new Set(local)].sort(),
		remote: [...new Set(remote)].sort(),
		default: defaultTarget,
	};
}

function safeWorktreeRelative(worktree: string, value: string): string {
	if (!value || isAbsolute(value) || value.split(/[\\/]/).includes(".."))
		throw new Error("observation path must be worktree-relative");
	const root = resolve(worktree);
	const resolved = resolve(root, value);
	if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
		throw new Error("observation path escapes worktree");
	return value;
}

export function loadLocalDiff(
	repo: string,
	workflowId: string,
	file: LocalChange,
): string {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	safeWorktreeRelative(state.worktree, file.newPath);
	if (file.oldPath) safeWorktreeRelative(state.worktree, file.oldPath);
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
		"--",
		file.newPath,
	).stdout.toString();
}

export async function saveDeveloperReview(
	repo: string,
	workflowId: string,
	comments: DeveloperReviewComment[],
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		workflowId,
		"reviews",
		"developer-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export async function savePlanReview(
	repo: string,
	workflowId: string,
	comments: PlanReviewComment[],
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		workflowId,
		"reviews",
		"plan-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export async function saveWikiReview(
	repo: string,
	workflowId: string,
	comments: WikiReviewComment[],
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		workflowId,
		"reviews",
		"wiki-review.json",
	);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify({ comments }, null, 2)}\n`);
}

export function loadWikiReviewComments(
	repo: string,
	workflowId: string,
): WikiReviewComment[] {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		workflowId,
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
	workflowId: string,
): PlanReviewComment[] {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const path = join(
		state.worktree,
		".herdr-workflow",
		workflowId,
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

export async function loadDashboardAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<DashboardData> {
	const dashboard = await observeAsync<DashboardData>(
		{ kind: "dashboard", repo, workflowId },
		signal,
	);
	// Cross-link the detail to the configured catalog: annotate the stable
	// project ident, and surface a catalog mismatch for a repository-backed
	// workflow whose project was removed from configuration. Access is never
	// affected and the pinned checkout is never retargeted.
	let annotated = dashboard;
	try {
		const catalog = await fetchProjectCatalog({ signal });
		const projectIdent = projectIdentForPath(
			catalog,
			dashboard.state.repository,
		);
		const repositoryBacked =
			!isWikiWorkflowTarget(repo) &&
			!isResearchWorkflowTarget(repo) &&
			dashboard.state.definition?.id !== "research";
		annotated = {
			...dashboard,
			...(projectIdent ? { projectIdent } : {}),
			...(repositoryBacked && !projectIdent
				? {
						catalogMismatch: `Repository ${dashboard.state.repository} is not in the configured project catalog`,
					}
				: {}),
		};
	} catch {
		// Catalog unavailable: never claim a mismatch from a failed read.
	}
	const error = workflowExecutionError(repo, workflowId);
	if (!error) return annotated;
	return {
		...annotated,
		state: {
			...annotated.state,
			health: {
				...annotated.state.health,
				valid: false,
				attention: [...annotated.state.health.attention, error],
				diagnostic: error,
			},
		},
	};
}

export function loadDashboard(repo: string, workflowId: string): DashboardData {
	const state = dashboardState(repo, workflowId) as WorkflowState;
	const workflowRoot =
		isResearchWorkflowTarget(repo) || state.definition?.id === "research"
			? join(wikiWorkflowDataRoot(), workflowId)
			: join(state.worktree, ".herdr-workflow", workflowId);
	const changeRoot = join(
		state.worktree,
		"openspec",
		"changes",
		state.changeId,
	);
	const latestRuns = latestRunsByRole(state.runs);

	const telemetry = telemetryEvents(join(workflowRoot, "telemetry.jsonl"));
	// One timeline entry per verifier role, from the same run the Agents row
	// represents (see `latestVerifierRuns`): the row's verdict and its finding
	// counts always describe one and the same verification run.
	const verifierTimeline = [...latestVerifierRuns(state).values()].map(
		(run) => {
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
		},
	);
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
		review: reviewHistory.at(-1) ?? "Not run",
		reviewHistory,
		// Agent status has one source: the persisted run status that also drives
		// the workflow run's own status projection.
		// The row set comes from `latestRuns`, not `state.panes`: a run exists (and is
		// reported) as soon as the engine creates it, while its pane handle is only
		// persisted once the launch effect completes. Gating on panes hid runs whose
		// handle was not yet stored — notably the auto-spawned `test-verifier`, which
		// is created during the last verifier's handoff and launched afterwards. The
		// seed projection (`tui/data/workflow.ts`) already lists runs this way, so
		// both reads now agree. `state.panes[role]` stays the optional focus target
		// (App.tsx just no-ops when a run has no live pane yet).
		agents: [...latestRuns.values()]
			.filter((run) => !["git", "dashboard"].includes(run.role))
			.map((run) => ({
				role: run.role,
				status: run.status,
				runtime: run.runtime,
				model: run.model,
				cost: costByRole.get(run.role)?.cost,
				metrics: metricsByRole.get(run.role),
				findingCounts: run.role.endsWith("verifier")
					? verifierFindingCounts(state, run.role)
					: undefined,
				// A durable agent hosts its own process: the Agents panel opens its
				// session view by run id + host socket instead of focusing a pane, so
				// the same identity the seed projection carries must survive this
				// read too (add-pi-durable-runtime, dashboard-agent-session-view).
				runId: run.id,
				...(run.hostSocket ? { hostSocket: run.hostSocket } : {}),
				...(run.conversationId ? { conversationId: run.conversationId } : {}),
			})),
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

/** Root of the workflow's OpenSpec change directory, or `undefined` when the
 * workflow owns no change. Workflows started without OpenSpec phases
 * (`no-openspec`, `wiki`, `research`) never record a change id, so they must
 * not fall back to `openspec/changes` — that would list every other change's
 * archived artifacts in a panel the workflow gains nothing from. */
function openSpecRoot(state: WorkflowState): string | undefined {
	if (!state.changeId) return undefined;
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
	const root = openSpecRoot(state);
	if (root === undefined) return [];
	try {
		return Array.from(new Bun.Glob("**/*.md").scanSync({ cwd: root })).sort();
	} catch {
		return [];
	}
}
export function openSpecArtifact(state: WorkflowState, artifact: string) {
	const change = openSpecRoot(state);
	if (change === undefined) throw new Error("workflow has no OpenSpec change");
	const root = resolve(change);
	if (
		!artifact ||
		isAbsolute(artifact) ||
		artifact.split(/[\\/]/).includes("..")
	)
		throw new Error("artifact path must be relative");
	const file = resolve(root, artifact);
	if (file !== root && !file.startsWith(`${root}${sep}`))
		throw new Error("artifact path escapes OpenSpec root");
	const listed = new Set(new Bun.Glob("**/*.md").scanSync({ cwd: root }));
	if (!listed.has(artifact))
		throw new Error("artifact is not a listed Markdown file");
	const realRoot = realpathSync(root);
	const realFile = realpathSync(file);
	if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${sep}`))
		throw new Error("artifact path escapes OpenSpec root");
	return read(file);
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

export function discoverProjects(): Promise<ProjectOption[]> {
	// Transport/configuration failures propagate so the picker shows a
	// retryable discovery error instead of an empty success.
	return discoverProjectsInProcess();
}

export async function startWorkflow(input: {
	repo: string;
	ticket: string;
	workflowId: string;
	task?: string;
	mode: string;
	workflowType?: string;
	preset?: string;
	sourceBranch?: string;
	targetBranch?: string;
}) {
	const repo =
		input.workflowType === "research" && !input.repo
			? ""
			: input.repo.startsWith("~")
				? resolve(input.repo.replace("~", homedir()))
				: resolve(input.repo);
	return startWorkflowInProcess({ ...input, repo });
}
export function previewRepair(repo: string, workflowId: string) {
	return previewWorkflowRepair(repo, workflowId);
}
/** Repair through the typed backend API; falls back to the in-process
 * application when no server client is configured (test mode). */
export async function applyRepair(
	repo: string,
	workflowId: string,
	revision: number,
	targetStep: string,
	reason = "",
): Promise<WorkflowView> {
	return repairWorkflow(repo, workflowId, revision, targetStep, reason);
}

export async function answerQuestion(
	repo: string,
	workflowId: string,
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
): Promise<WorkflowView> {
	return answerWorkflowQuestion(repo, workflowId, revision, questionId, answer);
}

export async function runWorkflow(
	action: string,
	repo: string,
	workflowId: string,
	revision: number,
	argument?: string,
): Promise<string> {
	return runWorkflowAction(action, repo, workflowId, revision, argument);
}

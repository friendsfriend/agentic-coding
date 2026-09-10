/** Dashboard observation and execution I/O: filesystem, Git, Herdr, telemetry,
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
import { fileURLToPath } from "node:url";
import { directionBetween, Herdr, type Rect } from "../../herdr-client.ts";
import type { WorkflowView } from "../../workflow/contracts.ts";
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
	listWorkflowViews,
	previewWorkflowRepair,
	repairWorkflow,
	runWorkflowAction,
	setReturnInProcess,
	startWorkflowInProcess,
	viewToDashboardState,
	workflowExecutionError,
} from "./engine";
import {
	agentMetrics,
	costMessages,
	costSummary,
	countVerifierFindings,
	latestRunsByRole,
} from "./projections";
import type {
	DashboardData,
	DeveloperReviewComment,
	DeveloperReviewFinding,
	FindingCounts,
	LocalChange,
	PlanReviewComment,
	VerifierFinding,
	WikiReviewComment,
	WorkflowOverview,
	WorkflowState,
	WorktreeGitStatus,
} from "./types";

const herdr = new Herdr();
type DashboardObservation =
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
	  };

const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;
async function readBounded(
	stream: ReadableStream<Uint8Array>,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			total += part.value.byteLength;
			if (total > MAX_OBSERVATION_BYTES)
				throw new Error("dashboard observation response is too large");
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
		"utf8",
	);
}

async function observeAsync<T>(
	observation: DashboardObservation,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted)
		throw new DOMException("observation cancelled", "AbortError");
	const encoded = Buffer.from(JSON.stringify(observation)).toString("base64");
	const sourceEntry = fileURLToPath(new URL("../../cli.ts", import.meta.url));
	const runningFromBun = process.execPath.split("/").pop() === "bun";
	const args = runningFromBun
		? [process.execPath, sourceEntry, "__dashboard-observe", encoded]
		: [process.execPath, "__dashboard-observe", encoded];
	const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const abort = () => child.kill();
	signal?.addEventListener("abort", abort, { once: true });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const output = await Promise.race([
			readBounded(child.stdout),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					child.kill();
					reject(new Error("dashboard observation timed out"));
				}, 15_000);
			}),
		]);
		await child.exited;
		if (signal?.aborted)
			throw new DOMException("observation cancelled", "AbortError");
		const result = JSON.parse(output) as {
			ok: boolean;
			value?: T;
			error?: string;
		};
		if (!result.ok) throw new Error(result.error ?? "observation failed");
		return result.value as T;
	} finally {
		if (timeout) clearTimeout(timeout);
		child.kill();
		signal?.removeEventListener("abort", abort);
	}
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
				const identity = `${view.repository}\0${view.workflowId}`;
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
	return found.sort((a, b) =>
		a.state.workflowId.localeCompare(b.state.workflowId),
	);
}

export function listWorkflowsAsync(
	signal?: AbortSignal,
): Promise<WorkflowOverview[]> {
	return observeAsync<WorkflowOverview[]>({ kind: "workflows" }, signal);
}

export function discoverProjectsAsync(
	signal?: AbortSignal,
): Promise<Array<{ name: string; path: string; openspec: boolean }>> {
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
	workflowId: string,
	role: string,
) {
	const state = dashboardState(repo, workflowId) as WorkflowState;
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
					entry.fix ? `Resolution: ${entry.fix}` : "",
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
	// -uall expands untracked directories into their individual files (so a
	// file created inside a brand-new directory is its own reviewable row
	// instead of a single "?? dir/" entry whose diff errors); core.quotePath
	// keeps special-character paths raw, matching worktreeGitStatus.
	for (const line of (
		git(
			state.worktree,
			"-c",
			"core.quotePath=false",
			"status",
			"--short",
			"-uall",
		) ?? ""
	)
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

export function loadDashboardAsync(
	repo: string,
	workflowId: string,
	signal?: AbortSignal,
): Promise<DashboardData> {
	return observeAsync<DashboardData>(
		{ kind: "dashboard", repo, workflowId },
		signal,
	).then((dashboard) => {
		const error = workflowExecutionError(repo, workflowId);
		if (!error) return dashboard;
		return {
			...dashboard,
			state: {
				...dashboard.state,
				health: {
					...dashboard.state.health,
					valid: false,
					attention: [...dashboard.state.health.attention, error],
					diagnostic: error,
				},
			},
		};
	});
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
		review: reviewHistory.at(-1) ?? "Not run",
		reviewHistory,
		// Agent status has one source: the persisted run status that also drives
		// the Herdr tab-status glyphs (workflow/tab-status.ts, workflow/tab-sync.ts).
		// The pane map keys the rows (App.tsx focuses `state.panes[role]`), and
		// `latestRuns` is the same per-role projection `viewToDashboardState` used
		// to build that map, so the list and the focus target can never disagree.
		agents: Object.entries(state.panes)
			.filter(([role]) => !["git", "dashboard"].includes(role))
			.flatMap(([role]) => {
				const run = latestRuns.get(role);
				if (!run) return [];
				return [
					{
						role,
						status: run.status,
						runtime: run.runtime,
						model: run.model,
						cost: costByRole.get(role)?.cost,
						metrics: metricsByRole.get(role),
						findingCounts: role.endsWith("verifier")
							? verifierFindingCounts(state, role)
							: undefined,
					},
				];
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
	workflowId: string,
	workspace: string,
) {
	focusWorkspace(workspace);
	consumeReturnWorkspace(repo, workflowId, workspace);
}
export function focusWorkspace(workspace: string) {
	herdr.call("workspace", "focus", workspace);
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

export async function openFindingInEditorAsync(
	state: WorkflowState,
	finding: { path?: string; line?: number },
	signal?: AbortSignal,
) {
	if (!finding.path) throw new Error("Finding has no file path.");
	const file = join(state.worktree, finding.path);
	const call = herdr.callAsync;
	if (!call) return openFindingInEditor(state, finding);
	const pane = (
		(await call(
			[
				"tab",
				"create",
				"--workspace",
				state.workspace,
				"--label",
				`finding:${finding.path.split("/").at(-1)}`,
				"--focus",
			],
			signal,
		)) as { root_pane?: { pane_id?: string } }
	).root_pane?.pane_id;
	if (!pane) throw new Error("editor pane was not created");
	const editor = process.env.EDITOR || "vi";
	await call(
		[
			"pane",
			"run",
			pane,
			`${editor} +${finding.line ?? 1} ${JSON.stringify(file)}`,
		],
		signal,
	);
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

export async function focusAgentAsync(
	state: WorkflowState,
	pane: string,
	signal?: AbortSignal,
) {
	const call = herdr.callAsync;
	if (!call) return focusAgent(state, pane);
	await call(["workspace", "focus", state.workspace], signal);
	const paneResult = (await call(["pane", "get", pane], signal)) as {
		pane?: { tab_id?: string };
	};
	const tabId = paneResult.pane?.tab_id;
	if (!tabId) throw new Error("agent pane has no tab");
	await call(["tab", "focus", tabId], signal);
	for (let attempt = 0; attempt < 8; attempt++) {
		const layoutResult = (await call(
			["pane", "layout", "--pane", pane],
			signal,
		)) as {
			layout?: {
				focused_pane_id?: string;
				panes?: Array<{ pane_id: string; rect: Rect }>;
			};
		};
		const layout = layoutResult.layout;
		if (layout?.focused_pane_id === pane) return;
		const current = layout?.panes?.find(
			(item) => item.pane_id === layout?.focused_pane_id,
		);
		const target = layout?.panes?.find((item) => item.pane_id === pane);
		if (!layout || !current || !target)
			throw new Error("agent pane not present in focused tab");
		await call(
			[
				"pane",
				"focus",
				"--pane",
				current.pane_id,
				"--direction",
				directionBetween(current.rect, target.rect),
			],
			signal,
		);
	}
	throw new Error("could not reach agent pane");
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
	setReturnInProcess(state.repository, state.workflowId, returnWorkspace);
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
	const script = `read -r -p 'Repository path: ' repo; read -r -p 'Ticket identifier (optional): ' ticket; read -r -p 'Workflow ID: ' id; read -r -p 'Task: ' task; read -r -p 'Mode (worktree/checkout): ' mode; args=(start --repo "$repo" --workflow-id "$id" --task "$task" --mode "\${mode:-worktree}"); if [[ -n "$ticket" ]]; then args+=(--ticket "$ticket"); fi; herdr-workflow "\${args[@]}"`;
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
	workflowId: string;
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

export function previewRepair(repo: string, workflowId: string) {
	return previewWorkflowRepair(repo, workflowId);
}
export function applyRepair(
	repo: string,
	workflowId: string,
	revision: number,
	targetStep: string,
	reason = "",
) {
	return repairWorkflow(repo, workflowId, revision, targetStep, reason);
}

export function answerQuestion(
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
) {
	return answerWorkflowQuestion(repo, workflowId, revision, questionId, answer);
}

export async function runWorkflow(
	action: string,
	repo: string,
	workflowId: string,
	revision: number,
	argument?: string,
) {
	return runWorkflowAction(action, repo, workflowId, revision, argument);
}

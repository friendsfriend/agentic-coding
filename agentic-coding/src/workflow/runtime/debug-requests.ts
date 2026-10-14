// Delegated debug requests (add-debug-subagent-requests).
//
// A run can hand a focused "reproduce / check this in the running app" task to
// the `debug` role and keep working. The request is a durable row in the
// caller's own workflow store, so the caller's step machinery is untouched: the
// delegated run is a **side run** of the caller's instance (step
// `debug.investigate`, role `debug`) that lives outside `step.activeRunIds`,
// shares the caller's worktree and apps, and never advances the workflow.
//
// This module owns the row shape, the status transitions, the open-request
// limits, and the two pure git readings the lifecycle needs (the baseline taken
// when the run starts, and the files that changed since it at handoff). The
// engine, the CLI commands, the effects and the dashboard all read the same
// record through here.

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The `debug` family's investigation step. A delegated run is always this
 * step, whatever definition the caller workflow pins. */
export const DEBUG_INVESTIGATE_STEP = "debug.investigate";

export const DEBUG_REQUEST_STATUSES = [
	"queued",
	"running",
	"done",
	"failed",
	"cancelled",
] as const;
export type DebugRequestStatus = (typeof DEBUG_REQUEST_STATUSES)[number];

/** A request that has not reached a terminal status: it either still has a
 * launch pending (`queued`) or a live delegated run (`running`). */
export const OPEN_DEBUG_REQUEST_STATUSES: readonly DebugRequestStatus[] = [
	"queued",
	"running",
];

export function isOpenDebugRequest(status: DebugRequestStatus): boolean {
	return OPEN_DEBUG_REQUEST_STATUSES.includes(status);
}

/** One open request per caller run, two per workflow (design: limits). Both
 * counts are checked under the same write transaction that inserts the row. */
export const DEBUG_REQUEST_MAX_OPEN_PER_RUN = 1;
export const DEBUG_REQUEST_MAX_OPEN_PER_WORKFLOW = 2;

/** The goal text a request may carry, and the context beside it. Bounded so one
 * request can never fill the durable store or the delegated assignment. */
export const DEBUG_REQUEST_MAX_GOAL_CHARS = 4096;
export const DEBUG_REQUEST_MAX_CONTEXT_CHARS = 16_384;
/** The apps one request may name. */
export const DEBUG_REQUEST_MAX_APPS = 8;
const MAX_APP_IDENT_CHARS = 128;

export interface DebugRequestRow {
	id: string;
	workflow_id: string;
	caller_run_id: string;
	caller_role: string;
	goal: string;
	context: string | null;
	apps_json: string;
	status: DebugRequestStatus;
	debug_run_id: string | null;
	baseline_ref: string | null;
	baseline_files_json: string | null;
	report_path: string | null;
	changed_files_json: string | null;
	created_at: string;
	finished_at: string | null;
	delivered_at: string | null;
}

/** One request as every reader sees it: the durable row, decoded, with the
 * stored JSON columns already mapped and the duration derived from the two
 * timestamps it owns. */
export interface DebugRequest {
	id: string;
	workflowId: string;
	callerRunId: string;
	callerRole: string;
	goal: string;
	context?: string;
	apps: string[];
	status: DebugRequestStatus;
	debugRunId?: string;
	baselineRef?: string;
	/** Untracked files and their content hash when the run started. */
	baselineFiles: Record<string, string>;
	/** Whether the baseline can still measure tracked changes. A ref that git no
	 * longer resolves (a pruned `stash create` commit, a recreated worktree, a
	 * git failure at start) makes the touched-file report a subset, and every
	 * reader that shows the list has to say so. */
	baselineUsable: boolean;
	/** The markdown report written at handoff, when the run produced one. */
	reportPath?: string;
	/** Files that changed between the baseline and the handoff — the delegated
	 * run's own edits and the caller's, which cannot be told apart. */
	changedFiles: string[];
	createdAt: string;
	finishedAt?: string;
	/** When the report reached the caller's conversation. Absent means it did
	 * not (the caller had already ended): the artifact stands alone. */
	deliveredAt?: string;
}

function decodeJson<T>(value: string | null, fallback: T): T {
	if (value === null || value === "") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

/** The baseline's untracked-file hashes and its usability, from the stored JSON.
 * The column is written as `{ files, usable }`; a plain object is the shape an
 * earlier row of this build wrote, and is read as usable when it carries a ref
 * (the ref's own resolvability is re-checked when the list is produced). */
function decodeBaselineFiles(value: string | null): {
	baselineFiles: Record<string, string>;
	baselineUsable: boolean;
} {
	const decoded = decodeJson<unknown>(value, undefined);
	if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
		const record = decoded as { files?: unknown; usable?: unknown };
		if (record.files !== undefined)
			return {
				baselineFiles:
					record.files && typeof record.files === "object"
						? (record.files as Record<string, string>)
						: {},
				baselineUsable: record.usable !== false,
			};
		return {
			baselineFiles: decoded as Record<string, string>,
			baselineUsable: true,
		};
	}
	return { baselineFiles: {}, baselineUsable: false };
}

export function debugRequestFromRow(row: DebugRequestRow): DebugRequest {
	return {
		id: row.id,
		workflowId: row.workflow_id,
		callerRunId: row.caller_run_id,
		callerRole: row.caller_role,
		goal: row.goal,
		...(row.context ? { context: row.context } : {}),
		apps: decodeJson<string[]>(row.apps_json, []),
		status: row.status,
		...(row.debug_run_id ? { debugRunId: row.debug_run_id } : {}),
		...(row.baseline_ref ? { baselineRef: row.baseline_ref } : {}),
		...decodeBaselineFiles(row.baseline_files_json),
		...(row.report_path ? { reportPath: row.report_path } : {}),
		changedFiles: decodeJson<string[]>(row.changed_files_json, []),
		createdAt: row.created_at,
		...(row.finished_at ? { finishedAt: row.finished_at } : {}),
		...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
	};
}

/** Whole seconds between two ISO timestamps, or `undefined` while the request
 * has not finished. Never negative: a clock skew reads as zero, not as a
 * duration that would sort the row before its own creation. */
export function debugRequestDurationSeconds(
	request: Pick<DebugRequest, "createdAt" | "finishedAt">,
): number | undefined {
	if (!request.finishedAt) return undefined;
	const created = Date.parse(request.createdAt);
	const finished = Date.parse(request.finishedAt);
	if (!Number.isFinite(created) || !Number.isFinite(finished)) return undefined;
	return Math.max(0, Math.floor((finished - created) / 1000));
}

/** The statuses a request may move to. A terminal status is final: a late
 * effect answer never revives or relabels a finished request. */
const TRANSITIONS: Readonly<
	Record<DebugRequestStatus, readonly DebugRequestStatus[]>
> = Object.freeze({
	queued: ["running", "failed", "cancelled"],
	running: ["done", "failed", "cancelled"],
	done: [],
	failed: [],
	cancelled: [],
});

export function debugRequestTransitionAllowed(
	from: DebugRequestStatus,
	to: DebugRequestStatus,
): boolean {
	return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The one guard every status write goes through. */
export function assertDebugRequestTransition(
	from: DebugRequestStatus,
	to: DebugRequestStatus,
): void {
	if (!debugRequestTransitionAllowed(from, to))
		throw new Error(`debug request cannot move from ${from} to ${to}`);
}

export function debugRequestsForWorkflow(
	db: Database,
	workflowId: string,
): DebugRequest[] {
	return (
		db
			.query("SELECT * FROM debug_requests WHERE workflow_id=? ORDER BY rowid")
			.all(workflowId) as DebugRequestRow[]
	).map(debugRequestFromRow);
}

export function debugRequestById(
	db: Database,
	id: string,
): DebugRequest | undefined {
	const row = db
		.query("SELECT * FROM debug_requests WHERE id=?")
		.get(id) as DebugRequestRow | null;
	return row ? debugRequestFromRow(row) : undefined;
}

/** The request one run is the delegated run of, when it is one. This is how the
 * launch, stop and handoff paths recognize a side run. */
export function debugRequestForRun(
	db: Database,
	runId: string,
): DebugRequest | undefined {
	const row = db
		.query("SELECT * FROM debug_requests WHERE debug_run_id=? ORDER BY rowid")
		.get(runId) as DebugRequestRow | null;
	return row ? debugRequestFromRow(row) : undefined;
}

/** Open requests of one caller run, oldest first. */
export function openDebugRequestsForRun(
	db: Database,
	workflowId: string,
	callerRunId: string,
): DebugRequest[] {
	return debugRequestsForWorkflow(db, workflowId).filter(
		(request) =>
			request.callerRunId === callerRunId && isOpenDebugRequest(request.status),
	);
}

/** Open requests of one workflow, oldest first — the count the workflow-wide
 * limit is enforced against, and the list a refused handoff names. */
export function openDebugRequestsForWorkflow(
	db: Database,
	workflowId: string,
): DebugRequest[] {
	return debugRequestsForWorkflow(db, workflowId).filter((request) =>
		isOpenDebugRequest(request.status),
	);
}

/** The refusal of a new request, or `undefined` when it may start. Pure, so the
 * limits are testable without a store: both counts are taken under the caller's
 * write transaction. */
export function debugRequestLimitRefusal(input: {
	readonly goal: string;
	readonly openForRun: number;
	readonly openForWorkflow: number;
}): string | undefined {
	if (!input.goal.trim()) return "a debug request needs a non-empty goal";
	if (input.openForRun >= DEBUG_REQUEST_MAX_OPEN_PER_RUN)
		return `this run already has an open debug request; cancel it or wait for its result (at most ${DEBUG_REQUEST_MAX_OPEN_PER_RUN} open per run)`;
	if (input.openForWorkflow >= DEBUG_REQUEST_MAX_OPEN_PER_WORKFLOW)
		return `this workflow already has ${input.openForWorkflow} open debug requests (at most ${DEBUG_REQUEST_MAX_OPEN_PER_WORKFLOW} per workflow)`;
	return undefined;
}

export interface NewDebugRequest {
	readonly workflowId: string;
	readonly callerRunId: string;
	readonly callerRole: string;
	readonly goal: string;
	readonly context?: string;
	readonly apps?: readonly string[];
	readonly debugRunId: string;
	readonly createdAt: string;
}

/** Insert one queued request. The caller holds the workflow write transaction,
 * so the limit check it performed cannot race another request. */
export function insertDebugRequest(
	db: Database,
	request: NewDebugRequest,
): DebugRequest {
	const id = randomUUID();
	db.query(
		"INSERT INTO debug_requests(id,workflow_id,caller_run_id,caller_role,goal,context,apps_json,status,debug_run_id,baseline_ref,baseline_files_json,report_path,changed_files_json,created_at,finished_at,delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		request.workflowId,
		request.callerRunId,
		request.callerRole,
		request.goal.trim(),
		request.context?.trim() ? request.context.trim() : null,
		JSON.stringify([...(request.apps ?? [])]),
		"queued",
		request.debugRunId,
		null,
		null,
		null,
		null,
		request.createdAt,
		null,
		null,
	);
	const row = db
		.query("SELECT * FROM debug_requests WHERE id=?")
		.get(id) as DebugRequestRow;
	return debugRequestFromRow(row);
}

/** The mutable half of one request. Every field is optional; the row is only
 * written for the columns a caller actually changes. */
export interface DebugRequestUpdate {
	status?: DebugRequestStatus;
	baselineRef?: string;
	baselineFiles?: Record<string, string>;
	baselineUsable?: boolean;
	reportPath?: string;
	changedFiles?: readonly string[];
	finishedAt?: string;
	deliveredAt?: string | null;
}

export function updateDebugRequest(
	db: Database,
	id: string,
	update: DebugRequestUpdate,
): DebugRequest {
	const row = db
		.query("SELECT * FROM debug_requests WHERE id=?")
		.get(id) as DebugRequestRow | null;
	if (!row) throw new Error(`unknown debug request: ${id}`);
	const assignments: string[] = [];
	const values: Array<string | null> = [];
	const set = (column: string, value: string | null) => {
		assignments.push(`${column}=?`);
		values.push(value);
	};
	if (update.status !== undefined) {
		assertDebugRequestTransition(row.status, update.status);
		set("status", update.status);
	}
	// An empty ref is stored as NULL: "no baseline" is a state the row can carry,
	// and a reader must not see an empty string as a resolvable commit.
	if (update.baselineRef !== undefined)
		set("baseline_ref", update.baselineRef === "" ? null : update.baselineRef);
	if (
		update.baselineFiles !== undefined ||
		update.baselineUsable !== undefined
	) {
		// The two halves are written together, and a caller that changes only one
		// of them keeps the other: the handoff updates the usability of a baseline
		// the launch recorded.
		const current = decodeBaselineFiles(row.baseline_files_json);
		set(
			"baseline_files_json",
			JSON.stringify({
				files: update.baselineFiles ?? current.baselineFiles,
				usable: update.baselineUsable ?? current.baselineUsable,
			}),
		);
	}
	if (update.reportPath !== undefined) set("report_path", update.reportPath);
	if (update.changedFiles !== undefined)
		set("changed_files_json", JSON.stringify([...update.changedFiles]));
	if (update.finishedAt !== undefined) set("finished_at", update.finishedAt);
	if (update.deliveredAt !== undefined) set("delivered_at", update.deliveredAt);
	if (assignments.length) {
		db.query(
			`UPDATE debug_requests SET ${assignments.join(",")} WHERE id=?`,
		).run(...values, id);
	}
	const updated = db
		.query("SELECT * FROM debug_requests WHERE id=?")
		.get(id) as DebugRequestRow;
	return debugRequestFromRow(updated);
}

// ---------------------------------------------------------------------------
// Baseline and touched files
// ---------------------------------------------------------------------------

interface GitResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** One synchronous git reading. The baseline is taken and compared on the
 * engine's handoff path, which prepares its evidence before it opens the
 * workflow's write transaction — the same shape the debug family's own
 * `changes.patch` reading has. */
function git(cwd: string, ...args: string[]): GitResult {
	try {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: result.exitCode ?? 1,
			stdout: result.stdout?.toString() ?? "",
			stderr: result.stderr?.toString() ?? "",
		};
	} catch (error) {
		return {
			exitCode: 1,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

function contentHash(file: string): string | undefined {
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return undefined;
	}
}

/** The untracked files of a checkout, with the content hash each had. Workflow
 * metadata is never part of the reading: `.herdr-workflow` is this engine's own
 * bookkeeping, not the delegated run's work. */
function untrackedHashes(worktree: string): Record<string, string> {
	const listed = git(
		worktree,
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	);
	if (listed.exitCode !== 0) return {};
	const files: Record<string, string> = {};
	for (const file of listed.stdout.split("\0").filter(Boolean)) {
		if (file === ".herdr-workflow" || file.startsWith(".herdr-workflow/"))
			continue;
		const hash = contentHash(path.join(worktree, file));
		if (hash) files[file] = hash;
	}
	return files;
}

export interface DebugBaseline {
	/** A commit of the tracked working-tree state at start (`git stash create`),
	 * or `HEAD` when the checkout was clean. Empty when neither could be read. */
	readonly ref: string;
	readonly files: Record<string, string>;
}

/** Take the baseline the touched-file report is measured against. `git stash
 * create` records the current tracked state as a commit **without** touching
 * the worktree or the index; a clean checkout has nothing to record, so `HEAD`
 * is the baseline instead. Untracked files cannot be recorded that way, so
 * their content hashes are captured beside the ref. */
/** Whether git can still resolve a baseline ref. A pruned `stash create`
 * commit, a worktree that was re-created, or a git failure at start all leave a
 * ref that cannot measure tracked changes. */
function baselineRefResolvable(worktree: string, ref: string): boolean {
	if (!ref) return false;
	// `cat-file -e` asks whether the object still exists. `rev-parse --verify`
	// would answer yes for any syntactically valid object name, which is exactly
	// the pruned-or-unknown ref this has to detect.
	return git(worktree, "cat-file", "-e", ref).exitCode === 0;
}

export function captureDebugBaseline(worktree: string): DebugBaseline {
	const stashed = git(worktree, "stash", "create");
	let ref = stashed.exitCode === 0 ? stashed.stdout.trim() : "";
	if (!ref) {
		const head = git(worktree, "rev-parse", "HEAD");
		ref = head.exitCode === 0 ? head.stdout.trim() : "";
	}
	return { ref, files: untrackedHashes(worktree) };
}

/** The files that changed between the baseline and now: the tracked changes
 * against the baseline commit, plus every untracked file that was absent from
 * the baseline or whose content changed since. Both the delegated run's edits
 * and anything the caller wrote meanwhile are reported, because the two cannot
 * be told apart; the caller is told so in the delivery. */
export interface DebugTouchedFiles {
	readonly files: readonly string[];
	/** False when tracked changes could not be measured at all, so `files` is
	 * only the untracked delta and every reader has to say so. */
	readonly baselineUsable: boolean;
}

export function debugTouchedFiles(
	worktree: string,
	baseline: DebugBaseline,
): DebugTouchedFiles {
	const touched = new Set<string>();
	const usable = baselineRefResolvable(worktree, baseline.ref);
	if (usable) {
		const tracked = git(worktree, "diff", "--name-only", "-z", baseline.ref);
		if (tracked.exitCode === 0)
			for (const file of tracked.stdout.split("\0"))
				if (file && !file.startsWith(".herdr-workflow/")) touched.add(file);
	}
	const untracked = untrackedHashes(worktree);
	for (const [file, hash] of Object.entries(untracked))
		if (baseline.files[file] !== hash) touched.add(file);
	return { files: [...touched].sort(), baselineUsable: usable };
}

// ---------------------------------------------------------------------------
// Readers of a finished request
// ---------------------------------------------------------------------------

/** The refusal every caller lane that retires a run returns while one of its
 * debug requests is still open. One implementation, so the message a refused
 * handoff, a refused research handoff and the engine's own read all return is
 * the same text. */
export function openDebugRequestRefusal(
	requests: readonly DebugRequest[],
): string | undefined {
	if (!requests.length) return undefined;
	return `this run has ${requests.length} open debug request(s): ${requests
		.map((request) => request.id)
		.join(
			", ",
		)}. Collect the result with debug_result/debug_wait, or cancel the request with debug_cancel, before handing off.`;
}

/** The staged name the engine writes before the handoff transaction commits:
 * `commitStagedArtifacts` renames it over the report path right after the
 * commit, and a process that dies in that window leaves the bytes here. */
export function stagedDebugReportPath(request: {
	readonly reportPath?: string;
	readonly debugRunId?: string;
}): string | undefined {
	if (!request.reportPath || !request.debugRunId) return undefined;
	return `${request.reportPath}.${request.debugRunId}.tmp`;
}

/** The bytes of one finished request's report, completing a staged rename left
 * behind by a crash first.
 *
 * The row already knows both halves of the address (`report_path` and
 * `debug_run_id`), so an interrupted post-commit rename converges here on the
 * next read instead of leaving a `done` request whose report is unreachable.
 * A report that is neither in place nor staged answers `undefined`; the readers
 * present that as "no report", never as an empty one. */
export function resolveDebugReportPath(request: {
	readonly reportPath?: string;
	readonly debugRunId?: string;
}): string | undefined {
	const target = request.reportPath;
	if (!target) return undefined;
	if (isReadableFile(target)) return target;
	const staged = stagedDebugReportPath(request);
	if (!staged || !isReadableFile(staged)) return undefined;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.renameSync(staged, target);
	} catch {
		// A rename that cannot be completed (another process raced it, a read-only
		// parent) still has the bytes: read them where they are.
		return isReadableFile(staged) ? staged : undefined;
	}
	return target;
}

function isReadableFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tool-facing validation
// ---------------------------------------------------------------------------

/** Normalize the app idents one request names: trimmed, deduplicated, and
 * bounded in count and length. An empty result is a valid request — the
 * delegated run picks the repository's configured app itself. */
export function normalizeDebugApps(apps: readonly string[]): string[] {
	const normalized: string[] = [];
	for (const app of apps) {
		const name = app.trim();
		if (!name) continue;
		if (name.length > MAX_APP_IDENT_CHARS)
			throw new Error(
				`debug request app ident is too long (at most ${MAX_APP_IDENT_CHARS} characters)`,
			);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
			throw new Error(
				`debug request app ident must be a plain configured app name, received ${JSON.stringify(name)}`,
			);
		if (!normalized.includes(name)) normalized.push(name);
	}
	if (normalized.length > DEBUG_REQUEST_MAX_APPS)
		throw new Error(
			`a debug request may name at most ${DEBUG_REQUEST_MAX_APPS} apps`,
		);
	return normalized;
}

/** The goal and context a request carries, validated before anything is
 * stored. */
export function validateDebugRequestText(input: {
	readonly goal: string;
	readonly context?: string;
}): string | undefined {
	if (!input.goal.trim()) return "a debug request needs a non-empty goal";
	if (input.goal.length > DEBUG_REQUEST_MAX_GOAL_CHARS)
		return `the goal is longer than ${DEBUG_REQUEST_MAX_GOAL_CHARS} characters`;
	if ((input.context ?? "").length > DEBUG_REQUEST_MAX_CONTEXT_CHARS)
		return `the context is longer than ${DEBUG_REQUEST_MAX_CONTEXT_CHARS} characters`;
	return undefined;
}

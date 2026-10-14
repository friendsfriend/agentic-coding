// The `env-setup` workflow's drafts directory: its layout, the per-file diff of
// the drafts against the live configuration, and the write-guard fingerprint
// that detects a write outside the drafts directory.
//
// Drafts mirror the configuration layout (`apps/build/*`, `apps/run/*`,
// `apps/compose/*`, `apps/kubernetes/*`, `infrastructure/definitions/*`,
// `infrastructure/compose/*`), so a draft file's configuration-relative path is
// the path it will occupy once promoted. Nothing here executes anything: this
// module reads and hashes files and produces bounded text.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateWorkflowId } from "../../workflow/runtime/targets.ts";

export const SETUP_WORKFLOW_ID = "env-setup";
export const SETUP_DRAFTS_DIRECTORY = ".drafts";
export const SETUP_BACKUPS_DIRECTORY = ".backups";
const SETUP_FAMILY_DIRECTORY = path.join(
	SETUP_DRAFTS_DIRECTORY,
	SETUP_WORKFLOW_ID,
);
/**
 * Configuration-relative directories that exist only because the workflow runs,
 * so their own creation contributes no fingerprint line — while what they hold
 * does. The family directory is here too: this workflow's drafts appear inside
 * it, and its own existence must not read as a change to the configuration.
 */
export const SETUP_WALKED_ONLY_DIRECTORIES: readonly string[] = [
	SETUP_DRAFTS_DIRECTORY,
	SETUP_BACKUPS_DIRECTORY,
	SETUP_FAMILY_DIRECTORY,
];

/**
 * The paths one workflow's own state occupies inside the configuration root.
 * The fingerprint excludes exactly these — by *path*, never by name — so the
 * guard hides the drafts the author is allowed to write and the promotion's
 * own bookkeeping, and nothing else: a file whose name merely looks like the
 * workflow's state is still a change to the live configuration.
 */
export interface SetupFingerprintExclusion {
	/** This workflow's drafts directory (its promoted sibling too). */
	readonly draftsDir?: string;
	/** This workflow's promotion backup directory. */
	readonly backupDir?: string;
	/** The promotion's lock file. */
	readonly lockPath?: string;
}

/** Bound on one fingerprinted tree, so a pathological config cannot make the
 * guard walk forever. */
const FINGERPRINT_MAX_ENTRIES = 20_000;
const FINGERPRINT_MAX_DEPTH = 12;
/** Bytes of a large file that are hashed: its first and last block, so content
 * decides at every size while the read stays bounded. */
const FINGERPRINT_HASH_MAX_BYTES = 64 * 1024;
/** Line budget of the built-in diff; above it the file is reported as a whole
 * replacement instead of a hunk-by-hunk comparison. */
const DIFF_MAX_LINES = 600;
const DIFF_CONTEXT_LINES = 3;

/**
 * Configuration-relative prefixes a draft may name: the layout the author is
 * told to mirror. A draft outside them is refused by the validation gate and
 * by the promotion, so the drafts directory can never be used to publish a
 * file the configuration does not define (`.env`, `providers/*.json`, a
 * repository file).
 */
export const SETUP_DRAFT_PREFIXES: readonly string[] = [
	"apps/build/",
	"apps/run/",
	"apps/compose/",
	"apps/kubernetes/",
	"apps/k8s/",
	"infrastructure/definitions/",
	"infrastructure/compose/",
];

/** Whether a configuration-relative path is one a draft may publish. */
export function isAllowedDraftPath(relative: string): boolean {
	const normalized = relative.replaceAll("\\", "/");
	if (normalized.includes("..") || normalized.startsWith("/")) return false;
	return SETUP_DRAFT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** The drafts root every workflow's drafts directory lives under. */
export function setupDraftsRoot(configDir: string): string {
	return path.resolve(configDir, SETUP_FAMILY_DIRECTORY);
}

/**
 * The drafts directory of one setup workflow. The workflow id becomes a path
 * component here, so it is shape-validated (`validateWorkflowId`) and the
 * resolved directory is required to be a direct child of the drafts root: an
 * id that is not `[a-z0-9-]` — `..`, an absolute path — is refused before any
 * filesystem read.
 */
export function setupDraftsDir(configDir: string, workflowId: string): string {
	validateWorkflowId(workflowId);
	const root = setupDraftsRoot(configDir);
	const resolved = path.resolve(root, workflowId);
	if (path.dirname(resolved) !== root)
		throw new Error(
			`invalid env-setup workflow id: ${JSON.stringify(workflowId)} is not a drafts directory name`,
		);
	return resolved;
}

/**
 * Refuse a drafts directory that is not a direct child of the drafts root of
 * this configuration. A caller that received the directory from elsewhere
 * cannot widen the reads to another tree (the belt to `setupDraftsDir`'s
 * braces).
 */
export function assertSetupDraftsDir(
	configDir: string,
	draftsDir: string,
): void {
	const root = setupDraftsRoot(configDir);
	const resolved = path.resolve(draftsDir);
	if (path.dirname(resolved) !== root)
		throw new Error(
			`refusing drafts directory outside ${root}: ${JSON.stringify(draftsDir)}`,
		);
}

/** Where promoted drafts are moved once the live configuration owns them, so a
 * promoted workflow's overlay can no longer shadow the live files. */
export function setupPromotedDraftsDir(
	configDir: string,
	workflowId: string,
): string {
	return `${setupDraftsDir(configDir, workflowId)}.promoted`;
}

/** The protected backup directory of one setup workflow's promotion. */
export function setupBackupDir(configDir: string, workflowId: string): string {
	return path.join(
		configDir,
		SETUP_BACKUPS_DIRECTORY,
		`${SETUP_WORKFLOW_ID}-${workflowId}`,
	);
}

/** Whether a configuration-relative path is live when the workflow starts —
 * which is what makes a draft of it a replacement rather than an addition. */
export function liveConfigPath(configDir: string, relative: string): string {
	return path.join(configDir, ...relative.split("/"));
}

/**
 * Configuration-relative drafts with the kind of filesystem entry each one is.
 * A non-regular entry (a symlink, a fifo, a device) is reported rather than
 * dropped: the approval view, the validation gate and the promotion must agree
 * on which drafts exist, and only a plain file may be published.
 */
export function listDraftEntries(
	draftsDir: string,
): Array<{ relative: string; kind: "file" | "symlink" | "other" }> {
	const entries: Array<{
		relative: string;
		kind: "file" | "symlink" | "other";
	}> = [];
	const walk = (dir: string, relative: string, depth: number): void => {
		if (depth > FINGERPRINT_MAX_DEPTH) return;
		let children: fs.Dirent[];
		try {
			children = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const child = path.join(dir, entry.name);
			const childRelative =
				relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				walk(child, childRelative, depth + 1);
				continue;
			}
			entries.push({
				relative: childRelative,
				kind: entry.isFile()
					? "file"
					: entry.isSymbolicLink()
						? "symlink"
						: "other",
			});
		}
	};
	walk(draftsDir, "", 0);
	return entries.sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

/** Configuration-relative paths of every plain drafted file, sorted. */
export function listDraftFiles(draftsDir: string): string[] {
	return listDraftEntries(draftsDir)
		.filter((entry) => entry.kind === "file")
		.map((entry) => entry.relative);
}

/** A shared service every app depends on: a draft under `infrastructure/`. */
export function isSharedInfrastructurePath(relative: string): boolean {
	return relative.startsWith("infrastructure/");
}

export interface SetupDraftChange {
	/** Configuration-relative path, forward-slashed. */
	readonly path: string;
	readonly status: "added" | "modified";
	/** True when the draft modifies an existing shared service definition. */
	readonly sharedInfrastructure: boolean;
	readonly linesAdded: number;
	readonly linesDeleted: number;
	/** Unified diff against the live file (`/dev/null` for an addition). */
	readonly diff: string;
}

/**
 * Resolve a configuration-relative draft path inside its drafts directory. The
 * path arrives from the wire on the diff route, so an absolute path or one that
 * climbs out with `..` is refused instead of being read.
 */
export function draftPathWithin(draftsDir: string, relative: string): string {
	const root = path.resolve(draftsDir);
	const normalized = relative.replaceAll("\\", "/");
	// An absolute path or one that climbs out is refused outright; the
	// containment and real-path checks below are the belt to this brace.
	if (normalized.startsWith("/") || normalized.split("/").includes(".."))
		throw new Error(
			`refusing draft path outside the drafts directory: ${JSON.stringify(relative)}`,
		);
	const resolved = path.resolve(root, ...normalized.split("/"));
	if (!resolved.startsWith(`${root}${path.sep}`))
		throw new Error(
			`refusing draft path outside the drafts directory: ${JSON.stringify(relative)}`,
		);
	// A symbolic link inside the drafts tree is not a draft: the promotion
	// publishes plain files, so its real path must stay inside the tree too.
	let real = resolved;
	try {
		real = fs.realpathSync(resolved);
	} catch {
		// The path does not exist yet; the containment check above stands.
	}
	let realRoot = root;
	try {
		realRoot = fs.realpathSync(root);
	} catch {
		// The drafts directory does not exist yet; the containment check above
		// stands on its own.
	}
	if (real !== resolved && !real.startsWith(`${realRoot}${path.sep}`))
		throw new Error(
			`refusing draft path outside the drafts directory: ${JSON.stringify(relative)}`,
		);
	return resolved;
}

/** Every drafted file with its unified diff against the live configuration. */
export function setupDraftChanges(
	configDir: string,
	draftsDir: string,
): SetupDraftChange[] {
	assertSetupDraftsDir(configDir, draftsDir);
	const changes: SetupDraftChange[] = [];
	for (const relative of listDraftFiles(draftsDir)) {
		const change = setupDraftChange(configDir, draftsDir, relative);
		if (change) changes.push(change);
	}
	return changes;
}

/**
 * One drafted file's change against its live counterpart, reading only that
 * file and the live file it replaces: the per-file answer the diff popup asks
 * for, without re-diffing every other draft.
 */
export function setupDraftChange(
	configDir: string,
	draftsDir: string,
	relative: string,
): SetupDraftChange | undefined {
	assertSetupDraftsDir(configDir, draftsDir);
	const draftPath = draftPathWithin(draftsDir, relative);
	const livePath = liveConfigPath(configDir, relative);
	let draftText: string;
	try {
		draftText = fs.readFileSync(draftPath, "utf8");
	} catch {
		return undefined;
	}
	const liveText = fs.existsSync(livePath)
		? fs.readFileSync(livePath, "utf8")
		: undefined;
	const status = liveText === undefined ? "added" : "modified";
	const diff =
		liveText === undefined
			? addedFileDiff(relative, draftText)
			: unifiedDiff(relative, liveText, draftText);
	const counts = diffLineCounts(diff);
	return {
		path: relative,
		status,
		sharedInfrastructure:
			status === "modified" && isSharedInfrastructurePath(relative),
		linesAdded: counts.added,
		linesDeleted: counts.removed,
		diff,
	};
}

function diffLineCounts(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function addedFileDiff(relative: string, text: string): string {
	const lines = splitLines(text);
	const header = `--- /dev/null\n+++ b/${relative}\n`;
	if (!lines.length) return header;
	// The same bound `unifiedDiff` applies: an added file is never rendered in
	// full, so one large draft cannot turn the approval payload into a copy of
	// the file.
	const shown = lines.slice(0, DIFF_MAX_LINES);
	const truncated =
		lines.length > shown.length
			? [`+… ${lines.length - shown.length} more lines not shown`]
			: [];
	return `${header}@@ -0,0 +1,${lines.length} @@\n${[
		...shown.map((line) => `+${line}`),
		...truncated,
	].join("\n")}\n`;
}

/** Split like `diff` does: a trailing newline does not create a final empty
 * line, and a missing one is not a difference of its own. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * A bounded unified diff of two texts: identical prefixes and suffixes are
 * context, the middle is compared with an LCS table while both sides fit the
 * line budget, and a pair of larger files is reported as a whole replacement
 * rather than diffed without a bound.
 */
export function unifiedDiff(
	relative: string,
	oldText: string,
	newText: string,
): string {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const header = `--- a/${relative}\n+++ b/${relative}\n`;
	if (
		oldLines.length > DIFF_MAX_LINES ||
		newLines.length > DIFF_MAX_LINES ||
		oldLines.length * newLines.length > DIFF_MAX_LINES * DIFF_MAX_LINES
	)
		return `${header}@@ -1,${oldLines.length} +1,${newLines.length} @@\n${[
			...oldLines.map((line) => `-${line}`),
			...newLines.map((line) => `+${line}`),
		].join("\n")}\n`;

	const prefix = commonPrefix(oldLines, newLines);
	const suffix = commonSuffix(oldLines.slice(prefix), newLines.slice(prefix));
	const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
	const newMiddle = newLines.slice(prefix, newLines.length - suffix);
	if (prefix === oldLines.length && prefix === newLines.length) return "";

	const body = lcsDiff(oldMiddle, newMiddle);
	// Context blocks: the unchanged prefix and suffix lines around the change.
	const contextBefore = oldLines.slice(
		Math.max(0, prefix - DIFF_CONTEXT_LINES),
		prefix,
	);
	const contextAfter = suffix
		? oldLines.slice(oldLines.length - Math.min(suffix, DIFF_CONTEXT_LINES))
		: [];
	const oldStart = Math.max(1, prefix - contextBefore.length + 1);
	const newStart = Math.max(1, prefix - contextBefore.length + 1);
	const hunk =
		body.length === 0
			? []
			: [
					`@@ -${oldStart},${contextBefore.length + oldMiddle.length + contextAfter.length} +${newStart},${contextBefore.length + newMiddle.length + contextAfter.length} @@`,
					...contextBefore.map((line) => ` ${line}`),
					...body,
					...contextAfter.map((line) => ` ${line}`),
				];
	return hunk.length ? `${header}${hunk.join("\n")}\n` : "";
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
	let index = 0;
	while (index < a.length && index < b.length && a[index] === b[index]) index++;
	return index;
}

function commonSuffix(a: readonly string[], b: readonly string[]): number {
	let count = 0;
	while (
		count < a.length &&
		count < b.length &&
		a[a.length - 1 - count] === b[b.length - 1 - count]
	)
		count++;
	return count;
}

/** A minimal LCS-based line diff; the caller has already bounded both sides. */
function lcsDiff(
	oldLines: readonly string[],
	newLines: readonly string[],
): string[] {
	const rows = oldLines.length + 1;
	const columns = newLines.length + 1;
	const table = new Uint32Array(rows * columns);
	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			table[i * columns + j] =
				oldLines[i] === newLines[j]
					? (table[(i + 1) * columns + j + 1] as number) + 1
					: Math.max(
							table[(i + 1) * columns + j] as number,
							table[i * columns + j + 1] as number,
						);
		}
	}
	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			out.push(` ${oldLines[i]}`);
			i++;
			j++;
		} else if (
			(table[(i + 1) * columns + j] as number) >=
			(table[i * columns + j + 1] as number)
		) {
			out.push(`-${oldLines[i]}`);
			i++;
		} else {
			out.push(`+${newLines[j]}`);
			j++;
		}
	}
	while (i < oldLines.length) out.push(`-${oldLines[i++]}`);
	while (j < newLines.length) out.push(`+${newLines[j++]}`);
	return out;
}

/**
 * A deterministic fingerprint of a directory tree. Every entry contributes its
 * path, size and — for files up to the hash bound — its *content* hash; only a
 * file too large to hash contributes its mtime as well. Content is what the
 * guard decides on: an edit, an addition and a delete all change the digest,
 * while a byte-identical restore (the promotion's own rollback, a `touch`)
 * does not — which is what keeps the guard from condemning the workflow's own
 * work.
 */
export function fingerprintDirectory(
	root: string,
	exclusion: SetupFingerprintExclusion = {},
): string {
	const entries: string[] = [];
	const excluded = new Set(
		[exclusion.draftsDir, exclusion.backupDir, exclusion.lockPath]
			.filter(
				(value): value is string => typeof value === "string" && value !== "",
			)
			.flatMap((value) => [
				path.resolve(value),
				`${path.resolve(value)}.promoted`,
			]),
	);
	let visited = 0;
	const walk = (dir: string, relative: string, depth: number): void => {
		if (depth > FINGERPRINT_MAX_DEPTH || visited > FINGERPRINT_MAX_ENTRIES)
			return;
		let names: string[];
		try {
			names = fs.readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const child = path.join(dir, name);
			const childRelative = relative === "" ? name : `${relative}/${name}`;
			// This workflow's own state is the only thing hidden, and it is hidden
			// by path: another workflow's drafts, or a live file whose name merely
			// looks like this workflow's state, still counts.
			if (excluded.has(path.resolve(child))) continue;
			if (SETUP_WALKED_ONLY_DIRECTORIES.includes(childRelative)) {
				walk(child, childRelative, depth + 1);
				continue;
			}
			let stats: fs.Stats;
			try {
				stats = fs.statSync(child);
			} catch {
				continue;
			}
			visited++;
			if (stats.isDirectory()) {
				entries.push(`d ${childRelative}`);
				walk(child, childRelative, depth + 1);
				continue;
			}
			if (!stats.isFile()) continue;
			entries.push(
				`f ${childRelative} ${stats.size} ${fileContentDigest(child, stats.size)}`,
			);
		}
	};
	walk(root, "", 0);
	return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/**
 * A content digest that never falls back to mtime: a file within the hash bound
 * is hashed whole, a larger one by its size and its first and last block. A
 * byte-identical restore is therefore invisible at every size (which is what
 * keeps the workflow's own rollback from condemning itself), while an edit
 * anywhere in a small file, or one that changes a large file's size, head or
 * tail, is visible. An edit confined to the unread middle of an oversized file
 * is the documented blind spot.
 */
function fileContentDigest(filePath: string, size: number): string {
	try {
		if (size <= FINGERPRINT_HASH_MAX_BYTES)
			return createHash("sha256")
				.update(fs.readFileSync(filePath))
				.digest("hex")
				.slice(0, 32);
		const fd = fs.openSync(filePath, "r");
		try {
			const block = Buffer.allocUnsafe(FINGERPRINT_HASH_MAX_BYTES);
			const hash = createHash("sha256");
			hash.update(String(size));
			const head = fs.readSync(fd, block, 0, block.length, 0);
			hash.update(block.subarray(0, head));
			if (size > FINGERPRINT_HASH_MAX_BYTES) {
				const tailStart = Math.max(0, size - FINGERPRINT_HASH_MAX_BYTES);
				const tail = fs.readSync(fd, block, 0, block.length, tailStart);
				hash.update(block.subarray(0, tail));
			}
			return hash.digest("hex").slice(0, 32);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "-";
	}
}

/**
 * The checkout's own fingerprint: its uncommitted work (`git status
 * --porcelain`) plus whether the tree is on the branch the workflow pinned.
 * A repository that git cannot read fingerprints as absent rather than as
 * unchanged, so the guard never mistakes an unreadable tree for a clean one.
 */
export function fingerprintCheckout(checkoutDir: string): string {
	if (checkoutDir === "") return "";
	const status = Bun.spawnSync(
		["git", "-C", checkoutDir, "status", "--porcelain"],
		{ stdout: "pipe", stderr: "ignore" },
	);
	if (status.exitCode !== 0) return "";
	const head = Bun.spawnSync(["git", "-C", checkoutDir, "rev-parse", "HEAD"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	const headText = head.exitCode === 0 ? head.stdout.toString().trim() : "";
	return createHash("sha256")
		.update(`${headText}\n${status.stdout.toString()}`)
		.digest("hex");
}

export interface SetupGuardBaseline {
	readonly configDir: string;
	readonly checkoutDir: string;
	readonly configFingerprint: string;
	readonly checkoutFingerprint: string;
}

/**
 * The armed baselines the workflow store carries, keyed by the run identity of
 * the workflow that armed them (`metadata.createdAt`, pinned at start). The
 * baseline deliberately lives in the workflow's own persisted snapshot rather
 * than in a file under the configuration root: a file there is state the
 * authoring agent can write, which would make the guard's verdict forgeable by
 * the process it monitors.
 */
export type SetupGuardBaselines = Readonly<
	Record<string, SetupGuardBaseline | undefined>
>;

/** One armed baseline as the snapshot stores it. */
export function readArmedBaseline(
	baselines: SetupGuardBaselines | undefined,
	runId: string,
): SetupGuardBaseline | undefined {
	const armed = baselines?.[runId];
	if (!armed) return undefined;
	if (
		typeof armed.configDir !== "string" ||
		typeof armed.checkoutDir !== "string" ||
		typeof armed.configFingerprint !== "string" ||
		typeof armed.checkoutFingerprint !== "string"
	)
		return undefined;
	return armed;
}

/**
 * What changed since the baseline was taken, as bounded human-readable
 * violations. Empty means the drafts directory was the only thing the author
 * wrote — the condition the workflow needs before it validates anything. Pure,
 * so the guard's decision is testable without an engine.
 */
export function setupGuardViolations(
	baseline: SetupGuardBaseline,
	current: SetupGuardBaseline,
): string[] {
	const violations: string[] = [];
	if (baseline.configDir !== current.configDir)
		violations.push(
			`the configuration root moved from ${baseline.configDir} to ${current.configDir}`,
		);
	else if (baseline.configFingerprint !== current.configFingerprint)
		violations.push(
			`the live configuration changed outside the drafts directory (${current.configDir})`,
		);
	if (baseline.checkoutDir !== current.checkoutDir)
		violations.push(
			`the checkout moved from ${baseline.checkoutDir} to ${current.checkoutDir}`,
		);
	else if (baseline.checkoutFingerprint !== current.checkoutFingerprint)
		violations.push(
			`the repository checkout changed (${current.checkoutDir}); it is read-only evidence for this workflow`,
		);
	return violations;
}

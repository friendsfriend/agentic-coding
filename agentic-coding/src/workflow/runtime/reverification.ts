// The fix delta of a verification round (role-scoped re-verification): the
// content digests of the tree the round verified, and which files the fix
// changed since. File-system I/O belongs here in the runtime layer, never in
// `steps/` — the scope *decision* is pure domain and reads only what this module
// stamped into the snapshot.
//
// The measurement is a content digest set, not a git diff: it needs no ref (so
// nothing can be pruned out from under it), it covers untracked files, and one
// file is the granularity ownership has. Every cap is a widening trigger — an
// observation that could not be taken marks the record incomplete, and an
// incomplete record never scopes a round — and every read is bounded *before* it
// happens: the manifest is git's view of a worktree agents write, so a path in
// it is a path this module may only read when it is a regular file inside the
// worktree and no larger than the per-file cap.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	VERIFICATION_SCOPE_DIGEST_LENGTH,
	VERIFICATION_SCOPE_MAX_PATH_BYTES,
	type VerificationScopeBaseline,
	type VerificationScopeDelta,
	type VerificationScopeDigest,
} from "../../contracts/workflow.ts";
import { WorkflowRuntimeError } from "../contracts.ts";
import { loadConfig, type WorkflowConfig } from "../effects.ts";
import { HERDR_WORKFLOW_DIRECTORY } from "../observability.ts";
import {
	DEFAULT_MIN_REVERIFICATION_CHANGED_FILES,
	MIN_REVERIFICATION_CHANGED_FILES_RANGE,
} from "../steps/reverification.ts";

/** At most this many manifest entries are digested, in this many bytes per file,
 * with this many bytes in total. Any overflow is an unmeasurable delta. */
export const VERIFICATION_SCOPE_MAX_ENTRIES = 512;
export const VERIFICATION_SCOPE_MAX_FILE_BYTES = 1024 * 1024;
export const VERIFICATION_SCOPE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** The reserved digest pair of a path the tree no longer has. A deletion is a
 * real change: the record must be able to say "this path existed at the
 * baseline and does not exist now" (and the reverse), which it cannot do by
 * omitting the path. A sha256 prefix collides with this value with probability
 * 2^-64, so no real file can be mistaken for a deletion. */
const DELETED_DIGEST = "0".repeat(VERIFICATION_SCOPE_DIGEST_LENGTH);
/** How far into a file the binary sniff reads. */
const BINARY_SNIFF_BYTES = 8 * 1024;
const ASCII_WHITESPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

export interface VerificationTreeObservation {
	complete: boolean;
	files: VerificationScopeDigest[];
}

/** What one manifest path turned out to be. */
type FileObservation =
	| { kind: "digest"; digest: VerificationScopeDigest; bytes: number }
	| { kind: "deleted" }
	| { kind: "unmeasurable" };

/** Whether a manifest path is the engine's own bookkeeping. The store lives
 * inside the worktree, so its telemetry, run artifacts, and evidence change on
 * every step; counting them as "the fix" would widen every round and make the
 * optimization invisible. */
function isStorePath(relative: string): boolean {
	return (
		relative === HERDR_WORKFLOW_DIRECTORY ||
		relative.startsWith(`${HERDR_WORKFLOW_DIRECTORY}/`)
	);
}

/** The 16-character digests of one file's bytes: over the bytes, and over the
 * same bytes with ASCII whitespace removed. A binary file (a NUL byte in the
 * first 8 KiB) uses the raw digest for both, so it can never read as a
 * whitespace-only edit. The whitespace is stripped into one scratch buffer and
 * hashed once, because one `update` per byte costs ~75x this on a megabyte. */
function digestBytes(relative: string, bytes: Buffer): VerificationScopeDigest {
	const raw = createHash("sha256")
		.update(bytes)
		.digest("hex")
		.slice(0, VERIFICATION_SCOPE_DIGEST_LENGTH);
	if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0))
		return { path: relative, raw, normalized: raw };
	const scratch = Buffer.allocUnsafe(bytes.byteLength);
	let kept = 0;
	for (const byte of bytes)
		if (!ASCII_WHITESPACE.has(byte)) scratch[kept++] = byte;
	const normalized =
		kept === bytes.byteLength
			? raw
			: createHash("sha256")
					.update(scratch.subarray(0, kept))
					.digest("hex")
					.slice(0, VERIFICATION_SCOPE_DIGEST_LENGTH);
	return { path: relative, raw, normalized };
}

/** Observe one manifest path without trusting it: the path must stay inside the
 * worktree (an untracked symlink an agent wrote resolves out of it), must be a
 * regular file (a FIFO or `/dev/zero` never ends), and is capped before it is
 * read. A path the tree no longer has is a deletion, not a failure. */
function digestFile(
	root: string,
	rootReal: string,
	relative: string,
): FileObservation {
	if (relative.length === 0 || path.isAbsolute(relative))
		return { kind: "unmeasurable" };
	if (relative.split(/[\\/]/).includes("..")) return { kind: "unmeasurable" };
	let real: string;
	try {
		real = fs.realpathSync(path.join(root, relative));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "deleted" };
		throw error;
	}
	if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`))
		return { kind: "unmeasurable" };
	let fd: number;
	try {
		fd = fs.openSync(real, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "deleted" };
		throw error;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return { kind: "unmeasurable" };
		// Checked before the read, so an oversized changed file costs a stat and
		// no allocation.
		if (stat.size > VERIFICATION_SCOPE_MAX_FILE_BYTES)
			return { kind: "unmeasurable" };
		const bytes = Buffer.allocUnsafe(stat.size + 1);
		const read = fs.readSync(fd, bytes, 0, bytes.byteLength, 0);
		// A file that grew between the stat and the read is not the file this
		// measurement would describe.
		if (read !== stat.size) return { kind: "unmeasurable" };
		const view = bytes.subarray(0, read);
		return { kind: "digest", bytes: read, digest: digestBytes(relative, view) };
	} finally {
		fs.closeSync(fd);
	}
}

/** Digest the given manifest paths as they are on disk now. Non-throwing: a cap
 * overflow or an unreadable file reports `complete: false`, which widens the
 * round instead of failing the handoff that measures it. */
export function observeVerificationTree(
	root: string,
	paths: readonly string[],
): VerificationTreeObservation {
	const files: VerificationScopeDigest[] = [];
	const seen = new Set<string>();
	if (paths.length > VERIFICATION_SCOPE_MAX_ENTRIES)
		return { complete: false, files: [] };
	let rootReal: string;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		return { complete: false, files: [] };
	}
	let total = 0;
	for (const relative of paths) {
		if (seen.has(relative)) continue;
		seen.add(relative);
		if (isStorePath(relative)) continue;
		// A path the record cannot hold is unmeasurable rather than unwritable: the
		// record never carries what the schema would refuse, so the round widens
		// instead of refusing the handoff that records it.
		if (Buffer.byteLength(relative, "utf8") > VERIFICATION_SCOPE_MAX_PATH_BYTES)
			return { complete: false, files: [] };
		let observed: FileObservation;
		try {
			observed = digestFile(root, rootReal, relative);
		} catch {
			return { complete: false, files: [] };
		}
		if (observed.kind === "unmeasurable") return { complete: false, files: [] };
		if (observed.kind === "deleted") {
			files.push({
				path: relative,
				raw: DELETED_DIGEST,
				normalized: DELETED_DIGEST,
			});
			continue;
		}
		total += observed.bytes;
		if (total > VERIFICATION_SCOPE_MAX_TOTAL_BYTES)
			return { complete: false, files: [] };
		files.push(observed.digest);
	}
	return { complete: true, files };
}

/** The tree a round verified, stamped with the round it opens. */
export function captureVerificationBaseline(
	observation: VerificationTreeObservation,
	round: number,
): VerificationScopeBaseline {
	return {
		round,
		complete: observation.complete,
		files: observation.files,
	};
}

/** Which files the fix touched since `baseline`, and which of those changed in
 * content rather than only in whitespace. An added path, a removed path, and a
 * deleted file the baseline never held (it is listed by the changed-file
 * manifest, so it differs from the commit the branch started from) are all
 * substantive. Non-throwing: a missing, foreign-round, or incomplete baseline
 * yields an incomplete delta, and the round widens. */
export function measureVerificationDelta(
	observation: VerificationTreeObservation,
	baseline: VerificationScopeBaseline | undefined,
	round: number,
	threshold: number,
): VerificationScopeDelta {
	const incomplete: VerificationScopeDelta = {
		round,
		complete: false,
		threshold,
		files: [],
	};
	if (!observation.complete || !baseline || baseline.complete !== true)
		return incomplete;
	if (baseline.round !== round) return incomplete;
	const before = new Map(baseline.files.map((entry) => [entry.path, entry]));
	const files: VerificationScopeDelta["files"] = [];
	for (const entry of observation.files) {
		const previous = before.get(entry.path);
		if (!previous) {
			files.push({ path: entry.path, substantive: true });
			continue;
		}
		before.delete(entry.path);
		if (previous.raw === entry.raw) continue;
		files.push({
			path: entry.path,
			substantive: previous.normalized !== entry.normalized,
		});
	}
	// Whatever the baseline still holds is gone from the tree: a removal is a
	// content change, and an unlisted one is not silently ignored.
	for (const entry of before.values())
		files.push({ path: entry.path, substantive: true });
	if (files.length > VERIFICATION_SCOPE_MAX_ENTRIES) return incomplete;
	files.sort((left, right) => (left.path < right.path ? -1 : 1));
	return { round, complete: true, threshold, files };
}

/** Fold a second fix measured in the same round window into the round's delta. A
 * round can hand off twice — a fix, a skipped round, a developer review, another
 * fix — and the second fix's files must not replace the first fix's: a path is
 * substantive when either measurement says so, so the round runs the owners of
 * both. An incomplete measurement on either side keeps the delta incomplete,
 * which widens the round. */
export function unionVerificationDelta(
	measured: VerificationScopeDelta,
	previous: VerificationScopeDelta | undefined,
): VerificationScopeDelta {
	if (!previous || previous.round !== measured.round) return measured;
	if (previous.complete !== true || measured.complete !== true)
		return { ...measured, complete: false };
	const merged = new Map<string, boolean>();
	for (const file of previous.files) merged.set(file.path, file.substantive);
	for (const file of measured.files)
		merged.set(file.path, (merged.get(file.path) ?? false) || file.substantive);
	const files = [...merged.entries()].map(([file, substantive]) => ({
		path: file,
		substantive,
	}));
	if (files.length > VERIFICATION_SCOPE_MAX_ENTRIES)
		return { ...measured, complete: false };
	files.sort((left, right) => (left.path < right.path ? -1 : 1));
	return {
		round: measured.round,
		complete: true,
		threshold: measured.threshold,
		files,
	};
}

/** The minimum number of files a fix must change in content for a round to open
 * with its owners (`workflow.min_reverification_changed_files`, an integer in
 * the configured range, default 1). `0` disables the rule. Resolved where the
 * delta is measured, because the pure decision cannot load configuration. */
export function minReverificationChangedFiles(
	config: WorkflowConfig = loadConfig(),
): number {
	const [minimum, maximum] = MIN_REVERIFICATION_CHANGED_FILES_RANGE;
	const configured = config.workflow.min_reverification_changed_files;
	if (configured === undefined) return DEFAULT_MIN_REVERIFICATION_CHANGED_FILES;
	if (
		!Number.isInteger(configured) ||
		configured < minimum ||
		configured > maximum
	)
		throw new WorkflowRuntimeError(
			"config",
			`min_reverification_changed_files must be an integer from ${minimum} to ${maximum}`,
		);
	return configured;
}

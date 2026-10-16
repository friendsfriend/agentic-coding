// The `env-setup` staged configuration root (`staged-env-setup-config-root`).
//
// The first real run proved the per-file overlay wrong: a drafted compose file
// resolved its `include:` and its relative mounts *inside the partial drafts
// tree*, so the author rewrote the file to fit the draft location and what was
// tested was not what got promoted. This module materializes a complete working
// configuration root instead — the live configuration copied at its own
// relative layout, with the author's drafts written at their final paths — so a
// draft behaves exactly as it will after promotion.
//
// Four properties are deliberate:
//
//   - live symlinks are recreated as absolute symlinks to the same target, so
//     production's symlink behaviour (the `-f` failure of the motivating run)
//     is exercised by the gate rather than papered over;
//   - `.env` and `providers/` are exposed *read-only*: private copies (mode
//     0o400) inside the workflow's own 0o700 state directory, never symlinks.
//     A symlink is write-through — a stray write from a drafted script would
//     rewrite the developer's live `.env` before approval — so the exposure is
//     a copy, and the promotion's prefix allow-list makes them unpublishable;
//   - the base snapshot records, per path, the digest *of the staged copy* (the
//     change-set baseline), the digest *of the live file it was copied from*
//     (the promotion's conflict check) and the symlink target — never secret
//     content, and authenticated with the run's pinned promotion secret so a
//     snapshot written by hand under `.drafts` is not adopted;
//   - the root is published by a single rename from a private staging
//     directory, so `hasStagedRoot` never sees a half-copied tree and two
//     concurrent (re-claimed) materializations cannot clobber each other.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ENVIRONMENT_DISCOVERY_FILE } from "../environment-discovery.ts";
import {
	assertSetupDraftsDir,
	SETUP_DRAFTS_DIRECTORY,
	SETUP_STAGED_READONLY_NAMES,
	type StagedBaseEntry,
	setupDraftsDir,
	setupDraftsRoot,
	setupPromotedDraftsDir,
	stagedBaseMac,
	stagedBasePathOf,
	stagedFileDigest,
	stagedRootOf,
} from "./setup-drafts.ts";

/** Top-level configuration entries the staged root drops outright: they are
 * large, irrelevant to a definition, or the workflow's own bookkeeping. */
export const SETUP_STAGED_DROPPED_NAMES: readonly string[] = [
	SETUP_DRAFTS_DIRECTORY,
	".backups",
	"wiki",
	"telemetry",
	"snapshots",
	// The running server's discovery record hands off a URL and a bearer token:
	// copying it would duplicate a live credential into every state directory
	// (`environment-setup-workflow`: "the server's discovery record SHALL NOT be
	// copied").
	ENVIRONMENT_DISCOVERY_FILE,
];
/** Top-level entries exposed to the staged runs but never published: private
 * read-only *copies*, so a write into the staged tree can never reach the live
 * credential store (the promotion's prefix allow-list excludes them too). */
/** Mode of an exposed credential copy inside the 0o700 state directory. */
const STAGED_SECRET_MODE = 0o400;
/** The hash bound the bounded digest uses: a file at or below it is read whole,
 * which lets the copy and its digests come from one read. */
const STAGED_HASH_MAX_BYTES = 64 * 1024;
/** How many stale state directories one sweep removes: the rest wait for the
 * next start, so housekeeping never delays a start by more than a few deletes. */
const SWEEP_MAX_REMOVALS = 4;

/** Bound on one staged root, so one pathological configuration cannot fill the
 * disk. A configuration above it refuses the start instead. */
const STAGED_MAX_ENTRIES = 20_000;
const STAGED_MAX_DEPTH = 12;
const STAGED_MAX_BYTES = 512 * 1024 * 1024;
/** The staged root is the workflow's own working tree: private. */
const STAGED_ROOT_MODE = 0o700;
const STAGED_BASE_MODE = 0o600;

export interface SetupStagedMaterializeOptions {
	readonly configDir: string;
	readonly draftsDir: string;
	readonly maxEntries?: number;
	readonly maxBytes?: number;
	/** The run's pinned promotion secret: authenticates the base snapshot, so a
	 * `base.json` written by hand under `.drafts` is never adopted. */
	readonly secret?: string;
	/** Filesystem hooks, so a failure path is testable without a real disk. */
	readonly copyFile?: (from: string, to: string) => void;
	readonly symlink?: (target: string, linkPath: string) => void;
	/** Staging-directory token; defaults to a random one. */
	readonly token?: string;
}

export interface SetupStagedMaterializeResult {
	readonly ok: boolean;
	/** The staged root exists and is usable after this call. */
	readonly staged: boolean;
	/** A materialization was already there: nothing was touched. */
	readonly alreadyStaged: boolean;
	readonly entries: number;
	readonly bytes: number;
	readonly excluded: string[];
	readonly error?: string;
}

/**
 * Materialize the staged configuration root. Idempotent: an existing complete
 * root is left exactly as the author left it, so a re-claimed durable effect
 * never clobbers the author's edits. The copy is built in a private sibling and
 * published with a single rename, so a concurrent (re-claimed) call finds
 * either nothing — and copies again — or a complete root.
 */
export async function materializeStagedRoot(
	options: SetupStagedMaterializeOptions,
): Promise<SetupStagedMaterializeResult> {
	// The materializer is the one function that removes a directory tree, so the
	// containment check belongs to it and not only to its callers.
	assertSetupDraftsDir(options.configDir, options.draftsDir);
	const draftsDir = options.draftsDir;
	const root = stagedRootOf(draftsDir);
	const basePath = stagedBasePathOf(draftsDir);
	const empty = {
		ok: false as const,
		staged: false,
		alreadyStaged: false,
		entries: 0,
		bytes: 0,
		excluded: [],
	};
	if (fs.existsSync(root) && fs.existsSync(basePath))
		return {
			ok: true,
			staged: true,
			alreadyStaged: true,
			entries: 0,
			bytes: 0,
			excluded: [],
		};
	if (fs.existsSync(draftsDir) && !isDirectory(draftsDir))
		return { ...empty, error: `${draftsDir} is not a directory` };
	/** What this call published: after a lost race the tree and the snapshot
	 * belong to the attempt that won it. */
	let publishedTree = false;
	let publishedBase = false;
	// A root without a base snapshot is either a materialization that is still
	// publishing (the window between the two renames) or one that crashed in it.
	// The two are told apart by waiting: a live publisher lands its snapshot
	// within the wait, and only a root that nobody claims is discarded.
	if (fs.existsSync(root) && !fs.existsSync(basePath)) {
		// Evidence, not a timer: a materialization publishes the tree *before* the
		// snapshot, so a live publisher still owns its `.staging-<token>` directory.
		// Only while one is there is this wait worthwhile; without one the root is a
		// crash leftover, rebuilt below.
		const publishing = stagingDirectories(draftsDir).length > 0;
		for (
			let attempt = 0;
			publishing && attempt < 20 && !fs.existsSync(basePath);
			attempt++
		)
			await waitFor(100);
		if (fs.existsSync(basePath)) {
			publishedTree = false;
			publishedBase = false;
			return {
				ok: true,
				staged: true,
				alreadyStaged: true,
				entries: 0,
				bytes: 0,
				excluded: [],
			};
		}
	}
	if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
	if (fs.existsSync(basePath)) fs.rmSync(basePath, { force: true });
	// The walk is asynchronous (`node:fs/promises`) on purpose: materialization
	// runs on the same event loop as the server that serves the TUI and every
	// other workflow, so a synchronous copy would freeze all of them for the
	// duration. The hooks stay available for a failure path to be tested.
	const copyFile =
		options.copyFile ??
		((from: string, to: string) => fs.promises.copyFile(from, to));
	const symlink =
		options.symlink ??
		((target: string, linkPath: string) =>
			fs.promises.symlink(target, linkPath));
	const maxEntries = options.maxEntries ?? STAGED_MAX_ENTRIES;
	const maxBytes = options.maxBytes ?? STAGED_MAX_BYTES;
	const entries: Record<string, StagedBaseEntry> = {};
	const excluded: string[] = [];
	let count = 0;
	let bytes = 0;
	const token = options.token ?? randomUUID();
	const staging = path.join(draftsDir, `.staging-${token}`);
	const stagingRoot = path.join(staging, "root");
	const stagingBase = path.join(staging, "base.json");
	try {
		await fs.promises.mkdir(draftsDir, {
			recursive: true,
			mode: STAGED_ROOT_MODE,
		});
		await fs.promises.rm(staging, { recursive: true, force: true });
		await fs.promises.mkdir(stagingRoot, {
			recursive: true,
			mode: STAGED_ROOT_MODE,
		});
		const walk = async (
			fromDir: string,
			toDir: string,
			depth: number,
			readonlyCopy: boolean,
		): Promise<void> => {
			let children: fs.Dirent[];
			try {
				children = await fs.promises.readdir(fromDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const child of children.sort((a, b) => (a.name < b.name ? -1 : 1))) {
				const from = path.join(fromDir, child.name);
				const to = path.join(toDir, child.name);
				const relative = path
					.relative(options.configDir, from)
					.split(path.sep)
					.join("/");
				if (depth === 0 && SETUP_STAGED_DROPPED_NAMES.includes(child.name)) {
					excluded.push(`${relative}/`);
					continue;
				}
				const exposed =
					depth === 0 && SETUP_STAGED_READONLY_NAMES.includes(child.name);
				if (++count > maxEntries)
					throw new Error(
						`the configuration holds more than ${maxEntries} entries; the staged root refuses to copy it`,
					);
				if (child.isSymbolicLink()) {
					if (exposed || readonlyCopy) {
						// A credential entry is never a symlink (write-through): the
						// link's *target* is copied read-only, so the staged tree reads
						// exactly what the live tree reads and a write inside the staged
						// tree can never reach the live credential store.
						const target = await fs.promises.realpath(from);
						const size = (await fs.promises.stat(target)).size;
						bytes += size;
						if (bytes > maxBytes)
							throw new Error(
								`the configuration is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB; the staged root refuses to copy it`,
							);
						await copyFile(target, to);
						await fs.promises.chmod(to, STAGED_SECRET_MODE);
						entries[relative] = {
							kind: "file",
							digest: stagedFileDigest(to),
							liveDigest: stagedFileDigest(target),
						};
						continue;
					}
					// Preserved as an absolute symlink to the same resolved target,
					// so a deeper staged location cannot change what it points at and
					// the gate exercises production's symlink behaviour exactly.
					const target = path.resolve(
						path.dirname(from),
						await fs.promises.readlink(from),
					);
					await symlink(target, to);
					entries[relative] = { kind: "symlink", target };
					continue;
				}
				if (child.isDirectory()) {
					// An exposed directory (`providers/`) must not hold a symlink that
					// escapes into the live store, so it is copied as plain files.
					await fs.promises.mkdir(to, {
						recursive: true,
						mode: STAGED_ROOT_MODE,
					});
					entries[relative] = { kind: "dir" };
					if (depth + 1 <= STAGED_MAX_DEPTH)
						await walk(from, to, depth + 1, readonlyCopy || exposed);
					continue;
				}
				if (!child.isFile()) {
					excluded.push(relative);
					continue;
				}
				const stats = await fs.promises.stat(from);
				const size = stats.size;
				bytes += size;
				if (bytes > maxBytes)
					throw new Error(
						`the configuration is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB; the staged root refuses to copy it`,
					);
				// A file within the hash bound is read once: the bytes read are the
				// bytes written (a small file's digest is the whole content), so the
				// copy and both digests come from one read. A larger file keeps the
				// bounded head/tail digest, which is what the change set compares.
				const buffer =
					size <= STAGED_HASH_MAX_BYTES
						? await fs.promises.readFile(from)
						: undefined;
				// `liveDigest` is a claim about the live file: the bytes read above.
				const liveDigest = buffer ? digestOf(buffer) : stagedFileDigest(from);
				// The small-file path writes the buffer it already read, so the source
				// is read once; a larger file is copied by the runtime.
				if (buffer) await fs.promises.writeFile(to, buffer);
				else await copyFile(from, to);
				await fs.promises.chmod(
					to,
					readonlyCopy || exposed ? STAGED_SECRET_MODE : stats.mode & 0o777,
				);
				// The baseline is a *fact about the copy*: the change set asks "did the
				// author change what is in the staged root?", and a developer edit that
				// landed between the read and the write must not make the untouched copy
				// read as a draft. `liveDigest` keeps the other fact (what the live file
				// held) for the promotion's conflict check.
				entries[relative] = {
					kind: "file",
					digest: stagedFileDigest(to),
					liveDigest,
				};
			}
		};
		await walk(options.configDir, stagingRoot, 0, false);
		const body = { version: 1 as const, configDir: options.configDir, entries };
		const mac = options.secret
			? stagedBaseMac(options.secret, body)
			: undefined;
		await fs.promises.writeFile(
			stagingBase,
			`${JSON.stringify({ ...body, ...(mac ? { mac } : {}) }, null, 2)}\n`,
			{ mode: STAGED_BASE_MODE },
		);
		// The commit point. The tree is published first and the snapshot second: a
		// publication that loses the race abandons its own staging tree without
		// touching the winner's root or the winner's snapshot, and the reader-side
		// guard below (a root whose snapshot has not landed yet) waits for it
		// instead of deleting a tree another materialization just published.
		try {
			await fs.promises.rename(stagingRoot, root);
			publishedTree = true;
		} catch (error) {
			if (
				((error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
					(error as NodeJS.ErrnoException).code === "EEXIST") &&
				isDirectory(root)
			) {
				// Another (re-claimed) materialization won the race: adopt its state
				// as it is, and leave both halves alone.
				await fs.promises.rm(staging, { recursive: true, force: true });
				for (
					let attempt = 0;
					attempt < 20 && !fs.existsSync(basePath);
					attempt++
				)
					await waitFor(100);
				return {
					ok: true,
					staged: true,
					alreadyStaged: true,
					entries: count,
					bytes,
					excluded,
				};
			}
			throw error;
		}
		publishedBase = true;
		await fs.promises.rename(stagingBase, basePath);
		await fs.promises.rm(staging, { recursive: true, force: true });
	} catch (error) {
		// A half-written staging tree is never left behind. The published tree and
		// snapshot are removed only when *this* call published them: after a lost
		// race they belong to the attempt that won it, and deleting them would
		// destroy exactly what the adopt branch protects.
		await fs.promises.rm(staging, { recursive: true, force: true });
		if (publishedTree)
			await fs.promises.rm(root, { recursive: true, force: true });
		if (publishedBase) await fs.promises.rm(basePath, { force: true });
		return {
			...empty,
			entries: count,
			bytes,
			excluded,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		ok: true,
		staged: true,
		alreadyStaged: false,
		entries: count,
		bytes,
		excluded,
	};
}

/**
 * Remove one workflow's staged state: the staged root, its base snapshot and
 * its promoted sibling (the state directory moved aside after a promotion).
 * The promotion's `.backups/env-setup-<id>/` is deliberately kept: it is the
 * rollback evidence. Another workflow's state is never touched.
 */
export async function removeSetupStagedState(options: {
	readonly configDir: string;
	readonly workflowId: string;
}): Promise<string[]> {
	// This function removes trees named by a caller-supplied id, so the
	// containment check is part of it (defense in depth: today's only caller
	// passes the engine-pinned value).
	assertSetupDraftsDir(
		options.configDir,
		setupDraftsDir(options.configDir, options.workflowId),
	);
	const stateDir = setupDraftsDir(options.configDir, options.workflowId);
	const removed: string[] = [];
	for (const target of [
		stagedRootOf(stateDir),
		stagedBasePathOf(stateDir),
		// A staging directory a killed run left behind.
		...stagingDirectories(stateDir),
		setupPromotedDraftsDir(options.configDir, options.workflowId),
	]) {
		if (!fs.existsSync(target)) continue;
		await fs.promises.rm(target, { recursive: true, force: true });
		removed.push(target);
	}
	// The state directory itself goes when nothing but an empty shell of it is
	// left; anything else (a backup pointer a rollback still needs) stays.
	try {
		if (isDirectory(stateDir) && fs.readdirSync(stateDir).length === 0)
			fs.rmdirSync(stateDir);
	} catch {
		// A directory that is not empty is left alone.
	}
	return removed;
}

/** The private staging directories a killed materialization may have left. */
function stagingDirectories(stateDir: string): string[] {
	try {
		return fs
			.readdirSync(stateDir)
			.filter((name) => name.startsWith(".staging-"))
			.map((name) => path.join(stateDir, name));
	} catch {
		return [];
	}
}

/**
 * Sweep staged state whose workflow the store no longer knows about: a crash,
 * a deleted workflow or a `kill -9` leaves a full configuration copy behind.
 * Only directories that are recognisably this workflow's state are removed, and
 * only when the caller's store does not know the id.
 */
/**
 * The workflow ids that hold state under the shared root, sorted. A caller that
 * wants to sweep reads this first: building the "is it known?" answer costs one
 * store scan per configured target, and an empty candidate list makes that work
 * pointless.
 */
export function setupStagedStateIds(configDir: string): string[] {
	const root = setupDraftsRoot(configDir);
	try {
		return fs
			.readdirSync(root)
			.map((name) =>
				name.endsWith(".promoted") ? name.slice(0, -".promoted".length) : name,
			)
			.filter((id) => id !== "")
			.sort();
	} catch {
		return [];
	}
}

export async function sweepStaleSetupState(options: {
	readonly configDir: string;
	readonly isKnownWorkflow: (workflowId: string) => boolean;
}): Promise<{ removed: string[]; kept: string[] }> {
	const root = setupDraftsRoot(options.configDir);
	const removed: string[] = [];
	const kept: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(root).sort();
	} catch {
		return { removed, kept };
	}
	// Bounded work: a start sweeps a handful of stale roots and leaves the rest to
	// the next start, so a directory full of abandoned state cannot turn a start
	// into an unbounded recursive delete.
	let removals = 0;
	for (const name of names) {
		if (removals >= SWEEP_MAX_REMOVALS) {
			kept.push(path.join(root, name));
			continue;
		}
		const full = path.join(root, name);
		const promoted = name.endsWith(".promoted");
		const workflowId = promoted ? name.slice(0, -".promoted".length) : name;
		const ownsState = promoted
			? true
			: fs.existsSync(path.join(full, "base.json")) ||
				isDirectory(path.join(full, "root")) ||
				stagingDirectories(full).length > 0;
		if (!ownsState || workflowId === "") {
			kept.push(full);
			continue;
		}
		if (options.isKnownWorkflow(workflowId)) {
			kept.push(full);
			continue;
		}
		try {
			await fs.promises.rm(full, { recursive: true, force: true });
			removed.push(full);
			removals++;
		} catch {
			kept.push(full);
		}
	}
	return { removed, kept };
}

/** A bounded wait for a concurrent publisher to land its snapshot.
 * Materialization runs inside a durable effect whose own retry accounting is the
 * backstop, so a short poll is enough — and it is asynchronous, like the rest of
 * this module, so it never blocks the server's event loop. */
function waitFor(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The digest of bytes already in hand, matching the bounded digest's form. */
function digestOf(content: Buffer): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

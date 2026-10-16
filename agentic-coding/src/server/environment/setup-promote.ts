// The `env-setup` promotion (add-environment-setup-workflow): an atomic copy of
// the approved drafts into the live configuration, with a protected backup of
// every replaced file and a rollback if any write fails.
//
// The promotion is written to be *replayable*, because the durable effect that
// runs it can be re-claimed after its lease expires:
//
//   - a configuration-root-scoped lock, owned by a token and refreshed while the
//     promotion makes progress, serializes promotions;
//   - a backup is taken once per path for this run and never overwritten, and
//     the journal records the digest of what it holds, so a re-run cannot
//     replace the original content of a file an earlier attempt promoted;
//   - a journal (`promotion.json`) records the plan, each path's written digest
//     and its backup digest, plus the move intent, so a retry can tell
//     "already promoted" from "never started" and a rollback can prove the file
//     it removes is still the one it wrote;
//   - state read back from `.backups` is trusted only when this promotion wrote
//     it (the journal's own digests), because that directory is outside the
//     write guard's coverage and the approval gate's view;
//   - every filesystem operation is injectable, so the failure and replay paths
//     are testable with doubles.
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	assertSetupDraftsDir,
	draftSourceRoot,
	hasStagedRoot,
	isAllowedDraftPath,
	listSetupDraftEntries,
	liveConfigPath,
	readStagedBase,
	reviewedDigest,
	setupPromotedDraftsDir,
	stagedBasePathOf,
	stagedFileDigest,
} from "./setup-drafts.ts";

/** File mode of a replaced file when the live mode cannot be read (or the file
 * is new): the configuration's ordinary mode. */
const DEFAULT_FILE_MODE = 0o644;
/** Backups hold content that may be credential-bearing, so they are private. */
const BACKUP_FILE_MODE = 0o600;
const BACKUP_DIRECTORY_MODE = 0o700;
/** How long one promotion may go without progress before another one may steal
 * the lock a crashed run left behind. The lock is refreshed as the promotion
 * writes, so a live-but-slow promotion is never stolen from. */
const PROMOTION_LOCK_STALE_MS = 10 * 60 * 1000;
/** Filesystem errors that are worth another attempt rather than a step-loop
 * failure: the outbox owns their backoff. */
const TRANSIENT_ERROR_CODES = new Set(["EAGAIN", "EBUSY", "ETXTBSY"]);

/** The configuration-root lock one promotion holds while it writes. */
export function setupPromotionLockPath(configDir: string): string {
	return path.join(configDir, ".backups", "env-setup-promote.lock");
}

/** The promotion journal: the plan and the per-path outcome of one workflow's
 * promotion, so a replay can converge instead of guessing. */
export function setupPromotionJournalPath(backupDir: string): string {
	return path.join(backupDir, "promotion.json");
}

export interface SetupPromotionIo {
	readFile(filePath: string): string;
	writeFile(filePath: string, content: string, mode?: number): void;
	rename(from: string, to: string): void;
	remove(filePath: string): void;
	exists(filePath: string): boolean;
	mkdir(directory: string, mode?: number): void;
	/** Mode bits of an existing file, or `undefined` when unreadable. */
	mode(filePath: string): number | undefined;
	/** Create `filePath` exclusively (empty); false when it already exists. */
	acquireLock(filePath: string): boolean;
	/** Write `filePath` atomically (temporary sibling plus rename). */
	writeAtomic(filePath: string, payload: string, mode?: number): void;
	/** Move `from` over `to` atomically; false when `from` is gone. */
	renameOrClaim(from: string, to: string): boolean;
	/** Last modification time of `filePath`, in ms, or `undefined`. */
	mtimeMs(filePath: string): number | undefined;
	moveDirectory(from: string, to: string): void;
	removeDirectory(directory: string): void;
	/** Remove an empty directory; a non-empty one is left alone. */
	rmdir(directory: string): void;
	/** The literal target of a symlink, or `undefined` when the path is not one.
	 * A live definition that is a symlink points into the developer's own
	 * repository, so the promotion must replace the *link* rather than write
	 * through it, and a rollback must put the link back. */
	readLink(filePath: string): string | undefined;
	/** Create a symlink at `linkPath`. */
	symlink(target: string, linkPath: string): void;
}

export interface SetupPromotionOptions {
	readonly configDir: string;
	readonly draftsDir: string;
	readonly backupDir: string;
	readonly workflowId: string;
	/** The workflow's run identity (`metadata.createdAt`, pinned at start): a
	 * reused workflow id has its own, so it neither inherits nor conflicts with
	 * the earlier run's journal. */
	readonly runId?: string;
	/** The per-run secret the journal is authenticated with (pinned at start,
	 * engine-owned). Without it — or when it does not match — a journal this
	 * promotion did not write is ignored rather than adopted. It also
	 * authenticates the staged base snapshot. */
	readonly secret?: string;
	/** The reviewed digest of every drafted file, as `environment.validate`
	 * recorded them at the approval gate. A staged root is only promoted when
	 * every path still holds exactly the bytes the gate built, started and the
	 * developer approved: the window between the gate and the promotion is
	 * unbounded (the developer's approval can take hours) and the authoring agent
	 * holds `shell`/`edit` inside that very tree. */
	readonly reviewed?: Readonly<Record<string, string>>;
	/** Catalog reload; invoked once after the writes and once more when a
	 * rollback had to restore files, so the catalog is never left pointing at a
	 * configuration that is no longer on disk. */
	readonly reload?: () => void | Promise<void>;
	readonly io?: Partial<SetupPromotionIo>;
	readonly now?: () => number;
	readonly newToken?: () => string;
}

export interface SetupPromotionFile {
	readonly path: string;
	readonly status: "added" | "replaced";
	readonly sharedInfrastructure: boolean;
	readonly backupPath?: string;
	/** The live path was this symlink's target when the promotion replaced it
	 * with a regular file: the approval diff and the promotion report state it,
	 * and a rollback restores the link exactly. */
	readonly replacesSymlink?: string;
}

export interface SetupPromotionResult {
	readonly ok: boolean;
	readonly files: SetupPromotionFile[];
	/** Paths whose live content no longer matches the base snapshot the staged
	 * root was taken from: the developer changed them after the draft was
	 * authored, and nothing was written for them. */
	readonly conflicts?: string[];
	/** True when every path this promotion changed was restored from a backup
	 * that predates it (and the catalog was reloaded again). */
	readonly rolledBack: boolean;
	/** The drafts were moved aside: the workflow's overlay no longer shadows
	 * the files it published. */
	readonly draftsMoved: boolean;
	/** A replay of a promotion that already completed: nothing was done, and
	 * the live files are proven to be the ones it wrote. */
	readonly alreadyPromoted: boolean;
	/** The failure is a busy configuration root rather than a defective draft:
	 * the durable outbox retries it instead of the step's bounded loop. */
	readonly retryable: boolean;
	readonly error?: string;
}

interface SetupPromotionJournalEntry {
	readonly path: string;
	readonly status: "added" | "replaced";
	readonly backupPath?: string;
	/** Digest of the backup's content when it was taken. */
	readonly backupDigest?: string;
	/** Digest of the content this promotion wrote to the live path. */
	readonly writtenDigest?: string;
	/** Mode the live path had before this promotion replaced it, so a rollback
	 * restores exactly the previous file rather than the backup's private
	 * 0o600. */
	readonly mode?: number;
	/** The literal target of the symlink this promotion replaced, so a rollback
	 * restores the link itself instead of writing the developer's file back as
	 * a regular file. */
	readonly linkTarget?: string;
}

interface SetupPromotionJournal {
	/** Authentication tag over the rest of the document. */
	readonly mac?: string;
	readonly version: 1;
	readonly workflowId: string;
	readonly runId: string;
	readonly complete: boolean;
	/** The drafts move was decided and may be in flight. */
	readonly movePending: boolean;
	readonly entries: SetupPromotionJournalEntry[];
	/** Configuration-relative directories this promotion created, deepest
	 * first, so a rollback can leave the tree as it found it. */
	readonly directories: string[];
}

const defaultIo: SetupPromotionIo = {
	readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
	writeFile: (filePath, content, mode = DEFAULT_FILE_MODE) =>
		fs.writeFileSync(filePath, content, { mode }),
	rename: (from, to) => fs.renameSync(from, to),
	remove: (filePath) => fs.rmSync(filePath, { force: true }),
	exists: (filePath) => fs.existsSync(filePath),
	mkdir: (directory, mode = 0o755) =>
		fs.mkdirSync(directory, { recursive: true, mode }),
	mode: (filePath) => {
		try {
			return fs.statSync(filePath).mode & 0o777;
		} catch {
			return undefined;
		}
	},
	acquireLock: (filePath) => {
		try {
			// An empty exclusive create is the atomic part; the payload follows
			// through a temporary sibling, so a reader never sees a torn one.
			fs.writeFileSync(filePath, "", { flag: "wx", mode: 0o600 });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
	},
	writeAtomic: (filePath, payload, mode = 0o600) => {
		const temporary = `${filePath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, payload, { mode });
		fs.renameSync(temporary, filePath);
	},
	renameOrClaim: (from, to) => {
		try {
			fs.renameSync(from, to);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	},
	mtimeMs: (filePath) => {
		try {
			return fs.statSync(filePath).mtimeMs;
		} catch {
			return undefined;
		}
	},
	moveDirectory: (from, to) => fs.renameSync(from, to),
	removeDirectory: (directory) =>
		fs.rmSync(directory, { recursive: true, force: true }),
	rmdir: (directory) => {
		try {
			fs.rmdirSync(directory);
		} catch {
			// Not empty (or already gone): leaving it is correct.
		}
	},
	readLink: (filePath) => {
		try {
			return fs.readlinkSync(filePath);
		} catch {
			// A regular file (`EINVAL`) or a path that is gone: not a symlink.
			return undefined;
		}
	},
	symlink: (target, linkPath) => fs.symlinkSync(target, linkPath),
};

/**
 * Promote every drafted file into the live configuration. A failure — a write,
 * the reload — restores every path this promotion changed, re-syncs the
 * catalog, and reports whether that rollback was complete. A second promotion
 * into the same configuration root is refused while the first holds the lock;
 * that refusal is retryable.
 */
export async function promoteSetupDrafts(
	options: SetupPromotionOptions,
): Promise<SetupPromotionResult> {
	const io: SetupPromotionIo = { ...defaultIo, ...options.io };
	const now = options.now ?? (() => Date.now());
	const token = (options.newToken ?? (() => randomUUID()))();
	const release = () => ({
		ok: false as const,
		files: [],
		rolledBack: false,
		draftsMoved: false,
		alreadyPromoted: false,
	});
	assertSetupDraftsDir(options.configDir, options.draftsDir);
	const lockPath = setupPromotionLockPath(options.configDir);
	if (!acquirePromotionLock(io, lockPath, options.workflowId, token, now)) {
		return {
			...release(),
			retryable: true,
			error: `another env-setup promotion owns ${options.configDir}; retry when it finishes`,
		};
	}
	try {
		return await promote(options, io, token, now);
	} finally {
		releasePromotionLock(io, lockPath, token);
	}
}

async function promote(
	options: SetupPromotionOptions,
	io: SetupPromotionIo,
	token: string,
	now: () => number,
): Promise<SetupPromotionResult> {
	const runId = options.runId ?? "";
	const journalPath = setupPromotionJournalPath(options.backupDir);
	const refusedBeforeLock = (error: string, retryable = false) =>
		({
			ok: false,
			files: [],
			rolledBack: false,
			draftsMoved: false,
			alreadyPromoted: false,
			retryable,
			error,
		}) as SetupPromotionResult;
	// The promotion's plan is a file under `.backups`, which sits outside both
	// the write guard's coverage and the approval gate's view. It is therefore
	// never trusted on its own: an identity the agent cannot invent (the run
	// identity pinned at start) is required, and every recorded value is
	// re-proved against the filesystem before it is used.
	if (runId === "")
		return refusedBeforeLock(
			"the promotion needs the workflow's run identity; no plan can be trusted without it",
		);
	const previous = readJournal(io, journalPath, options.secret);
	const sameRun =
		previous !== undefined &&
		previous.workflowId === options.workflowId &&
		previous.runId === runId;
	// Entries an interrupted attempt of *this* run already recorded: the
	// promotion retries them, and a rollback has to cover them too. An earlier,
	// completed promotion of another run is never inherited.
	const entries = new Map<string, SetupPromotionJournalEntry>();
	if (sameRun && !previous.complete) {
		for (const entry of previous.entries) entries.set(entry.path, entry);
	}
	const refused = (error: string, retryable = false): SetupPromotionResult => ({
		ok: false,
		files: [],
		rolledBack: false,
		draftsMoved: false,
		alreadyPromoted: false,
		retryable,
		error,
	});

	// The mode is bound to the *authenticated snapshot*, not to the presence of a
	// writable directory. `hasStagedRoot` alone would let the authoring agent
	// delete `root/` and fall back to the legacy listing, where the base snapshot
	// and the conflict check do not apply; `base.json` surviving marks the run as
	// staged, and a run that deletes both has no drafts left to promote.
	const staged =
		hasStagedRoot(options.draftsDir) ||
		io.exists(stagedBasePathOf(options.draftsDir));
	const baseDigests = staged
		? readStagedBase(options.draftsDir, options.secret)
		: undefined;
	if (staged && !baseDigests)
		return refused(
			"the staged root's base snapshot is missing or not authenticated by this run; the promotion cannot tell what the developer changed and writes nothing",
		);

	const listed = listSetupDraftEntries(options.draftsDir, options.secret);
	const sourceRoot = draftSourceRoot(options.draftsDir);
	const nonRegular = listed.filter((entry) => entry.kind !== "file");
	if (nonRegular.length > 0)
		return refused(
			`drafts must be plain files: ${nonRegular
				.map((entry) => `${entry.relative} (${entry.kind})`)
				.join(", ")}`,
		);
	const drafts = listed.map((entry) => entry.relative);
	if (drafts.length === 0) {
		// A promotion that already finished is recognised by *proving* the live
		// files are the ones it wrote, never by the completion flag alone: the
		// journal is state under `.backups`, which is outside the approval gate's
		// view.
		// Recognised by proof, never by the flag alone: every entry the journal
		// records must still be what this promotion wrote, and the `complete`
		// marker trailing the move is repaired by the content check.
		if (
			sameRun &&
			previous.entries.length > 0 &&
			promotionIsLive(io, options, previous)
		)
			return {
				ok: true,
				files: [],
				rolledBack: false,
				draftsMoved: false,
				alreadyPromoted: true,
				retryable: false,
			};
		return refused(
			io.exists(options.draftsDir)
				? `the drafts directory ${options.draftsDir} holds no files`
				: `the drafts directory ${options.draftsDir} is missing`,
		);
	}
	const outsideLayout = drafts.filter(
		(relative) => !isAllowedDraftPath(relative),
	);
	if (outsideLayout.length > 0)
		return refused(
			`refusing drafts outside the configuration layout: ${outsideLayout.join(", ")}`,
		);

	// Conflict detection leads the writes: a path whose live content no longer
	// matches the base snapshot the staged copy was taken from was changed by the
	// developer in the meantime. The promotion refuses it *before writing
	// anything*, names every conflicting path, and has nothing to roll back. The
	// snapshot is authoritative in both directions: a drafted path that was not
	// live when the staged root was taken, and a live path the snapshot recorded
	// that has since disappeared, are conflicts too — never a silent replace.
	const conflicts = drafts.filter((relative) => {
		// A legacy state directory (no staged root) keeps today's behaviour: there
		// is no base snapshot to compare against.
		if (!staged || !baseDigests) return false;
		const livePath = liveConfigPath(options.configDir, relative);
		const baseDigest = baseDigests.get(relative);
		const liveExists = io.exists(livePath);
		const known = entries.get(relative);
		// A live file this run already wrote (an interrupted attempt) is not a
		// conflict: the journal recognises it and the attempt continues.
		const alreadyWritten =
			known !== undefined &&
			known.writtenDigest !== undefined &&
			liveExists &&
			contentDigest(io.readFile(livePath)) === known.writtenDigest;
		if (alreadyWritten) return false;
		if (!baseDigest) {
			// The staged root was taken from a configuration where this path did not
			// exist.
			return liveExists;
		}
		if (baseDigest.kind === "file") {
			if (!liveExists) return true;
			// The base records the *live* file's digest (the copy is byte-identical),
			// so the comparison is against the file itself.
			return stagedFileDigest(livePath) !== baseDigest.liveDigest;
		}
		// A symlink or directory the snapshot recorded: the live entry must still
		// be the same kind of thing.
		return liveExists !== true;
	});
	if (conflicts.length > 0)
		return {
			...refused(
				`refusing to overwrite live files the developer changed after the drafts were authored: ${conflicts.join(", ")}`,
			),
			conflicts,
		};

	// The reviewed bytes are the authored bytes. `environment.validate` recorded
	// the digest of every drafted file the developer then approved; a path whose
	// staged content no longer matches that record (or one the review never saw)
	// is refused before anything is written, so the approval gate authorises the
	// bytes that become live and not merely a path list.
	// The reviewed binding does not depend on the mode: it applies whenever the
	// caller carries a review (the validation effect always does now, in every
	// mode — `setup-validate.ts` records the digest of the content it read). A
	// caller that carries none (the promotion module's own tests, a pre-change
	// snapshot) keeps the pre-existing behaviour, but the *production* path is
	// always bound, so deleting `root/` to fall back to the legacy listing cannot
	// switch the binding off.
	if (!options.reviewed && staged)
		return refused(
			"the staged root was not reviewed by the validation gate, so there is nothing the developer approved; no promotion is performed",
		);
	if (options.reviewed) {
		const reviewed = options.reviewed;
		const unreviewed = drafts.filter((relative) => {
			const expected = reviewed[relative];
			if (expected === undefined) return true;
			const file = path.join(sourceRoot, ...relative.split("/"));
			try {
				return reviewedDigest(io.readFile(file)) !== expected;
			} catch {
				return true;
			}
		});
		for (const relative of Object.keys(reviewed))
			if (!drafts.includes(relative)) unreviewed.push(relative);
		if (unreviewed.length > 0)
			return {
				...refused(
					`refusing to promote drafts whose content differs from the reviewed content (${[...new Set(unreviewed)].sort().join(", ")}); write them again and let the gate validate them`,
				),
				conflicts: [...new Set(unreviewed)].sort(),
			};
	}

	const files: SetupPromotionFile[] = [];
	const createdDirectories = new Set<string>(
		sameRun && !previous.complete ? previous.directories : [],
	);
	writeJournal(io, journalPath, options, runId, entries, {
		complete: false,
		movePending: false,
		directories: createdDirectories,
	});
	try {
		for (const relative of drafts) {
			const draftPath = path.join(sourceRoot, ...relative.split("/"));
			const livePath = liveConfigPath(options.configDir, relative);
			const draftText = io.readFile(draftPath);
			// The bytes that become live are the bytes that were checked: this is the
			// digest of the very string the write below publishes, compared with the
			// content the gate read, so no re-read window is left at all.
			const expectedReview = options.reviewed?.[relative];
			if (
				expectedReview !== undefined &&
				contentDigest(draftText) !== expectedReview
			)
				throw new ReviewChangedFailure(relative);
			const liveExists = io.exists(livePath);
			// A live definition that is a symlink points at the developer's own
			// file (the motivating configuration symlinks its compose files into a
			// separate repository). It is read *through* the link — that content is
			// what an untouched link shows — but never written through it: the
			// write below is a temporary sibling plus an atomic rename, which
			// replaces the link with a regular file, and a rollback puts the link
			// itself back from `linkTarget`.
			const liveLinkTarget = liveExists ? io.readLink(livePath) : undefined;
			let liveText: string | undefined;
			if (liveExists) {
				try {
					liveText = io.readFile(livePath);
				} catch (error) {
					// A symlink whose target is gone reads no content; the link is what
					// this promotion replaces, and `linkTarget` is what restores it.
					if (liveLinkTarget === undefined) throw error;
				}
			}
			const digest = contentDigest(draftText);
			const known = entries.get(relative);
			const backupPath = path.join(options.backupDir, ...relative.split("/"));
			// A recorded entry is only as good as the proof behind it: the live file
			// must still hold what this run wrote, otherwise the record describes a
			// state that no longer exists and the run starts from the filesystem
			// again (a re-classification, and a fresh backup of what is really
			// there). Nothing an agent can write into `.backups` is trusted as a
			// provenance statement on its own.
			const recorded =
				known !== undefined &&
				known.writtenDigest !== undefined &&
				liveText !== undefined &&
				contentDigest(liveText) === known.writtenDigest;
			const inherited = recorded ? known : undefined;
			// The link this path held before this run's first write (a replay finds a
			// regular file and keeps the recorded target).
			const linkTarget = liveLinkTarget ?? inherited?.linkTarget;
			const status: "added" | "replaced" = inherited
				? inherited.status
				: liveExists
					? "replaced"
					: "added";
			let backup: { backupPath: string; backupDigest: string } | undefined;
			if (
				inherited?.backupPath &&
				inherited.backupDigest &&
				io.exists(inherited.backupPath) &&
				contentDigest(io.readFile(inherited.backupPath)) ===
					inherited.backupDigest
			)
				backup = {
					backupPath: inherited.backupPath,
					backupDigest: inherited.backupDigest,
				};
			// A fresh backup is only for a path this run has not recorded yet: an
			// inherited entry's live content is this promotion's own earlier write,
			// not a pre-promotion original, so "backing it up" would make the
			// rollback restore the draft.
			let backupMode: number | undefined;
			if (!backup && liveExists && inherited === undefined) {
				// A file that merely sits at the canonical backup path was not written
				// by this promotion (the directory is outside the write guard's
				// coverage), so a foreign file gets a per-attempt name instead of
				// being trusted or overwritten.
				const target = io.exists(backupPath)
					? `${backupPath}.${token}.bak`
					: backupPath;
				io.mkdir(path.dirname(target), BACKUP_DIRECTORY_MODE);
				// A link with no target has no content to keep; the rollback restores
				// its `linkTarget` rather than this private copy.
				const content = liveText ?? "";
				io.writeFile(target, content, BACKUP_FILE_MODE);
				// The backup itself stays private (0600); the mode the live path had
				// before is journaled beside it, because a rollback must restore exactly
				// the previous file — content and permissions.
				backupMode = io.mode(livePath) ?? DEFAULT_FILE_MODE;
				backup = {
					backupPath: target,
					backupDigest: contentDigest(content),
				};
			}
			// Already promoted by an earlier attempt (or identical content): the
			// plan records it, the live file is left alone.
			const alreadySame = liveText !== undefined && liveText === draftText;
			// The plan leads the write: the entry (and the backup it names) is on
			// disk before the live file is published, so a kill in between leaves a
			// record a re-attempt can trust, never a published path with no entry.
			entries.set(relative, {
				path: relative,
				status,
				...(backup ? backup : {}),
				// A replay must not lose the mode an earlier attempt recorded: this
				// entry is rebuilt from scratch every attempt, and `backupMode` is
				// only set on the attempt that took the fresh backup.
				...(backupMode !== undefined
					? { mode: backupMode }
					: inherited?.mode !== undefined
						? { mode: inherited.mode }
						: {}),
				...(linkTarget !== undefined ? { linkTarget } : {}),
				writtenDigest: digest,
			});
			files.push({
				path: relative,
				status,
				sharedInfrastructure:
					status === "replaced" && relative.startsWith("infrastructure/"),
				...(backup ? { backupPath: backup.backupPath } : {}),
				...(linkTarget !== undefined ? { replacesSymlink: linkTarget } : {}),
			});
			writeJournal(io, journalPath, options, runId, entries, {
				complete: false,
				movePending: false,
				directories: createdDirectories,
			});
			// Progress: the lock's stamp moves with the plan, so a live promotion is
			// never stolen from; losing it stops the writes instead of racing the
			// promotion that took the root.
			if (
				!refreshPromotionLock(
					io,
					setupPromotionLockPath(options.configDir),
					options.workflowId,
					token,
					now,
				)
			)
				throw new LockLostFailure();
			if (!alreadySame) {
				const mode = liveExists
					? (io.mode(livePath) ?? DEFAULT_FILE_MODE)
					: DEFAULT_FILE_MODE;
				recordCreatedDirectories(
					io,
					options,
					createdDirectories,
					path.dirname(livePath),
				);
				const temporary = `${livePath}.${token}.tmp`;
				io.writeFile(temporary, draftText, mode);
				io.rename(temporary, livePath);
			}
		}
		// The reload is the one long step: the stamp is refreshed on both sides of
		// it and the wait itself is bounded, so a stalled authority cannot hold
		// the root until another promotion steals it.
		if (
			!refreshPromotionLock(
				io,
				setupPromotionLockPath(options.configDir),
				options.workflowId,
				token,
				now,
			)
		)
			throw new LockLostFailure();
		await reloadWithinBound(options);
		if (
			!refreshPromotionLock(
				io,
				setupPromotionLockPath(options.configDir),
				options.workflowId,
				token,
				now,
			)
		)
			throw new LockLostFailure();
	} catch (error) {
		if (error instanceof ReviewChangedFailure) {
			// The loop may already have published earlier paths: this refusal has the
			// same duty as any other failure, so the attempt is rolled back before it
			// reports (an unreviewed draft must not stay half-promoted).
			const rolledBack = await rollback(
				options,
				io,
				entries,
				createdDirectories,
			);
			return {
				ok: false,
				files,
				rolledBack,
				draftsMoved: false,
				alreadyPromoted: false,
				retryable: false,
				error: `${message(error)}${rolledBack ? "" : " (rollback incomplete)"}`,
				conflicts: [...files.map((file) => file.path)].sort(),
			};
		}
		// The lost-lock path must not touch the live configuration: the promotion
		// that stole the lock owns the root now, and its own rollback (or its
		// completed promotion) is the corrective action. Writing here would race it
		// and could put stale bytes over a finished promotion.
		if (error instanceof LockLostFailure)
			return {
				ok: false,
				files,
				rolledBack: false,
				draftsMoved: false,
				alreadyPromoted: false,
				retryable: true,
				error: `${message(error)}; the live configuration was left to the promotion that owns the root`,
			};
		const rolledBack = await rollback(options, io, entries, createdDirectories);
		return {
			ok: false,
			files,
			rolledBack,
			draftsMoved: false,
			alreadyPromoted: false,
			retryable: isTransient(error),
			error: `${message(error)}${rolledBack ? "" : " (rollback incomplete)"}`,
		};
	}

	// The live configuration now owns these definitions: moving the drafts aside
	// stops the workflow's own overlay from shadowing what it just promoted.
	// The intent is journaled *before* the move, so a crash inside it leaves a
	// promotion that is recognisably applied rather than one that looks unstarted.
	writeJournal(io, journalPath, options, runId, entries, {
		complete: false,
		movePending: true,
		directories: createdDirectories,
	});
	let draftsMoved = false;
	try {
		io.mkdir(path.dirname(options.backupDir));
		const promoted = setupPromotedDraftsDir(
			options.configDir,
			options.workflowId,
		);
		io.mkdir(path.dirname(promoted));
		if (io.exists(promoted)) io.removeDirectory(promoted);
		io.moveDirectory(options.draftsDir, promoted);
		draftsMoved = true;
	} catch {
		// A drafts directory that could not be moved is not a failed promotion:
		// the live configuration is complete and the backup keeps the originals.
	}
	// Complete only when the move happened as well: a promotion whose drafts are
	// still in place is replayed from its own journal instead of being declared
	// finished, and a crash inside the move is repaired by the content proof
	// above rather than by this flag.
	writeJournal(io, journalPath, options, runId, entries, {
		complete: draftsMoved,
		movePending: !draftsMoved,
		directories: createdDirectories,
	});
	return {
		ok: true,
		files,
		rolledBack: false,
		draftsMoved,
		alreadyPromoted: false,
		retryable: false,
	};
}

/**
 * Restore every path this promotion changed — including the paths an earlier,
 * interrupted attempt of the same run already wrote — from this run's own
 * backups. A path another actor has changed since is left alone and the
 * rollback is reported incomplete rather than claiming a restoration it did not
 * perform.
 */
async function rollback(
	options: SetupPromotionOptions,
	io: SetupPromotionIo,
	entries: ReadonlyMap<string, SetupPromotionJournalEntry>,
	createdDirectories: ReadonlySet<string> = new Set(),
): Promise<boolean> {
	let complete = true;
	const ordered = [...entries.values()]
		.filter((entry) => entry.writtenDigest !== undefined)
		.sort((a, b) => (a.path < b.path ? -1 : 1))
		.reverse();
	for (const entry of ordered) {
		const livePath = liveConfigPath(options.configDir, entry.path);
		try {
			const present = io.exists(livePath);
			const liveDigest =
				present && entry.writtenDigest !== undefined
					? contentDigest(io.readFile(livePath))
					: undefined;
			if (
				present &&
				entry.writtenDigest !== undefined &&
				liveDigest !== entry.writtenDigest
			) {
				// The file is not what this promotion wrote. For a replaced path that
				// still holds the original there is simply nothing to undo (its write
				// never landed); anything else was changed by another actor and is not
				// ours to touch — and that is reported as an incomplete rollback.
				const untouchedOriginal =
					entry.backupDigest !== undefined && liveDigest === entry.backupDigest;
				if (!untouchedOriginal) complete = false;
				continue;
			}
			if (entry.backupPath && io.exists(entry.backupPath)) {
				if (entry.linkTarget !== undefined) {
					// The path this promotion replaced was a symlink into the developer's
					// own file. Restoring the backup's *content* would leave a regular file
					// holding the target's bytes — a change to the configuration the
					// developer never made — so the link itself goes back, replaced
					// atomically like every other write here.
					const temporary = `${livePath}.rollback-link`;
					io.remove(temporary);
					io.symlink(entry.linkTarget, temporary);
					io.rename(temporary, livePath);
					continue;
				}
				const content = io.readFile(entry.backupPath);
				if (
					entry.backupDigest !== undefined &&
					contentDigest(content) !== entry.backupDigest
				) {
					complete = false;
					continue;
				}
				const mode =
					entry.mode ?? io.mode(entry.backupPath) ?? DEFAULT_FILE_MODE;
				const temporary = `${livePath}.rollback`;
				io.writeFile(temporary, content, mode);
				io.rename(temporary, livePath);
				continue;
			}
			if (entry.status === "added") {
				if (present) io.remove(livePath);
				continue;
			}
			// A replaced file with no usable backup cannot be restored.
			if (present) complete = false;
		} catch {
			complete = false;
		}
	}
	// Directories this promotion created are removed again (deepest first, and
	// only while empty), so the configuration tree is what it was: an empty
	// `apps/run/` left behind is part of the live configuration the fingerprint
	// and the next round both see.
	for (const directory of [...createdDirectories].sort(
		(a, b) => b.length - a.length,
	))
		io.rmdir(liveConfigPath(options.configDir, directory));
	// The catalog was reloaded mid-promotion at most once; a restored
	// configuration needs it again, and a reload that fails leaves the rollback
	// reported as incomplete instead of silently partially applied.
	try {
		await reloadWithinBound(options);
	} catch {
		complete = false;
	}
	return complete;
}

/** Record every ancestor of `directory` that this promotion had to create. */
function recordCreatedDirectories(
	io: SetupPromotionIo,
	options: SetupPromotionOptions,
	created: Set<string>,
	directory: string,
): void {
	const root = path.resolve(options.configDir);
	const target = path.resolve(directory);
	const ancestors: string[] = [];
	let current = target;
	while (current !== root && current.startsWith(`${root}${path.sep}`)) {
		ancestors.push(current);
		current = path.dirname(current);
	}
	for (const ancestor of ancestors.reverse()) {
		if (io.exists(ancestor)) continue;
		io.mkdir(ancestor);
		created.add(path.relative(root, ancestor).split(path.sep).join("/"));
	}
}

/** The promotion's own write: a lost lock aborts instead of racing the winner. */
class ReviewChangedFailure extends Error {
	constructor(relative: string) {
		super(
			`the staged content of ${relative} changed after the developer's review; the promotion wrote nothing for it`,
		);
		this.name = "ReviewChangedFailure";
	}
}

class LockLostFailure extends Error {
	constructor() {
		super(
			"another promotion took the configuration root while this one was writing",
		);
		this.name = "LockLostFailure";
	}
}

/** How long the catalog reload may take before the promotion treats it as a
 * failure: the root is held for the duration, so the wait is bounded. */
const RELOAD_TIMEOUT_MS = 60_000;

async function reloadWithinBound(
	options: SetupPromotionOptions,
): Promise<void> {
	if (!options.reload) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve(options.reload()),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("the catalog reload did not answer in time")),
					RELOAD_TIMEOUT_MS,
				);
				(timer as { unref?: () => void }).unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Whether the live files still hold exactly what a completed promotion wrote. */
function promotionIsLive(
	io: SetupPromotionIo,
	options: SetupPromotionOptions,
	journal: SetupPromotionJournal,
): boolean {
	if (journal.entries.length === 0) return false;
	for (const entry of journal.entries) {
		if (!entry.writtenDigest) return false;
		const livePath = liveConfigPath(options.configDir, entry.path);
		if (!io.exists(livePath)) return false;
		try {
			if (contentDigest(io.readFile(livePath)) !== entry.writtenDigest)
				return false;
		} catch {
			return false;
		}
	}
	return true;
}

function writeJournal(
	io: SetupPromotionIo,
	journalPath: string,
	options: SetupPromotionOptions,
	runId: string,
	entries: ReadonlyMap<string, SetupPromotionJournalEntry>,
	state: {
		complete: boolean;
		movePending: boolean;
		directories?: ReadonlySet<string>;
	},
): void {
	const body = journalBody(options, runId, state, entries);
	const journal: SetupPromotionJournal = {
		...body,
		mac: journalMac(options.secret, body),
	};
	io.mkdir(path.dirname(journalPath), BACKUP_DIRECTORY_MODE);
	io.writeAtomic(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

/** The authenticated body of the journal: everything but its own tag. */
function journalBody(
	options: SetupPromotionOptions,
	runId: string,
	state: {
		complete: boolean;
		movePending: boolean;
		directories?: ReadonlySet<string>;
	},
	entries: ReadonlyMap<string, SetupPromotionJournalEntry>,
): Omit<SetupPromotionJournal, "mac"> {
	return {
		version: 1,
		workflowId: options.workflowId,
		runId,
		complete: state.complete,
		movePending: state.movePending,
		entries: [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)),
		directories: [...(state.directories ?? [])].sort(
			(a, b) => b.length - a.length,
		),
	};
}

/**
 * The journal's authentication tag. The secret is pinned in the workflow's own
 * snapshot, so a plan written by hand under `.backups` — a directory outside the
 * write guard's coverage and the approval gate's view — cannot be made to look
 * like this run's own.
 */
function journalMac(secret: string | undefined, body: unknown): string {
	// Canonical (key-sorted) serialization: the tag must not depend on the key
	// order a JSON parse happens to produce on the read side.
	return createHmac("sha256", secret ?? "")
		.update(canonicalJson(body))
		.digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

function readJournal(
	io: SetupPromotionIo,
	journalPath: string,
	secret: string | undefined,
): SetupPromotionJournal | undefined {
	if (!io.exists(journalPath)) return undefined;
	try {
		const parsed = JSON.parse(
			io.readFile(journalPath),
		) as Partial<SetupPromotionJournal>;
		if (parsed.version !== 1 || !Array.isArray(parsed.entries))
			return undefined;
		if (typeof parsed.mac !== "string") return undefined;
		const body: Omit<SetupPromotionJournal, "mac"> = {
			version: 1,
			workflowId: String(parsed.workflowId ?? ""),
			runId: String(parsed.runId ?? ""),
			complete: parsed.complete === true,
			movePending: parsed.movePending === true,
			entries: parsed.entries
				.filter(
					(entry): entry is SetupPromotionJournalEntry =>
						typeof entry === "object" &&
						entry !== null &&
						typeof (entry as { path?: unknown }).path === "string",
				)
				// `linkTarget` is state the promotion recorded to be able to restore a
				// replaced symlink; an unauthenticated or foreign journal never reaches
				// here (the tag above refuses it), so a string is taken as recorded.
				.map((entry) =>
					typeof entry.linkTarget === "string"
						? { ...entry, linkTarget: entry.linkTarget }
						: entry,
				),
			directories: Array.isArray(parsed.directories)
				? parsed.directories.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: [],
		};
		// An unauthenticated or tampered journal is not this workflow's state: it
		// is ignored, and the promotion re-derives its plan from the filesystem.
		if (parsed.mac !== journalMac(secret, body)) return undefined;
		return body;
	} catch {
		return undefined;
	}
}

function lockPayload(workflowId: string, token: string, at: number): string {
	return `${JSON.stringify({ workflowId, token, at })}\n`;
}

/**
 * One promotion owns a configuration root at a time. Acquisition is an
 * exclusive *create* followed by an atomic payload write, staleness is judged
 * from the lock's mtime (which the holder's atomic refresh moves), an
 * unreadable payload counts as held rather than stale, and a stale lock is
 * taken by an atomic rename that exactly one stealer can win.
 */
function acquirePromotionLock(
	io: SetupPromotionIo,
	lockPath: string,
	workflowId: string,
	token: string,
	now: () => number,
): boolean {
	io.mkdir(path.dirname(lockPath));
	const payload = lockPayload(workflowId, token, now());
	if (io.acquireLock(lockPath)) {
		io.writeAtomic(lockPath, payload);
		return true;
	}
	// Held: only a lock whose own mtime is demonstrably older than the bound is
	// taken, and the take is one atomic rename — the loser gets false and waits,
	// never a half-removed lock.
	const modified = io.mtimeMs(lockPath);
	if (modified !== undefined && now() - modified < PROMOTION_LOCK_STALE_MS)
		return false;
	if (!io.renameOrClaim(lockPath, `${lockPath}.stolen.${token}`)) return false;
	if (io.acquireLock(lockPath)) {
		io.writeAtomic(lockPath, payload);
		return true;
	}
	return false;
}

/**
 * Refresh the lock this promotion owns, so a slow-but-live run is not stolen
 * from. False means the lock is no longer ours: the caller must stop writing.
 */
function refreshPromotionLock(
	io: SetupPromotionIo,
	lockPath: string,
	workflowId: string,
	token: string,
	now: () => number,
): boolean {
	const held = readLock(io, lockPath);
	// No payload at all is not proof of anything: the file exists, so it is
	// someone's lock (or a torn write of ours) and neither is ours to move.
	if (!held || held.token !== token) return false;
	io.writeAtomic(lockPath, lockPayload(workflowId, token, now()));
	return true;
}

/**
 * Release only the lock this promotion took: a stolen lock belongs to the
 * promotion that took it, and an unreadable payload is not proof that the lock
 * is ours.
 */
function releasePromotionLock(
	io: SetupPromotionIo,
	lockPath: string,
	token: string,
): void {
	const held = readLock(io, lockPath);
	if (!held || held.token !== token) return;
	io.remove(lockPath);
}

function readLock(
	io: SetupPromotionIo,
	lockPath: string,
): { token: string; at: number } | undefined {
	try {
		const parsed = JSON.parse(io.readFile(lockPath)) as {
			token?: unknown;
			at?: unknown;
		};
		return {
			token: typeof parsed.token === "string" ? parsed.token : "",
			at: typeof parsed.at === "number" ? parsed.at : 0,
		};
	} catch {
		return undefined;
	}
}

function isTransient(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && TRANSIENT_ERROR_CODES.has(code);
}

function contentDigest(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Restore the live configuration from this run's own promotion journal, and put
 * the staged root back where the author left it (it was moved aside by the
 * promotion). Driven by the *authenticated* journal only: a rollback acts on
 * exactly the paths the promotion of this run wrote and proved the backup of,
 * never on a plan an agent could have written under `.backups`.
 *
 * A rollback that cannot prove a restoration reports it, rather than claiming
 * one it did not perform.
 */
export async function rollbackPromotion(
	options: SetupPromotionOptions,
): Promise<{
	readonly ok: boolean;
	readonly restored: string[];
	readonly removed: string[];
	readonly stagedRestored: boolean;
	readonly error?: string;
}> {
	const io: SetupPromotionIo = { ...defaultIo, ...options.io };
	assertSetupDraftsDir(options.configDir, options.draftsDir);
	const runId = options.runId ?? "";
	const journal = readJournal(
		io,
		setupPromotionJournalPath(options.backupDir),
		options.secret,
	);
	if (
		!journal ||
		runId === "" ||
		journal.workflowId !== options.workflowId ||
		journal.runId !== runId
	)
		return {
			ok: false,
			restored: [],
			removed: [],
			stagedRestored: false,
			error:
				"no authenticated promotion journal of this run exists; there is nothing to roll back",
		};
	const entries = new Map<string, SetupPromotionJournalEntry>();
	for (const entry of journal.entries) entries.set(entry.path, entry);
	const restored = [...entries.values()]
		.filter((entry) => entry.backupPath !== undefined)
		.map((entry) => entry.path);
	const removed = [...entries.values()]
		.filter((entry) => entry.status === "added")
		.map((entry) => entry.path);
	const complete = await rollback(
		options,
		io,
		entries,
		new Set(journal.directories),
	);
	// Put the staged root back: the author resumes in it after a rolled-back
	// promotion, so the drafts must be where they left them.
	let stagedRestored = false;
	const promoted = setupPromotedDraftsDir(
		options.configDir,
		options.workflowId,
	);
	try {
		if (io.exists(promoted) && !io.exists(options.draftsDir)) {
			io.moveDirectory(promoted, options.draftsDir);
			stagedRestored = true;
		}
	} catch {
		stagedRestored = false;
	}
	// The journal described a promotion that is no longer live; leaving it would
	// let a later attempt adopt a plan whose files it just restored.
	try {
		io.remove(setupPromotionJournalPath(options.backupDir));
	} catch {
		// A journal that cannot be removed is not a failed rollback: the
		// promotion re-proves every recorded value against the filesystem anyway.
	}
	return {
		ok: complete,
		restored,
		removed,
		stagedRestored,
		...(complete
			? {}
			: { error: "some paths could not be proven restored (see the journal)" }),
	};
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

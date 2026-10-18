// Worktrunk-backed worktree port (introduce-worktree-port, task 1.3).
//
// The port's single implementation. Worktree mechanics live here: create-or-
// reuse as one decision, primary-worktree protection, branch preservation on
// removal, and stale-entry reclamation. Worktrunk is reached only through
// `./cli.ts`, and every invocation disables hooks, directory changes and
// prompts, so nothing a repository configures can run because an environment
// action or a workflow asked for a worktree.
import fs from "node:fs";
import path from "node:path";
import { Effect, Either } from "effect";
import { HERDR_WORKFLOW_DIRECTORY } from "../workflow/observability.ts";
import {
	classifyWorktreeFailure,
	decodeGitWorktreeList,
	decodeWorktrunkList,
	decodeWorktrunkSwitch,
	errorText,
	type GitWorktreeEntry,
	MIN_WORKTRUNK_VERSION,
	meetsMinimumVersion,
	parseWorktrunkVersion,
	realpathOrSelf,
	refFromSwitch,
	runWorktreeCommand,
	type WorktreeCommandRunner,
	WT_AUTOMATION_FLAGS,
	worktrunkArgv,
	worktrunkBin,
} from "./cli.ts";
import {
	type WorktreeEnsureInput,
	WorktreeError,
	type WorktreePort,
	type WorktreeRef,
	type WorktreeRemoveInput,
} from "./port.ts";
import {
	linkedWorktreePath,
	worktreePathConfig,
	worktreePathConstant,
} from "./template.ts";

export interface WorktreeAdapterOptions {
	/** Overrides `WORKTRUNK_BIN_PATH`. */
	binPath?: string;
	/** Test seam: replaces the subprocess while keeping the argv the adapter
	 * would have run. */
	runner?: WorktreeCommandRunner;
}

export class WorktreeAdapter implements WorktreePort {
	private readonly binPath?: string;
	private readonly runner: WorktreeCommandRunner;
	/** Set only when a test seam replaces the subprocess, which makes the
	 * executable lookup inapplicable. */
	private readonly testRunner: WorktreeCommandRunner | undefined;
	private availability?: Effect.Effect<void, WorktreeError>;

	constructor(options: WorktreeAdapterOptions = {}) {
		this.binPath = options.binPath;
		this.testRunner = options.runner;
		this.runner = options.runner ?? ((argv) => runWorktreeCommand([...argv]));
	}

	/** The one place every port method enters: the first operation validates the
	 * executable, so an application that never touches a worktree does not need
	 * worktrunk installed while one that does fails with a named prerequisite
	 * instead of a spawn trace. */
	private ensureAvailable(): Effect.Effect<void, WorktreeError> {
		this.availability ??= validateWorktrunk({
			...(this.binPath ? { binPath: this.binPath } : {}),
			...(this.testRunner ? { runner: this.testRunner } : {}),
		});
		return this.availability;
	}

	/** Run one bounded command and decode its reply, classifying both the
	 * subprocess failure and reply-shape drift. */
	private command<A>(
		argv: readonly string[],
		decode: (stdout: string) => A,
	): Effect.Effect<A, WorktreeError> {
		return this.runner(argv).pipe(
			Effect.flatMap((stdout) =>
				Effect.try({
					try: () => decode(stdout),
					catch: (error) =>
						error instanceof WorktreeError
							? error
							: new WorktreeError("invalid-response", errorText(error), {
									cause: error,
								}),
				}),
			),
		);
	}

	private run(argv: readonly string[]): Effect.Effect<string, WorktreeError> {
		return this.runner(argv);
	}

	/** The `worktree-path` value this call creates with: one exact path when the
	 * caller named one, else the caller's layout template, else worktrunk's own
	 * configured location. */
	private pathConfig(i: WorktreeEnsureInput): string | undefined {
		if (i.path) return worktreePathConstant(i.path);
		return i.location
			? worktreePathConfig(i.location.root, i.location.ident)
			: undefined;
	}

	/** `wt -C <repo> list --format json`, normalized to port references. */
	list(repo: string): Effect.Effect<readonly WorktreeRef[], WorktreeError> {
		return Effect.gen(this, function* () {
			yield* this.ensureAvailable();
			return yield* this.command(
				worktrunkArgv(repo, ["list", "--format", "json"], {
					...(this.binPath ? { binPath: this.binPath } : {}),
				}),
				(raw) =>
					decodeWorktrunkList(raw).map((row) => ({
						path: row.path,
						branch: row.branch,
						isMain: row.isMain,
						detached: row.detached,
						...(row.prunable ? { prunable: row.prunable } : {}),
						created: false,
					})),
			);
		});
	}

	find(
		repo: string,
		branch: string,
	): Effect.Effect<WorktreeRef | undefined, WorktreeError> {
		return this.list(repo).pipe(
			Effect.map((refs) => refs.find((ref) => ref.branch === branch)),
		);
	}

	ensure(i: WorktreeEnsureInput): Effect.Effect<WorktreeRef, WorktreeError> {
		if (i.detached) return this.ensureDetached(i);
		return Effect.gen(this, function* () {
			yield* this.ensureAvailable();
			// A base means the branch may not exist yet; a branch worktrunk
			// already has wins over creating it, so a retried ensure reuses the
			// worktree the previous attempt created instead of failing.
			if (i.base) {
				const created = yield* this.switchWorktree(i, i.base);
				if (created) return created;
			}
			const reused = yield* this.switchWorktree(i);
			if (!reused)
				return yield* Effect.fail(
					new WorktreeError(
						"invalid-response",
						`worktrunk reported no worktree for ${i.branch}`,
					),
				);
			return reused;
		});
	}

	/** The concrete directory a detached `ensure` targets: the caller's exact
	 * path, or the layout template resolved for the named branch. */
	private detachedPath(i: WorktreeEnsureInput): string {
		if (i.path) return i.path;
		if (!i.location)
			throw new WorktreeError(
				"conflict",
				"a detached worktree needs an explicit path or location",
			);
		return linkedWorktreePath(i.location.root, i.location.ident, i.branch);
	}

	/**
	 * Create a **detached** worktree at `branch`'s head (validate-worktree-
	 * detached). worktrunk cannot create one, so this goes through git directly;
	 * the branch itself is never checked out, created, or switched. The lookup
	 * first makes a retried ensure reuse the worktree the previous attempt
	 * created. A create that loses a race to a sibling attempt is treated as
	 * reuse too: the worktree is re-listed (after a best-effort prune) and
	 * returned when it now exists, so only a target that is genuinely still
	 * absent fails. A detached worktree is addressed by path, never by branch.
	 *
	 * A branch is selected by name, and a workflow on the same branch runs
	 * sequentially, so a second workflow finds whatever the first left at the
	 * target path. Two leftovers are real and are handled here rather than by
	 * failing the setup: git's own registration of a worktree whose directory is
	 * gone (pruned first, or `git worktree add` refuses it as "missing but
	 * already registered"), and a directory holding nothing but this engine's own
	 * `.herdr-workflow` data — the bug this guard exists for: the first
	 * workflow's telemetry writer recreated its removed worktree, and the next
	 * workflow on that branch then failed with `fatal: '<path>' already exists`.
	 * Anything else at that path is the developer's content and is refused by
	 * name, never deleted.
	 */
	private ensureDetached(
		i: WorktreeEnsureInput,
	): Effect.Effect<WorktreeRef, WorktreeError> {
		return Effect.gen(this, function* () {
			yield* this.ensureAvailable();
			const target = realpathOrSelf(this.detachedPath(i));
			const atTarget = (refs: readonly WorktreeRef[]) =>
				refs.find((ref) => ref.path === target);
			const existing = atTarget(yield* this.list(i.repo));
			const present = fs.existsSync(target);
			// A registered worktree whose directory is gone is a stale record, not a
			// worktree to reuse: answering with that path would hand the workflow a
			// checkout that is not there, and `git worktree add` refuses it as
			// "missing but already registered worktree" until it is pruned.
			if (existing && !existing.prunable && present)
				return { ...existing, created: false };
			// git's own view decides what the path is: a live registration (reuse it),
			// a stale one (prune the record), or a directory git knows nothing about
			// (reclaimed when it holds only harness data, refused otherwise).
			const registered = (yield* this.gitWorktrees(i.repo)).find(
				(entry) => realpathOrSelf(entry.path) === target,
			);
			if (registered && !registered.prunable && present)
				return {
					path: target,
					branch: "",
					isMain: false,
					detached: true,
					created: false,
				};
			if (registered || existing?.prunable || (existing && !present))
				yield* this.run(["git", "-C", i.repo, "worktree", "prune"]);
			// Whatever is left at the target path is not a worktree git knows: a
			// leftover of an earlier workflow at the same path, or content this port
			// must not delete.
			yield* this.reclaimLeftover(target);
			const outcome = yield* Effect.either(
				this.run([
					"git",
					"-C",
					i.repo,
					"worktree",
					"add",
					"--detach",
					target,
					// `--` confines the branch to the commit-ish position: a ref whose
					// name begins with `-` is data, never a git option.
					"--",
					i.branch,
				]),
			);
			if (Either.isLeft(outcome)) {
				// A create that lost a race (a sibling attempt created the worktree
				// between the lookup and the add) is reuse, not conflict. Prune clears
				// a half-registered entry, then one relist decides.
				yield* Effect.either(
					this.run(["git", "-C", i.repo, "worktree", "prune"]),
				);
				const after = atTarget(yield* this.list(i.repo));
				if (after) return { ...after, created: false };
				return yield* Effect.fail(outcome.left);
			}
			return {
				path: realpathOrSelf(target),
				branch: "",
				isMain: false,
				detached: true,
				created: true,
			};
		});
	}

	/** `git worktree list --porcelain`: git's own registrations, which decide
	 * whether a target path must be pruned, reclaimed or left alone. */
	private gitWorktrees(
		repo: string,
	): Effect.Effect<readonly GitWorktreeEntry[], WorktreeError> {
		return this.command(
			["git", "-C", repo, "worktree", "list", "--porcelain"],
			decodeGitWorktreeList,
		);
	}

	/**
	 * Reclaim a directory that sits at the target path of a detached worktree but
	 * is not a worktree git knows.
	 *
	 * Only this engine's own harness data may be inside it — `.herdr-workflow`
	 * (where its telemetry and run files live) and a `.git` *file* (git's pointer
	 * of a linked worktree whose registration is gone) — and then it is removed,
	 * because it is the leftover of an earlier workflow that would otherwise fail
	 * the setup with `fatal: '<path>' already exists`. A `.git` **directory** is a
	 * repository checkout and never harness data. Anything else is the
	 * developer's content: the failure names the path and what it holds instead
	 * of deleting it.
	 */
	private reclaimLeftover(target: string): Effect.Effect<void, WorktreeError> {
		return Effect.try({
			try: () => {
				let entries: string[];
				try {
					entries = fs.readdirSync(target);
				} catch {
					// Nothing is at the path: there is nothing to reclaim.
					return;
				}
				const foreign = entries.filter(
					(entry) =>
						entry !== HARNESS_DATA_DIRECTORY &&
						!(entry === ".git" && !isDirectory(path.join(target, entry))),
				);
				if (foreign.length > 0)
					throw new WorktreeError(
						"conflict",
						`the worktree path ${target} exists and is not a registered git worktree; it holds ${describeEntries(entries)} — remove it by hand, or start the workflow on another branch`,
					);
				fs.rmSync(target, { recursive: true, force: true });
			},
			catch: (error) =>
				error instanceof WorktreeError
					? error
					: new WorktreeError(
							"conflict",
							`the leftover worktree path ${target} could not be reclaimed: ${errorText(error)}`,
							{ cause: error },
						),
		});
	}

	/** One `wt switch`; with `base` the branch is created, without it the
	 * existing branch is attached or its worktree reused. Returns `undefined`
	 * when a create loses the branch to an existing one. */
	private switchWorktree(
		i: WorktreeEnsureInput,
		base?: string,
	): Effect.Effect<WorktreeRef | undefined, WorktreeError> {
		const args = [
			"switch",
			...(base ? ["--create", "--base", base] : []),
			i.branch,
			...WT_AUTOMATION_FLAGS,
			"--format",
			"json",
		];
		return this.command(
			worktrunkArgv(i.repo, args, {
				...(this.pathConfig(i) ? { pathConfig: this.pathConfig(i) } : {}),
				...(this.binPath ? { binPath: this.binPath } : {}),
			}),
			(raw) => refFromSwitch(decodeWorktrunkSwitch(raw, i.branch)),
		).pipe(
			Effect.catchIf(
				(error) =>
					base !== undefined &&
					/already exists|already checked out|already on worktree/i.test(
						error.message,
					),
				() => Effect.succeed(undefined),
			),
		);
	}

	remove(i: WorktreeRemoveInput): Effect.Effect<void, WorktreeError> {
		return Effect.gen(this, function* () {
			const refs = yield* this.list(i.repo);
			const target = refs.find((ref) =>
				i.path ? ref.path === realpathOrSelf(i.path) : ref.branch === i.branch,
			);
			// Primary protection is checked here rather than left to worktrunk,
			// which answers a usage error instead of a diagnostic.
			if (target?.isMain)
				return yield* Effect.fail(
					new WorktreeError(
						"conflict",
						`cannot remove the primary worktree (${target.path})`,
					),
				);
			if (!target && !i.path)
				return yield* Effect.fail(
					new WorktreeError(
						"absent",
						`no worktree for branch ${i.branch ?? ""}`,
					),
				);
			const selector = (i.path ?? i.branch ?? "").trim();
			if (!selector)
				return yield* Effect.fail(
					new WorktreeError("conflict", "worktree removal needs a target"),
				);
			yield* this.run(
				worktrunkArgv(
					i.repo,
					[
						"remove",
						selector,
						...(i.force ? ["--force"] : []),
						// Worktrunk deletes a merged branch by default; the port
						// keeps the branch unless the caller asks for its deletion.
						...(i.deleteBranch ? [] : ["--no-delete-branch"]),
						...(i.reap ? ["--reap"] : []),
						"--no-hooks",
						"-y",
						"--format",
						"json",
					],
					{ ...(this.binPath ? { binPath: this.binPath } : {}) },
				),
			);
		});
	}
}

/** The harness directory a leftover worktree may hold: the engine's own
 * `.herdr-workflow` data (its telemetry and run files), the one entry that is
 * never the developer's content. */
const HARNESS_DATA_DIRECTORY = HERDR_WORKFLOW_DIRECTORY;

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** The entry names of a refused leftover path, bounded so a directory holding
 * thousands of entries cannot make the failure unreadable. */
function describeEntries(entries: readonly string[]): string {
	const shown = entries.slice(0, 8).map((entry) => JSON.stringify(entry));
	return entries.length > shown.length
		? `${shown.join(", ")} (and ${entries.length - shown.length} more)`
		: shown.join(", ");
}

/** Failing loudly beats a missing-binary stack trace: the worktrunk executable
 * is validated (presence plus minimum version) before every worktree
 * operation, with the missing prerequisite named. A replaced subprocess (the
 * test seam) skips the executable lookup, which would otherwise consult the
 * developer's PATH for a call that never spawns.
 *
 * The checks sit inside `Effect.suspend` because the adapter memoizes this
 * effect: an eager check would replay the verdict of the first operation for
 * the rest of the process, so installing worktrunk while the shell runs (or
 * removing it) would not be seen until a restart. */
export function validateWorktrunk(
	options: WorktreeAdapterOptions = {},
): Effect.Effect<void, WorktreeError> {
	const bin = options.binPath ?? worktrunkBin();
	const runner = options.runner ?? runWorktreeCommand;
	return Effect.suspend(() => {
		if (!options.runner && !Bun.which(bin))
			return Effect.fail(
				new WorktreeError(
					"unavailable",
					`worktree operations require '${bin}' on PATH or WORKTRUNK_BIN_PATH`,
				),
			);
		return runner([bin, "--version"]).pipe(
			Effect.flatMap((stdout) => {
				const version = parseWorktrunkVersion(stdout);
				if (!version)
					return Effect.fail(
						new WorktreeError(
							"invalid-response",
							`could not read the worktrunk version from '${stdout.trim()}'`,
						),
					);
				if (!meetsMinimumVersion(version, MIN_WORKTRUNK_VERSION))
					return Effect.fail(
						new WorktreeError(
							"unavailable",
							`worktrunk ${version.join(".")} is older than the required ${MIN_WORKTRUNK_VERSION}`,
						),
					);
				return Effect.void;
			}),
			Effect.catchIf(
				(error) =>
					error.kind === "unavailable" && !error.message.includes("older"),
				(error) =>
					Effect.fail(
						new WorktreeError(
							"unavailable",
							`worktrunk '${bin}' could not be run: ${error.message}`,
						),
					),
			),
		);
	});
}

export { classifyWorktreeFailure };

let defaultPort: WorktreePort | undefined;

/** The process-scoped default port, constructed lazily and memoized. The
 * application roots call this; tests may override it. */
export function worktreePort(): WorktreePort {
	defaultPort ??= new WorktreeAdapter();
	return defaultPort;
}

/** Test/application seam: replace the memoized default port. */
export function setWorktreePortForTests(port: WorktreePort | undefined): void {
	defaultPort = port;
}

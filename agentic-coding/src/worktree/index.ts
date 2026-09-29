// Worktrunk-backed worktree port (introduce-worktree-port, task 1.3).
//
// The port's single implementation. Worktree mechanics live here: create-or-
// reuse as one decision, primary-worktree protection, branch preservation on
// removal, and stale-entry reclamation. Worktrunk is reached only through
// `./cli.ts`, and every invocation disables hooks, directory changes and
// prompts, so nothing a repository configures can run because an environment
// action or a workflow asked for a worktree.
import { Effect } from "effect";
import {
	classifyWorktreeFailure,
	decodeWorktrunkList,
	decodeWorktrunkSwitch,
	errorText,
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
import { worktreePathConfig, worktreePathConstant } from "./template.ts";

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

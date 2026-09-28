// Runtime-neutral worktree port (introduce-worktree-port, task 1.1).
//
// One intent-level, Effect-native boundary over worktree listing, resolution,
// create-or-reuse, and removal, implemented over worktrunk by
// `src/worktree/index.ts`. Callers name worktree concepts and never construct
// `wt` argument vectors or parse worktrunk JSON; the adapter owns transport
// mechanics.
//
// Design rules encoded here:
//   - Every operation is required (no optional methods, no capability flags).
//   - There is no raw-command escape hatch.
//   - `ensure` owns the create-or-reuse decision so a caller cannot create a
//     second worktree for a branch that already has one.
//   - Failures let a caller distinguish confirmed absence from a conflict that
//     retrying cannot fix, and from transport unavailability.
import type { Effect } from "effect";

/**
 * Why a worktree operation failed. `absent` is confirmed absence (no worktree
 * for the branch), `conflict` is a state retrying cannot change (the branch is
 * checked out elsewhere, the path is occupied, the primary worktree is the
 * target), `unavailable` is a missing binary or a failed subprocess,
 * `invalid-response` is bounded reply-shape drift, and `ownership-lost` keeps
 * the workflow engine's ownership classification.
 */
export type WorktreeFailureKind =
	| "absent"
	| "unavailable"
	| "conflict"
	| "invalid-response"
	| "ownership-lost";

/** One classified worktree failure. `kind` is the only axis callers need; the
 * command detail stays for bounded diagnostics. */
export class WorktreeError extends Error {
	readonly _tag = "WorktreeError";
	readonly kind: WorktreeFailureKind;
	constructor(
		kind: WorktreeFailureKind,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "WorktreeError";
		this.kind = kind;
	}
}

/** One normalized worktree observation. `detached` marks a checkout without a
 * branch, and `prunable` carries the reason when the worktree's directory or
 * gitdir is gone. */
export interface WorktreeRef {
	readonly path: string;
	readonly branch: string;
	readonly isMain: boolean;
	readonly detached: boolean;
	readonly prunable?: string;
	/** True when the call that produced this reference created the worktree. */
	readonly created: boolean;
}

/** Where linked worktrees of one repository are created: a root directory and
 * the repository's directory name (see `template.ts`). */
export interface WorktreeLocation {
	readonly root: string;
	readonly ident: string;
}

export interface WorktreeEnsureInput {
	/** Any worktree of the repository; worktrunk and git resolve the
	 * repository from it, and a branch checked out in the primary worktree
	 * resolves back to that path. */
	readonly repo: string;
	readonly branch: string;
	/** Commit or ref the branch starts at. Present means "the branch may not
	 * exist yet"; absent means "attach the existing branch". */
	readonly base?: string;
	/** One exact path instead of the layout template; the caller owns it. */
	readonly path?: string;
	/** Explicit layout; without it worktrunk's configured location is used. */
	readonly location?: WorktreeLocation;
}

export interface WorktreeRemoveInput {
	/** Any worktree of the repository. */
	readonly repo: string;
	/** Exactly one of `branch` and `path` names the target. A path also
	 * reclaims a worktree whose directory was deleted outside the port. */
	readonly branch?: string;
	readonly path?: string;
	/** Remove even when the worktree has uncommitted changes. */
	readonly force?: boolean;
	/** Delete the branch as well; the port keeps it by default. */
	readonly deleteBranch?: boolean;
	/** Terminate processes rooted in the worktree before removing it. */
	readonly reap?: boolean;
}

export interface WorktreePort {
	/** Every worktree of the repository, including stale ones. A repository
	 * that is not cloned yet fails as `conflict`; the caller decides whether
	 * that is absence. */
	list(repo: string): Effect.Effect<readonly WorktreeRef[], WorktreeError>;
	/** The worktree registered for `branch`, or `undefined` for confirmed
	 * absence. */
	find(
		repo: string,
		branch: string,
	): Effect.Effect<WorktreeRef | undefined, WorktreeError>;
	/** Reuse the worktree a branch already has, else create one at its layout
	 * path (starting the branch at `base` when it does not exist yet). */
	ensure(i: WorktreeEnsureInput): Effect.Effect<WorktreeRef, WorktreeError>;
	/** Remove one worktree; the branch survives unless `deleteBranch` is set. */
	remove(i: WorktreeRemoveInput): Effect.Effect<void, WorktreeError>;
}

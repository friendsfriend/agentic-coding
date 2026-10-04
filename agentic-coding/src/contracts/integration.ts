// Integration wire contract: Git worktree/diff observations and the wiki
// change records the dashboard reads through the gateway. Pure types and
// Effect Schemas.
import { Schema } from "effect";

export const localChangeSchema = Schema.Struct({
	oldPath: Schema.optional(Schema.String),
	newPath: Schema.String,
	linesAdded: Schema.Number,
	linesDeleted: Schema.Number,
	newFile: Schema.Boolean,
	deletedFile: Schema.Boolean,
	renamedFile: Schema.Boolean,
});

/** Git state of one workflow worktree, as the observations endpoint reports it. */
export interface WorktreeGitStatus {
	/** False when Git could not be inspected (missing or non-Git worktree). */
	available: boolean;
	/** Bounded reason shown when unavailable. */
	diagnostic?: string;
	branch?: string;
	changedFiles: number;
	addedFiles: number;
	deletedFiles: number;
	/** Undefined when the branch has no configured upstream. */
	ahead?: number;
	behind?: number;
	noUpstream: boolean;
}

/** One changed file in a worktree or wiki diff. */
export interface LocalChange {
	oldPath?: string;
	newPath: string;
	linesAdded: number;
	linesDeleted: number;
	newFile: boolean;
	deletedFile: boolean;
	renamedFile: boolean;
}

export interface WorktreeGitStatus {
	/** False when Git could not be inspected (missing or non-Git worktree). */
	available: boolean;
	/** Bounded reason shown when unavailable. */
	diagnostic?: string;
	branch?: string;
	changedFiles: number;
	addedFiles: number;
	deletedFiles: number;
	/** Undefined when the branch has no configured upstream. */
	ahead?: number;
	behind?: number;
	noUpstream: boolean;
}

export interface LocalChange {
	oldPath?: string;
	newPath: string;
	linesAdded: number;
	linesDeleted: number;
	newFile: boolean;
	deletedFile: boolean;
	renamedFile: boolean;
}

/** Observation payloads: bounded record lists the dashboard reads. */
export const localChangesSchema = Schema.Array(localChangeSchema);

/** One diff body (bounded so a hostile repository cannot stream forever). */
export const diffBodySchema = Schema.String.pipe(
	Schema.maxLength(4 * 1024 * 1024),
);

/** Path lists: artifacts, changed files. */
export const pathListSchema = Schema.Array(
	Schema.String.pipe(Schema.maxLength(4096)),
);

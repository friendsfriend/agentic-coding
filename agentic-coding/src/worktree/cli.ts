// Worktrunk command boundary for the worktree port
// (introduce-worktree-port, task 1.3).
//
// The adapter's only transport: argv construction, `wt` binary resolution,
// `--format json` decoding, path normalization, and failure classification.
// Nothing here decides worktree behavior — `src/worktree/index.ts` does — and
// nothing here is reachable from a caller.
//
// The subprocess itself comes from `workflow/process.ts`, the repository's one
// subprocess boundary (bounded output, hard timeout, real cancellation), so the
// port does not introduce a second spawn idiom. Root may depend on runtime in
// the source-layer matrix.

import fs from "node:fs";
import { Effect, Schema } from "effect";
import { type ProcessFailure, runProcessEffect } from "../workflow/process.ts";
import {
	WorktreeError,
	type WorktreeFailureKind,
	type WorktreeLocation,
	type WorktreeRef,
} from "./port.ts";

/** Minimum worktrunk release whose `--format json` shapes and flags this
 * adapter relies on (`switch`, `list`, `remove`, `--no-hooks`, `--config-set`). */
export const MIN_WORKTRUNK_VERSION = "0.80.0";

/** Every worktrunk invocation is non-interactive (`-y`), never changes the
 * caller's directory (`--no-cd`), and never runs a repository hook
 * (`--no-hooks`): the trust decision to run a project hook belongs to a human
 * at a terminal, not to an orchestrated agent (design decision 3). */
export const WT_AUTOMATION_FLAGS = ["--no-cd", "--no-hooks", "-y"] as const;

export function worktrunkBin(env: NodeJS.ProcessEnv = process.env): string {
	return env.WORKTRUNK_BIN_PATH ?? "wt";
}

/** `wt -C <repo> [global options] <command…>`; `--config-set` is a global
 * option and must precede the subcommand. `pathConfig` is a prepared
 * `worktree-path="…"` value (`./template.ts`), so this boundary never decides a
 * layout. */
export function worktrunkArgv(
	repo: string,
	args: readonly string[],
	options: { pathConfig?: string; binPath?: string } = {},
): string[] {
	return [
		options.binPath ?? worktrunkBin(),
		"-C",
		repo,
		...(options.pathConfig ? ["--config-set", options.pathConfig] : []),
		...args,
	];
}

const switchReply = Schema.Struct({
	action: Schema.optionalWith(Schema.String, { exact: true }),
	branch: Schema.optionalWith(Schema.String, { exact: true }),
	path: Schema.optionalWith(Schema.String, { exact: true }),
	created_branch: Schema.optionalWith(Schema.Boolean, { exact: true }),
});

const listRow = Schema.Struct({
	branch: Schema.optionalWith(Schema.NullOr(Schema.String), { exact: true }),
	worktree: Schema.optionalWith(
		Schema.Struct({
			path: Schema.optionalWith(Schema.String, { exact: true }),
			main: Schema.optionalWith(Schema.Boolean, { exact: true }),
			detached: Schema.optionalWith(Schema.Boolean, { exact: true }),
			prunable: Schema.optionalWith(
				Schema.Struct({
					reason: Schema.optionalWith(Schema.String, { exact: true }),
				}),
				{ exact: true },
			),
		}),
		{ exact: true },
	),
});

const listReply = Schema.Struct({
	schema: Schema.optionalWith(Schema.Number, { exact: true }),
	items: Schema.optionalWith(Schema.Array(listRow), { exact: true }),
});

interface WorktrunkSwitchReply {
	readonly action: string;
	readonly branch: string;
	readonly path: string;
	readonly createdBranch: boolean;
}

/** Decode one adapter reply, reporting shape drift as `invalid-response`
 * instead of a silently defaulted value. */
function decodeWorktrunkJson<A>(
	// biome-ignore lint/suspicious/noExplicitAny: Effect Schema generics don't line up with decoded shapes; mirrored from decodeHerdrResult.
	schema: Schema.Schema<A, any, never>,
	raw: string,
	what: string,
): A {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new WorktreeError(
			"invalid-response",
			`worktrunk returned invalid JSON for ${what}: ${raw.slice(0, 200)}`,
		);
	}
	try {
		return Schema.decodeUnknownSync(schema)(parsed);
	} catch (error) {
		throw new WorktreeError(
			"invalid-response",
			`worktrunk ${what} reply does not match its schema: ${errorText(error)}`,
			{ cause: error },
		);
	}
}

export function decodeWorktrunkList(raw: string): readonly {
	branch: string;
	path: string;
	isMain: boolean;
	detached: boolean;
	prunable?: string;
}[] {
	const reply = decodeWorktrunkJson(listReply, raw, "list");
	return (reply.items ?? []).flatMap((row) => {
		const path = row.worktree?.path;
		if (!path) return [];
		return [
			{
				path: realpathOrSelf(path),
				branch: row.branch ?? "",
				isMain: row.worktree?.main === true,
				detached: row.worktree?.detached === true,
				...(row.worktree?.prunable?.reason
					? { prunable: row.worktree.prunable.reason }
					: {}),
			},
		];
	});
}

export function decodeWorktrunkSwitch(
	raw: string,
	fallbackBranch: string,
): WorktrunkSwitchReply {
	const reply = decodeWorktrunkJson(switchReply, raw, "switch");
	const path = reply.path;
	if (!path)
		throw new WorktreeError(
			"invalid-response",
			"worktrunk switch reply carried no worktree path",
		);
	return {
		action: reply.action ?? "existing",
		branch: reply.branch ?? fallbackBranch,
		path: realpathOrSelf(path),
		createdBranch: reply.created_branch === true,
	};
}

/** macOS resolves `/tmp` to `/private/tmp`, and worktrunk reports the resolved
 * path while its human output keeps the caller's spelling; every stored path
 * is normalized so equality with a caller's configured path holds. A stale
 * worktree has no directory left to resolve. */
export function realpathOrSelf(value: string): string {
	try {
		return fs.realpathSync(value);
	} catch {
		return value;
	}
}

/** The repository's primary worktree is the one whose `.git` is a directory; a
 * linked worktree keeps `.git` as a file pointing at its per-worktree git
 * directory. This is the same test the environment layer already uses
 * (`currentBranchFromGit`), and it stays exact whatever worktree the caller
 * passed as the repository. */
function isPrimaryWorktree(path: string): boolean {
	try {
		return fs.statSync(`${path}/.git`).isDirectory();
	} catch {
		return false;
	}
}

/** Map one failed worktrunk/git invocation onto the port's failure kinds.
 * A conflict is a state retrying cannot change; anything unrecognized stays
 * transient rather than being reported as a caller defect. */
export function classifyWorktreeFailure(
	detail: string,
	status = 1,
): WorktreeFailureKind {
	if (
		/effect ownership was lost|ownership was lost|stale-ownership/i.test(detail)
	)
		return "ownership-lost";
	if (
		/worktree .*not found|cannot find worktree/i.test(detail) ||
		/^absent$/i.test(detail)
	)
		return "absent";
	if (
		/already exists|already checked out|is checked out|already on worktree|cannot remove|is the main worktree|primary worktree|not a git repository|does not point to a valid repository|would be overwritten|directory not empty|is dirty|uncommitted changes|usage:/i.test(
			detail,
		)
	)
		return "conflict";
	// Everything else (missing binary, spawn failure, permission, lock, a
	// non-zero exit without a recognized diagnostic) is infrastructure.
	return status === 0 ? "conflict" : "unavailable";
}

/** One classified failure from a `ProcessFailure`. `canceled` keeps the
 * ownership class so an aborted ensure is never retried as infrastructure. */
function worktreeErrorFromProcess(
	failure: ProcessFailure,
	command: string,
	cause?: unknown,
): WorktreeError {
	if (failure._tag === "canceled")
		return new WorktreeError("ownership-lost", failure.detail, { cause });
	if (failure._tag === "timeout" || failure._tag === "overflow")
		return new WorktreeError("unavailable", failure.detail, { cause });
	const status = failure.exitCode;
	return new WorktreeError(
		classifyWorktreeFailure(failure.detail, status),
		`${command} failed (exit ${status}): ${failure.detail}`,
		{ cause },
	);
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Parse `wt v0.80.0` (or `wt 0.80.0`) into comparable numeric parts. */
export function parseWorktrunkVersion(output: string): number[] | undefined {
	const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `actual` is at least `minimum` (`a.b.c` compared part by part). */
export function meetsMinimumVersion(
	actual: readonly number[],
	minimum: string,
): boolean {
	const required = minimum.split(".").map(Number);
	for (let index = 0; index < required.length; index += 1) {
		const left = actual[index] ?? 0;
		const right = required[index] ?? 0;
		if (left !== right) return left > right;
	}
	return true;
}

/** The adapter's one effect with an external failure channel: run one command
 * and hand back its stdout, or a classified `WorktreeError`. */
export function runWorktreeCommand(
	argv: readonly string[],
	failureCause?: unknown,
): Effect.Effect<string, WorktreeError> {
	const command = argv.join(" ");
	return runProcessEffect(argv).pipe(
		Effect.map((result) => result.stdout),
		Effect.mapError((failure) =>
			worktreeErrorFromProcess(failure, command, failureCause),
		),
	);
}

/** Test seam: the adapter's command runner. */
export type WorktreeCommandRunner = (
	argv: readonly string[],
) => Effect.Effect<string, WorktreeError>;

export function refFromSwitch(reply: WorktrunkSwitchReply): WorktreeRef {
	return {
		path: reply.path,
		branch: reply.branch,
		// Worktrunk resolves a branch checked out in the primary worktree back to
		// it, which is the environment layer's existing ownership protection.
		isMain: isPrimaryWorktree(reply.path),
		detached: false,
		created: reply.action === "created",
	};
}

// The bounded, content-free sample a run-progress checkpoint takes at its own
// boundary (efficiency backlog item 19, design D4): the worktree's diff size
// in numbers, whether `HEAD` moved, and how many tasks of the assigned change
// are ticked. Three facts that tell "the run is changing the work" from "the
// run is re-reading", sampled only when a checkpoint is due so no run pays for
// them on every turn.
//
// Only numbers leave this module: the diffstat's three counts, the ticked-task
// count and the commit id (compared, never recorded in the digest). The command
// output, the diff itself, the paths and the tasks' text are read by `git` and
// this file and are never returned, logged or emitted.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { CheckpointSample } from "./progress-checkpoint.ts";

/** The bound of one sample, as the design states it: a `git` call that has not
 * answered in this time is unknown, and unknown never delays the run. */
export const CHECKPOINT_SAMPLE_TIMEOUT_MS = 2_000;

/** The command's output bound. A shortstat line is tens of bytes; a pathological
 * one (a repository with millions of files) is cut instead of buffered whole. */
const CHECKPOINT_SAMPLE_MAX_BYTES = 64 * 1024;

export interface CheckpointSampleInput {
	/** The run's working tree. */
	readonly cwd: string;
	/** The OpenSpec change whose `tasks.md` is counted, when the run has one. */
	readonly changeId?: string;
	/** Overridden only by tests that measure the bound itself. */
	readonly timeoutMs?: number;
}

/** Run one bounded command in the worktree; `undefined` when it failed, timed
 * out or printed more than the buffer allows. The bound is the promise's own:
 * `execFile`'s `timeout` only asks the child to stop, so a `git` that ignores
 * the signal would otherwise leave this checkpoint's supervisor waiting for
 * ever. The deadline here settles the promise and kills the child outright. */
function git(
	cwd: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve(value);
		};
		let child: ReturnType<typeof execFile> | undefined;
		const deadline = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				/* the child was already gone */
			}
			finish(undefined);
		}, timeoutMs);
		child = execFile(
			"git",
			["-C", cwd, ...args],
			{ timeout: timeoutMs, maxBuffer: CHECKPOINT_SAMPLE_MAX_BYTES },
			(error, stdout) => {
				if (error) finish(undefined);
				else finish(String(stdout));
			},
		);
	});
}

/** `git diff --shortstat HEAD` as its three counts. The line reads
 * ` 3 files changed, 12 insertions(+), 4 deletions(-)`; a clean tree prints
 * nothing, which is zero of each. Each part is optional in git's own output. */
export function parseDiffShortstat(
	output: string | undefined,
): { files: number; insertions: number; deletions: number } | undefined {
	if (output === undefined) return undefined;
	const text = output.trim();
	if (text.length === 0) return { files: 0, insertions: 0, deletions: 0 };
	const count = (pattern: RegExp): number => {
		const match = pattern.exec(text);
		return match?.[1] === undefined ? 0 : Number(match[1]);
	};
	return {
		files: count(/(\d+) files? changed/),
		insertions: count(/(\d+) insertions?\(\+\)/),
		deletions: count(/(\d+) deletions?\(-\)/),
	};
}

/** How many `- [x]` lines a `tasks.md` holds. Only the number leaves this
 * function: the tasks' text is never read into the digest, and a file that
 * cannot be read is unknown rather than zero. */
export async function countTickedTasks(
	file: string,
): Promise<number | undefined> {
	try {
		const text = await fs.readFile(file, "utf8");
		let ticked = 0;
		for (const line of text.split("\n"))
			if (/^\s*[-*]\s*\[[xX]\](\s|$)/.test(line)) ticked += 1;
		return ticked;
	} catch {
		return undefined;
	}
}

/** One checkpoint boundary's sample. Every part is independently unknown on
 * failure, so a broken `git` leaves the ticked-task count usable and a missing
 * change leaves the diff usable. */
export async function sampleCheckpoint(
	input: CheckpointSampleInput,
): Promise<CheckpointSample> {
	const timeoutMs = input.timeoutMs ?? CHECKPOINT_SAMPLE_TIMEOUT_MS;
	const [diffstat, head, tickedTasks] = await Promise.all([
		git(input.cwd, ["diff", "--shortstat", "HEAD"], timeoutMs),
		git(input.cwd, ["rev-parse", "HEAD"], timeoutMs),
		input.changeId === undefined
			? Promise.resolve(undefined)
			: countTickedTasks(tasksPath(input.cwd, input.changeId)),
	]);
	const diff = parseDiffShortstat(diffstat);
	const commit = head?.trim();
	return {
		...(diff !== undefined ? { diff } : {}),
		...(commit !== undefined && commit.length > 0 ? { head: commit } : {}),
		...(tickedTasks !== undefined ? { tickedTasks } : {}),
	};
}

/** The assigned change's `tasks.md` inside the run's worktree. */
export function tasksPath(cwd: string, changeId: string): string {
	return path.join(cwd, "openspec", "changes", changeId, "tasks.md");
}

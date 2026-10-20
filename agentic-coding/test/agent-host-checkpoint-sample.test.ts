// The bounded, content-free worktree sample a run-progress checkpoint takes at
// its own boundary (efficiency backlog item 19, design D4): numbers only, and
// every part independently unknown when its command fails.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CHECKPOINT_SAMPLE_TIMEOUT_MS,
	countTickedTasks,
	parseDiffShortstat,
	sampleCheckpoint,
	tasksPath,
} from "../src/agent-host/checkpoint-sample.ts";

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function git(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

describe("the diffstat a checkpoint records", () => {
	test("parses the three counts git prints", () => {
		expect(
			parseDiffShortstat(
				" 2 files changed, 10 insertions(+), 3 deletions(-)\n",
			),
		).toEqual({ files: 2, insertions: 10, deletions: 3 });
	});

	test("a clean tree is zero, not unknown", () => {
		expect(parseDiffShortstat("")).toEqual({
			files: 0,
			insertions: 0,
			deletions: 0,
		});
	});

	test("git omits a part that is zero", () => {
		expect(parseDiffShortstat(" 1 file changed, 4 deletions(-)")).toEqual({
			files: 1,
			insertions: 0,
			deletions: 4,
		});
		expect(parseDiffShortstat(" 1 file changed, 4 insertions(+)")).toEqual({
			files: 1,
			insertions: 4,
			deletions: 0,
		});
		expect(parseDiffShortstat(" 3 files changed, 1 insertion(+)")).toEqual({
			files: 3,
			insertions: 1,
			deletions: 0,
		});
	});

	test("a command that never answered is unknown", () => {
		expect(parseDiffShortstat(undefined)).toBeUndefined();
	});
});

describe("the ticked-task count a checkpoint records", () => {
	test("counts ticked items and ignores the rest", async () => {
		const dir = tempDir("checkpoint-tasks-");
		const file = path.join(dir, "tasks.md");
		fs.writeFileSync(
			file,
			[
				"## 1. One",
				"",
				"- [x] 1.1 done",
				"- [ ] 1.2 not done",
				"  - [X] nested and done",
				"- [x]1.3 no space after the box",
				"1. [x] numbered, not a checkbox",
			].join("\n"),
		);
		expect(await countTickedTasks(file)).toBe(2);
	});

	test("a file that is not there is unknown, never zero", async () => {
		expect(
			await countTickedTasks(path.join(tempDir("x-"), "tasks.md")),
		).toBeUndefined();
	});

	test("the assigned change's file is the one under the worktree", () => {
		expect(tasksPath("/work", "2026-10-19-run-progress-checkpoint")).toBe(
			path.join(
				"/work",
				"openspec",
				"changes",
				"2026-10-19-run-progress-checkpoint",
				"tasks.md",
			),
		);
	});
});

describe("one checkpoint sample", () => {
	test("reads the diff, the commit and the ticked tasks of a worktree", async () => {
		const dir = tempDir("checkpoint-sample-");
		git(dir, ["init", "--quiet"]);
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		git(dir, ["add", "."]);
		git(dir, ["commit", "--quiet", "-m", "first"]);
		fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
		fs.mkdirSync(path.join(dir, "openspec", "changes", "change-1"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(dir, "openspec", "changes", "change-1", "tasks.md"),
			"- [x] 1.1\n- [x] 1.2\n- [ ] 1.3\n",
		);
		const head = git(dir, ["rev-parse", "HEAD"]).trim();
		const sample = await sampleCheckpoint({ cwd: dir, changeId: "change-1" });
		expect(sample.diff).toEqual({ files: 1, insertions: 2, deletions: 0 });
		expect(sample.head).toBe(head);
		expect(sample.tickedTasks).toBe(2);
	});

	test("a worktree with no changes has a zero diff and a commit", async () => {
		const dir = tempDir("checkpoint-clean-");
		git(dir, ["init", "--quiet"]);
		fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
		git(dir, ["add", "."]);
		git(dir, ["commit", "--quiet", "-m", "first"]);
		const sample = await sampleCheckpoint({ cwd: dir });
		expect(sample.diff).toEqual({ files: 0, insertions: 0, deletions: 0 });
		expect(sample.head?.length).toBeGreaterThan(0);
		// No change id means no tasks file was read at all, so the count is unknown.
		expect(sample.tickedTasks).toBeUndefined();
	});

	test("a directory that is not a repository is unknown and never throws", async () => {
		const dir = tempDir("checkpoint-nogit-");
		const sample = await sampleCheckpoint({ cwd: dir, changeId: "change-1" });
		expect(sample.diff).toBeUndefined();
		expect(sample.head).toBeUndefined();
		expect(sample.tickedTasks).toBeUndefined();
	});

	test("a git that ignores the stop signal still cannot hold the sample", async () => {
		// `execFile`'s own timeout only asks the child to stop, so a `git` in an
		// uninterruptible wait would leave the promise — and the run's checkpoint
		// supervisor — pending for ever. The sample's own deadline decides.
		const bin = tempDir("checkpoint-stuckgit-");
		const script = path.join(bin, "git");
		fs.writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nsleep 30\n", {
			mode: 0o700,
		});
		const previous = process.env.PATH;
		process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
		const started = Date.now();
		try {
			const sample = await sampleCheckpoint({
				cwd: tempDir("checkpoint-cwd-"),
				timeoutMs: 300,
			});
			// Unknown, never a value, and answered long before the child would.
			expect(sample).toEqual({});
			expect(Date.now() - started).toBeLessThan(2_000);
		} finally {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		}
	});

	test("the sample's own bound is the two seconds the design states", () => {
		expect(CHECKPOINT_SAMPLE_TIMEOUT_MS).toBe(2_000);
	});
});

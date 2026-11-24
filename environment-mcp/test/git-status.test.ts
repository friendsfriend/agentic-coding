import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	readGitChanges,
	readGitDiff,
	readGitStatus,
} from "../src/adapters/process/git-status.ts";
import {
	parseGitChangesOutput,
	parseGitStatusOutput,
} from "../src/domain/git-status.ts";

test("parses porcelain v2 branch, sync and dirty states", () => {
	const clean = parseGitStatusOutput(
		"/repo",
		`# branch.oid ${"a".repeat(40)}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n`,
	);
	expect(clean).toMatchObject({
		state: "clean",
		branch: "main",
		head: "aaaaaaaa",
		ahead: 2,
		behind: 1,
		changed: 0,
	});
	const dirty = parseGitStatusOutput(
		"/repo",
		`# branch.oid ${"b".repeat(40)}\n# branch.head (detached)\n1 .M N... 100644 100644 100644 ${"c".repeat(40)} ${"c".repeat(40)} file.txt\n1 .D N... 100644 100644 100644 ${"c".repeat(40)} ${"c".repeat(40)} gone.txt\n? new.txt\nu UU N... 100644 100644 100644 100644 ${"d".repeat(40)} ${"e".repeat(40)} ${"f".repeat(40)} conflict.txt\n`,
	);
	expect(dirty).toMatchObject({
		state: "dirty",
		detached: true,
		modified: 2,
		added: 1,
		deleted: 1,
		changed: 4,
	});
});

test("parses changed paths, kinds and rename originals", () => {
	const b = "b".repeat(40);
	const parsed = parseGitChangesOutput(
		"/repo",
		`${[
			`# branch.oid ${"a".repeat(40)}`,
			"# branch.head main",
			`1 .M N... 100644 100644 100644 ${b} ${b} src/file.ts`,
			`1 .D N... 100644 100644 100644 ${b} ${b} gone.ts`,
			"? new file.txt",
			`2 R. N... 100644 100644 100644 ${b} ${b} R100 new/path.ts`,
			"old/path.ts",
			`u UU N... 100644 100644 100644 100644 ${b} ${"c".repeat(40)} ${"d".repeat(40)} conflict.ts`,
		].join("\0")}\0`,
	);
	expect(parsed.changes).toMatchObject([
		{ path: "src/file.ts", kind: "modified", staged: false, worktree: true },
		{ path: "gone.ts", kind: "deleted" },
		{ path: "new file.txt", kind: "untracked", staged: false },
		{
			path: "new/path.ts",
			originalPath: "old/path.ts",
			kind: "renamed",
			staged: true,
		},
		{ path: "conflict.ts", kind: "conflicted" },
	]);
	const limited = parseGitChangesOutput(
		"/repo",
		"1 .M N... 100644 100644 100644 a a one\0? two\0? three\0",
		2,
	);
	expect(limited.changes).toHaveLength(2);
	expect(limited.truncated).toBe(true);
});

test("reads a real repository without mutating it", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-git-"));
	const signal = new AbortController().signal;
	try {
		for (const args of [
			["init", "--quiet"],
			[
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"commit",
				"--allow-empty",
				"--quiet",
				"-m",
				"fixture",
			],
		]) {
			const child = Bun.spawnSync(["git", "-C", root, ...args], {
				stdout: "ignore",
				stderr: "ignore",
			});
			if (child.exitCode !== 0) throw new Error("Fixture Git failed");
		}
		const clean = await readGitStatus(root, signal);
		expect(clean.state).toBe("clean");
		expect(clean.head).toHaveLength(8);
		fs.writeFileSync(path.join(root, "changed.txt"), "x");
		const dirty = await readGitStatus(root, signal);
		expect(dirty.state).toBe("dirty");
		expect(dirty.added).toBe(1);
		expect(dirty.changed).toBeGreaterThan(0);
		const changes = await readGitChanges(root, signal);
		const untracked = changes.changes.find(
			(change) => change.path === "changed.txt",
		);
		expect(untracked).toMatchObject({ kind: "untracked" });
		if (!untracked) throw new Error("expected untracked change");
		const diff = await readGitDiff(root, untracked, signal);
		expect(diff.diff).toContain("+x");
		const invalid = await readGitDiff(
			root,
			{ ...untracked, path: "../etc/passwd" },
			signal,
		);
		expect(invalid.note).toBe("invalid-path");
		const missing = await readGitStatus(path.join(root, "missing"), signal);
		expect(missing).toMatchObject({
			state: "unknown",
			reason: "not-a-repository",
		});
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

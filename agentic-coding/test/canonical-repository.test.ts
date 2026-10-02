// `canonicalRepository` is a memoised probe: it exists because deriving a
// repository root spawns `git rev-parse`, and the engine derives the same root
// several times per operation. A memo that is wrong is worse than no memo — it
// decides which repository's store an operation reads and writes — and no
// indirect test can tell a correct cache from a broken one, because each test
// resolves its own fresh repository exactly once. These are the properties the
// memo has to hold.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalRepository } from "../src/workflow/runtime/targets.ts";
import { autoRemoveRepoFixtures, createTempRepoFixture } from "./support/git-fixture.ts";

// Sweep the repositories this file created, at the end of this file only.
autoRemoveRepoFixtures();

const created: string[] = [];

function workspace(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(root);
	return root;
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function plainRepo(prefix = "canonical-repo-"): string {
	const repo = createTempRepoFixture(prefix);
	created.push(repo);
	return repo;
}

afterEach(() => {
	for (const root of created.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

describe("canonical repository resolution", () => {
	test("a cache hit returns what a fresh probe would", () => {
		const repo = plainRepo();
		const first = canonicalRepository(repo);
		const second = canonicalRepository(repo);
		expect(second).toBe(first);
		// The cached answer has to match git's own, not just match itself.
		const common = git(repo, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		expect(first).toBe(fs.realpathSync(path.dirname(common)));
	});

	test("a failed probe is not cached, so a repository created afterwards is found", () => {
		const dir = workspace("canonical-late-");
		expect(() => canonicalRepository(dir)).toThrow(/not a Git repository/);
		git(dir, ["init", "-q", "-b", "main"]);
		expect(canonicalRepository(dir)).toBe(fs.realpathSync(dir));
	});

	test("a path that no longer exists throws rather than resolving", () => {
		// This pins the contract for a missing path, which is all it can pin:
		// `canonicalRepository` resolves the path before consulting the memo, so a
		// deleted directory throws from `realpathSync` and no cache code runs. The
		// memo's own invalidation is covered by the re-created-path case below,
		// which is the one that fails against a cache without identity validation.
		const dir = workspace("canonical-gone-");
		git(dir, ["init", "-q", "-b", "main"]);
		expect(canonicalRepository(dir)).toBe(fs.realpathSync(dir));
		fs.rmSync(dir, { recursive: true, force: true });
		expect(() => canonicalRepository(dir)).toThrow();
	});

	test("a path re-created as another repository resolves to the new one", () => {
		// A linked worktree's canonical root is the main repository, so one path
		// legitimately resolves to two different roots over its lifetime.
		const main = plainRepo("canonical-main-");
		const linked = path.join(workspace("canonical-linked-"), "linked");
		git(main, ["worktree", "add", "-q", "-b", "side", linked]);
		expect(canonicalRepository(linked)).toBe(fs.realpathSync(main));

		git(main, ["worktree", "remove", "--force", linked]);
		fs.rmSync(linked, { recursive: true, force: true });
		fs.mkdirSync(linked);
		git(linked, ["init", "-q", "-b", "main"]);
		// The re-created directory is a different repository, so the memo has to
		// be invalidated by the directory's identity rather than by its path.
		expect(canonicalRepository(linked)).toBe(fs.realpathSync(linked));
	});
});

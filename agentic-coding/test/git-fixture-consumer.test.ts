// Companion to test/git-fixture.test.ts, and the behavioural half of the guard
// against the generation-2 defect.
//
// That defect was a teardown registered by the shared fixture module: it is
// file-scoped when registered by an imported module, so it fired after the first
// file in the process and reclaimed a template the second file still needed.
// `bun test test/workflow-migration.test.ts test/canonical-repository.test.ts`
// went from 22 pass to 4 pass / 18 fail, in both argument orders.
//
// This file materialises a repository at module scope, before any test runs, so
// running it together with test/git-fixture.test.ts reproduces that shape: if the
// fixture module ever registers a hook of its own again, the first file's hook
// sweeps what this file created and the assertions below fail.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	autoRemoveRepoFixtures,
	commitRepoFixture,
	createTempRepoFixture,
	removeRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

// The teardown this file owns. Registered from a test file's own module scope, so
// it runs at the end of this file and never between siblings of a shard.
autoRemoveRepoFixtures();

test("a fixture created after another file has run is still complete", () => {
	const repo = createTempRepoFixture(
		"fixture-consumer-",
		repoPreset.specDriven,
	);
	try {
		expect(fs.existsSync(path.join(repo, ".git"))).toBe(true);
		expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(
			"test\n",
		);
		expect(
			execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
				cwd: repo,
				encoding: "utf8",
			}).trim(),
		).toBe("true");
	} finally {
		removeRepoFixture(repo);
	}
});

test("and is a real repository that can take a commit", () => {
	const repo = createTempRepoFixture("fixture-consumer-", repoPreset.readme);
	try {
		fs.writeFileSync(path.join(repo, "second.txt"), "second\n");
		expect(commitRepoFixture(repo, "second")).toMatch(/^[0-9a-f]{40}$/);
	} finally {
		removeRepoFixture(repo);
	}
});

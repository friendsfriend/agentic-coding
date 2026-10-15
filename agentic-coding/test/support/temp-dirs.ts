// Temporary directories a test file creates, and the teardown that removes them.
//
// The lifecycle is the one `git-fixture.ts` explains at length: the tracking set
// is module-scope, but the `afterAll` that drains it belongs to the *file* that
// registered it. A hook registered while an imported module is evaluated is
// file-scoped — it fires after the first file that imported it, not at the end of
// the process — so a sweep owned by this module would reclaim a sibling file's
// directories mid-shard, while `autoRemoveTempDirs()` called from a test file's
// own module scope is exactly file-scoped, and never runs between files of a
// shard.
//
// Measured before this existed: `test/env-setup-approval.test.ts` left three
// `env-setup-observations-repo-*` repositories behind per run — real Git
// repositories a workflow had been started in — and the same shape appeared in
// five more files. The preload sweeps the whole sandbox now
// (test/support/isolate-config-root.ts), which makes a leak invisible rather than
// impossible; a file that creates a repository still removes it itself.
import { afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const created = new Set<string>();

/** `mkdtempSync` in the (isolated) temp directory, remembered for the sweep. */
export function tempDir(prefix: string): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.add(directory);
	return directory;
}

/** Remember a directory a test created inline, and hand it back. */
export function trackTempDir(directory: string): string {
	created.add(directory);
	return directory;
}

/** Call once at a test file's module scope to remove the directories it created. */
export function autoRemoveTempDirs(): void {
	afterAll(() => {
		for (const directory of created)
			fs.rmSync(directory, { recursive: true, force: true });
		created.clear();
	});
}

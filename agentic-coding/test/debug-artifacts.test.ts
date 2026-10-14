// The debug family's handoff artifacts (`add-debug-workflow`, task 3.2): the
// markdown report the developer reviews and the `changes.patch` entry that
// preserves a dirty detached worktree's edits past its removal. Both live in
// the **repository's** data root, so closing the workflow (which removes the
// detached worktree) does not delete them.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowSnapshot } from "../src/contracts/workflow.ts";
import {
	debugChangesPatch,
	debugHandoffArtifacts,
	writeDebugArtifacts,
} from "../src/workflow/runtime/evidence.ts";

const cleanups: Array<() => void> = [];
function track(cleanup: () => void): void {
	cleanups.push(cleanup);
}
afterAll(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function repo(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-artifacts-"));
	fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"init",
		],
		{ cwd: root },
	);
	track(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

/** A directory that stands in for the repository's data root, distinct from the
 * detached worktree: the artifacts must survive the worktree's removal. */
function dataRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "debug-artifacts-data-"));
	track(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function snapshot(worktree: string, repository: string): WorkflowSnapshot {
	return {
		workflowId: "wf-debug-1",
		metadata: { worktree, repository },
	} as unknown as WorkflowSnapshot;
}

describe("debug handoff artifacts", () => {
	test("a dirty worktree writes the report and a changes.patch entry", () => {
		const root = repo();
		const data = dataRoot();
		fs.appendFileSync(path.join(root, "README.md"), "changed\n");
		fs.writeFileSync(path.join(root, "new.txt"), "brand new\n");
		const entries = writeDebugArtifacts(
			snapshot(root, data),
			"# Summary\nfound it",
		);
		const report = entries.find((entry) => entry.kind === "debug:report");
		if (!report) throw new Error("no report entry");
		// The report lives in the repository's data root, never the worktree that
		// cleanup removes.
		expect(report.path.startsWith(data)).toBe(true);
		expect(report.path.endsWith("debug-report.md")).toBe(true);
		expect(fs.readFileSync(report.path, "utf8")).toBe("# Summary\nfound it\n");
		const patch = entries.find((entry) => entry.kind === "debug:changes.patch");
		if (!patch) throw new Error("no changes.patch entry");
		expect(patch.path.startsWith(data)).toBe(true);
		expect(patch.path.endsWith("changes.patch")).toBe(true);
		const text = fs.readFileSync(patch.path, "utf8");
		// Tracked edits and untracked files both survive the worktree's removal.
		expect(text).toContain("README.md");
		expect(text).toContain("new.txt");
		expect(text).toContain("changed");
		// The report this function wrote is not mistaken for an edit.
		expect(text).not.toContain("debug-report.md");
	});

	test("a clean worktree writes the report but no patch", () => {
		const root = repo();
		const data = dataRoot();
		const entries = writeDebugArtifacts(
			snapshot(root, data),
			"# Summary\nnothing",
		);
		expect(entries.map((entry) => entry.kind)).toEqual(["debug:report"]);
	});

	test("a single huge line is refused by the byte screen", () => {
		const root = repo();
		// One line, five megabytes: the line-count guard alone would let this
		// through and `git diff` would materialize it in full. The byte screen
		// measures the changed file first and refuses before the diff is read.
		fs.writeFileSync(
			path.join(root, "minified.js"),
			"x".repeat(5 * 1024 * 1024),
		);
		const patch = debugChangesPatch(root);
		expect(patch).toContain("diff omitted");
		expect(patch?.length).toBeLessThan(1000);
	});

	test("a shrinking modification counts the removed side too", () => {
		const root = repo();
		// A large tracked blob committed on the branch under investigation, then
		// rewritten to a few bytes: the diff is dominated by the removed lines, so
		// the guard must count the HEAD blob as well as the new size.
		fs.writeFileSync(path.join(root, "data.json"), "y".repeat(5 * 1024 * 1024));
		execFileSync("git", ["-C", root, "add", "data.json"]);
		execFileSync("git", [
			"-C",
			root,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"data",
		]);
		fs.writeFileSync(path.join(root, "data.json"), "tiny now\n");
		const patch = debugChangesPatch(root);
		expect(patch).toContain("diff omitted");
		expect(patch?.length).toBeLessThan(1000);
	});

	test("computing the handoff artifacts writes nothing", () => {
		const root = repo();
		const data = dataRoot();
		const target = path.join(data, ".herdr-workflow", "wf-debug-1");
		const { entries, files } = debugHandoffArtifacts(
			snapshot(root, data),
			"# Summary\nnothing",
		);
		// The compute step must not touch the destination: only a committed handoff
		// may do that.
		expect(fs.existsSync(target)).toBe(false);
		expect(entries.map((entry) => entry.kind)).toEqual(["debug:report"]);
		expect(files).toEqual([
			{
				path: path.join(target, "debug-report.md"),
				content: "# Summary\nnothing\n",
			},
		]);
	});

	test("the patch computation leaves the git index untouched", () => {
		const root = repo();
		fs.writeFileSync(path.join(root, "untracked.txt"), "probe\n");
		const patch = debugChangesPatch(root);
		expect(patch).toContain("untracked.txt");
		// No intent-to-add: the index is unchanged and the file is still untracked.
		expect(
			execFileSync("git", ["-C", root, "diff", "--cached", "--name-only"], {
				encoding: "utf8",
			}).trim(),
		).toBe("");
		expect(
			execFileSync("git", ["-C", root, "status", "--porcelain"], {
				encoding: "utf8",
			}).trim(),
		).toBe("?? untracked.txt");
	});
});

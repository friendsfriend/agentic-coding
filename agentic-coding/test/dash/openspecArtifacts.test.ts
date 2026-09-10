/** Focused coverage for the OpenSpec artifact observation: the dashboard panel
 * lists only a change the workflow itself owns, so a workflow started without
 * OpenSpec phases shows no panel even in a repository full of changes. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSpecArtifacts, testDashboard } from "../../src/tui/dash/data";
import type { WorkflowState } from "../../src/tui/dash/types";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function worktree(): string {
	const root = mkdtempSync(join(tmpdir(), "agent-dash-openspec-"));
	roots.push(root);
	return root;
}

function stateWithChange(root: string, changeId: string): WorkflowState {
	return { ...testDashboard().state, worktree: root, changeId };
}

/** One Markdown artifact at `openspec/changes/<segments…>/<name>`. */
function writeArtifact(root: string, segments: string[], name: string): void {
	const directory = join(root, "openspec", "changes", ...segments);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, name), `# ${name}\n`);
}

test("a workflow without a change lists no artifacts", () => {
	const root = worktree();
	writeArtifact(root, ["other-change"], "proposal.md");
	writeArtifact(root, ["archive", "2026-01-01-other-change"], "proposal.md");

	expect(openSpecArtifacts(stateWithChange(root, ""))).toEqual([]);
});

test("an active change lists only its own artifacts", () => {
	const root = worktree();
	writeArtifact(root, ["demo-change"], "proposal.md");
	writeArtifact(root, ["archive", "2026-01-01-other-change"], "proposal.md");

	expect(openSpecArtifacts(stateWithChange(root, "demo-change"))).toEqual([
		"proposal.md",
	]);
});

test("an archived change keeps listing its artifacts", () => {
	const root = worktree();
	writeArtifact(root, ["archive", "2026-01-01-demo-change"], "proposal.md");

	expect(openSpecArtifacts(stateWithChange(root, "demo-change"))).toEqual([
		"proposal.md",
	]);
});

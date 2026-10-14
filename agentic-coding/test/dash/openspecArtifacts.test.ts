/** Focused coverage for the OpenSpec artifact observation: the dashboard panel
 * lists only a change the workflow itself owns, so a workflow started without
 * OpenSpec phases shows no panel even in a repository full of changes. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowState } from "../../src/contracts/workflow";
import {
	openSpecArtifact,
	openSpecArtifacts,
} from "../../src/server/operations/observations.ts";
import { testDashboard } from "../../src/tui/dash/demo.ts";
import { artifactSurfaceLabel } from "../../src/tui/dash/projections.ts";

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

test("a debug workflow lists its report and renders it", () => {
	const root = worktree();
	const base = testDashboard().state;
	const state: WorkflowState = {
		...base,
		workflowId: "wf-debug-artifact",
		worktree: root,
		repository: root,
		changeId: "",
		definition: { id: "debug", version: 806, digest: "d", label: "Debug" },
	};
	// Before the review, the report does not exist and the panel is empty.
	expect(openSpecArtifacts(state)).toEqual([]);
	const directory = join(root, ".herdr-workflow", "wf-debug-artifact");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "debug-report.md"), "# Summary\nfound it\n");
	expect(openSpecArtifacts(state)).toEqual(["debug-report.md"]);
	expect(openSpecArtifact(state, "debug-report.md")).toBe(
		"# Summary\nfound it\n",
	);
	expect(() => openSpecArtifact(state, "proposal.md")).toThrow(
		/not a listed Markdown file/,
	);
});

test("the artifact surface is named for the workflow family", () => {
	// The panel heading, the artifact viewer's title, and the `?` help section
	// all share this one name, so a debug report is never titled "OpenSpec".
	expect(artifactSurfaceLabel("debug")).toBe("Debug report");
	expect(artifactSurfaceLabel("openspec")).toBe("OpenSpec");
	expect(artifactSurfaceLabel(undefined)).toBe("OpenSpec");
});

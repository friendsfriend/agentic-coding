// The `openspec-changes` observation (efficiency backlog item 21): the listing
// the orchestrator reads instead of guessing a proposal.md path with `read`. It
// answers one compact row per active change — never a document — and marks a
// change that already has a workflow so a second one is not started for it.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type {
	ResolvedProfile,
	WorkflowRouting,
} from "../src/contracts/workflow.ts";
import {
	listOpenSpecChanges,
	runLocalObservation,
} from "../src/server/operations/observations.ts";
import { definitionVersionForStepRouting } from "../src/workflow/definitions/manifest-policy.ts";
import { registerBuiltins } from "../src/workflow/definitions.ts";
import { WorkflowEngine } from "../src/workflow/runtime.ts";
import {
	autoRemoveRepoFixtures,
	commitRepoFixture,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

const TASK = "add a flag to the launcher";

function writeChange(
	root: string,
	id: string,
	files: { proposal?: string; tasks?: string } = {},
): void {
	const dir = path.join(root, "openspec", "changes", id);
	fs.mkdirSync(dir, { recursive: true });
	if (files.proposal !== undefined)
		fs.writeFileSync(path.join(dir, "proposal.md"), files.proposal);
	if (files.tasks !== undefined)
		fs.writeFileSync(path.join(dir, "tasks.md"), files.tasks);
}

test("one row per active change: title, task progress, path and no content", () => {
	const root = createTempRepoFixture("openspec-changes-", repoPreset.readme);
	writeChange(root, "add-flag", {
		proposal: "# Add the flag\n\nA long prose body that must not be listed.\n",
		tasks: "## 1. Work\n\n- [x] 1.1 Read\n- [ ] 1.2 Write\n",
	});
	writeChange(root, "bare-change");
	// An archived change is history, never a row.
	writeChange(root, path.join("archive", "old-change"), {
		proposal: "# Old\n",
	});
	const rows = listOpenSpecChanges(root);
	expect(rows.map((row) => row.changeId)).toEqual(["add-flag", "bare-change"]);
	expect(rows[0]).toEqual({
		changeId: "add-flag",
		title: "Add the flag",
		tasks: "1/2",
		path: "openspec/changes/add-flag",
	});
	// A change with no artifact is a row with less information, not a failure,
	// and no row ever carries file content.
	expect(rows[1]).toEqual({
		changeId: "bare-change",
		path: "openspec/changes/bare-change",
	});
	expect(JSON.stringify(rows)).not.toContain("prose");
});

test("a repository without openspec/changes lists nothing", async () => {
	const root = createTempRepoFixture(
		"openspec-changes-empty-",
		repoPreset.readme,
	);
	expect(listOpenSpecChanges(root)).toEqual([]);
	expect(
		await runLocalObservation({ kind: "openspec-changes", repo: root }),
	).toEqual([]);
});

test("a change that already has a workflow is marked instead of started twice", () => {
	const root = createTempRepoFixture(
		"openspec-changes-flight-",
		repoPreset.readme,
	);
	writeChange(root, "add-flag", { proposal: "# Add the flag\n" });
	writeChange(root, "other-change", { proposal: "# Other\n" });
	commitRepoFixture(root);
	const profile: ResolvedProfile = {
		name: "fake",
		runtime: "pi-durable",
		executable: process.execPath,
		tools: [],
		extensions: [],
		readOnly: false,
		capabilities: ["prompt", "run-environment", "observe"],
		digest: "fake",
	};
	const routing: WorkflowRouting = {
		defaultProfile: "fake",
		routes: [{ stepId: "core.implementation", profile }],
	};
	const engine = new WorkflowEngine(registerBuiltins());
	engine.start({
		repo: root,
		workflowId: "add-flag",
		definitionId: "solo",
		definitionVersion: definitionVersionForStepRouting(6),
		metadata: {
			branch: "main",
			baseBranch: "main",
			baseCommit: "base",
			task: TASK,
		},
		routing,
	});
	const rows = listOpenSpecChanges(root);
	const inFlight = rows.find((row) => row.changeId === "add-flag");
	expect(inFlight?.workflowId).toBe("add-flag");
	// The status the engine wrote for a freshly started workflow: a row that
	// dropped or renamed the field would otherwise still pass.
	expect(inFlight?.status).toBe("active");
	expect(rows.find((row) => row.changeId === "other-change")).toEqual({
		changeId: "other-change",
		title: "Other",
		path: "openspec/changes/other-change",
	});
});

test("the dashboard's id list is the same listing, and both read a change's artifacts safely", async () => {
	const root = createTempRepoFixture(
		"openspec-changes-shared-",
		repoPreset.readme,
	);
	writeChange(root, "add-flag", { proposal: "# Add the flag\n" });
	writeChange(root, "other-change", { proposal: "# Other\n" });
	writeChange(root, path.join("archive", "old-change"), {
		proposal: "# Old\n",
	});
	// The bare id list the dashboard's new-workflow form reads is the same
	// listing, so the id the model is told to pick from always resolves.
	expect(await runLocalObservation({ kind: "changes", repo: root })).toEqual([
		"add-flag",
		"other-change",
	]);
	// A symlinked artifact is not an artifact: it is refused rather than
	// followed, so a row loses its title instead of reading another file.
	fs.rmSync(
		path.join(root, "openspec", "changes", "other-change", "tasks.md"),
		{
			force: true,
		},
	);
	fs.writeFileSync(path.join(root, "secret.txt"), "- [x] fake\n");
	fs.symlinkSync(
		path.join(root, "secret.txt"),
		path.join(root, "openspec", "changes", "other-change", "tasks.md"),
	);
	const rows = listOpenSpecChanges(root);
	expect(rows.find((row) => row.changeId === "other-change")).toEqual({
		changeId: "other-change",
		title: "Other",
		path: "openspec/changes/other-change",
	});
});

test("a proposal titled by a template section answers no title, and its own heading wins", () => {
	const root = createTempRepoFixture(
		"openspec-changes-title-",
		repoPreset.readme,
	);
	// The OpenSpec template starts at `## Why`: the section name is not a label.
	writeChange(root, "template-only", {
		proposal: "## Why\n\n## What Changes\n",
	});
	writeChange(root, "titled", {
		proposal: "## Why\n\n## What Changes\n\n# Ship the launcher flag\n",
	});
	const rows = listOpenSpecChanges(root);
	expect(rows.find((row) => row.changeId === "template-only")).toEqual({
		changeId: "template-only",
		path: "openspec/changes/template-only",
	});
	expect(rows.find((row) => row.changeId === "titled")?.title).toBe(
		"Ship the launcher flag",
	);
});

test("the listing reads at most the requested rows, and is bounded at 100", () => {
	const root = createTempRepoFixture(
		"openspec-changes-limit-",
		repoPreset.readme,
	);
	for (const id of ["a-change", "b-change", "c-change"])
		writeChange(root, id, { proposal: `# ${id}\n` });
	// The slice happens before any artifact is read, so a small poll never pays
	// for the whole directory — and never answers more than the protocol bound.
	expect(listOpenSpecChanges(root, 2).map((row) => row.changeId)).toEqual([
		"a-change",
		"b-change",
	]);
	expect(listOpenSpecChanges(root, 500)).toHaveLength(3);
});

test("the listing is bounded: at most 100 rows, and a title at most 80 characters", () => {
	const root = createTempRepoFixture(
		"openspec-changes-bound-",
		repoPreset.readme,
	);
	for (let index = 0; index < 105; index++)
		writeChange(root, `change-${String(index).padStart(3, "0")}`, {
			proposal: `# ${"T".repeat(200)}\n`,
		});
	const rows = listOpenSpecChanges(root);
	expect(rows).toHaveLength(100);
	expect(String(rows[0]?.title).length).toBe(80);
});

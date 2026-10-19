// Task references at the start boundary (efficiency backlog item 21): a start
// that references an OpenSpec change instead of re-typing its prose. The
// resolver reads the repository's `openspec/changes` directory only, resolves
// one change and refuses everything else in one bounded line — a reference that
// quietly resolved to the wrong change (or to nothing) would be worse than the
// text it replaces.
import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
	discoverChangeIds,
	resolveTaskReference,
	TASK_CHAR_BOUND,
	validateStart,
} from "../src/workflow/startup.ts";
import {
	autoRemoveRepoFixtures,
	createTempRepoFixture,
	repoPreset,
} from "./support/git-fixture.ts";

autoRemoveRepoFixtures();

const PROPOSAL = `# Add the flag

## Why

The flag is missing and the operator needs it.

## What Changes

- One flag, one default.

## Impact

The launcher and the guard.
`;

const TASKS = `## 1. Work

- [x] 1.1 Read the guard
- [ ] 1.2 Add the flag
`;

/** A repository with two active changes and one archived change. */
function repoWithChanges(): string {
	const root = createTempRepoFixture("task-reference-", repoPreset.readme);
	for (const id of ["add-flag", "add-flag-two"]) {
		const dir = path.join(root, "openspec", "changes", id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "proposal.md"), PROPOSAL);
		fs.writeFileSync(path.join(dir, "tasks.md"), TASKS);
	}
	const archived = path.join(root, "openspec", "changes", "archive", "old");
	fs.mkdirSync(archived, { recursive: true });
	fs.writeFileSync(path.join(archived, "proposal.md"), PROPOSAL);
	return root;
}

test("a change id resolves to its proposal sections and its checkbox list", () => {
	const root = repoWithChanges();
	const resolved = resolveTaskReference(root, "add-flag");
	expect(resolved.change).toBe("add-flag");
	expect(resolved.truncated).toEqual([]);
	// Whole `##` sections in file order, the preamble (the title) left out, then
	// the tasks file's checkbox lines.
	const why = resolved.task.indexOf("## Why");
	const changes = resolved.task.indexOf("## What Changes");
	const impact = resolved.task.indexOf("## Impact");
	const tasks = resolved.task.indexOf("- [x] 1.1 Read the guard");
	expect(why).toBeGreaterThanOrEqual(0);
	expect(changes).toBeGreaterThan(why);
	expect(impact).toBeGreaterThan(changes);
	expect(tasks).toBeGreaterThan(impact);
	expect(resolved.task).toContain("- [ ] 1.2 Add the flag");
	expect(resolved.task).not.toContain("# Add the flag");
});

test("a path inside openspec/changes resolves, and the archive does not", () => {
	const root = repoWithChanges();
	expect(
		resolveTaskReference(root, "openspec/changes/add-flag-two").change,
	).toBe("add-flag-two");
	expect(
		resolveTaskReference(
			root,
			path.join(root, "openspec", "changes", "add-flag"),
		).change,
	).toBe("add-flag");
	expect(() =>
		resolveTaskReference(root, "openspec/changes/archive/old"),
	).toThrow(/archived change is history/);
	// A path is normalised before the containment check, so a `..` that stays
	// inside openspec/changes names a change and one that leaves it is refused.
	expect(
		resolveTaskReference(root, "openspec/changes/add-flag/../add-flag-two")
			.change,
	).toBe("add-flag-two");
	expect(() =>
		resolveTaskReference(root, "openspec/changes/../../../elsewhere"),
	).toThrow(/must point inside openspec\/changes/);
	expect(() => resolveTaskReference(root, "../elsewhere")).toThrow(
		/must point inside openspec\/changes/,
	);
	expect(() => resolveTaskReference(root, "openspec/changes")).toThrow(
		/must point inside openspec\/changes/,
	);
});

test("an ambiguous prefix is refused with the matches, an unknown id with candidates", () => {
	const root = repoWithChanges();
	// `add-flag` is an exact id, so only a reference that is a prefix of both
	// changes is ambiguous.
	expect(() => resolveTaskReference(root, "add-fla")).toThrow(
		/is ambiguous in .*add-flag, add-flag-two/s,
	);
	expect(() => resolveTaskReference(root, "add-nothing-like-this")).toThrow(
		/matches no active OpenSpec change/,
	);
});

test("the closest-id ranking answers the corpus's wrong id with the real one", () => {
	const root = createTempRepoFixture("task-reference-rank-", repoPreset.readme);
	for (const id of [
		"add-environment-instance-lifecycle",
		"add-subscription-cleanup",
	])
		fs.mkdirSync(path.join(root, "openspec", "changes", id), {
			recursive: true,
		});
	fs.writeFileSync(
		path.join(
			root,
			"openspec",
			"changes",
			"add-environment-instance-lifecycle",
			"proposal.md",
		),
		PROPOSAL,
	);
	let message = "";
	try {
		resolveTaskReference(root, "add-environment-instances");
	} catch (error) {
		message = (error as Error).message;
	}
	expect(message).toStartWith(
		'task reference "add-environment-instances" matches no active OpenSpec change',
	);
	expect(message).toContain("add-environment-instance-lifecycle");
});

test("a change too large for the task bound drops whole sections and marks it", () => {
	const root = createTempRepoFixture("task-reference-big-", repoPreset.readme);
	const dir = path.join(root, "openspec", "changes", "big-change");
	fs.mkdirSync(dir, { recursive: true });
	const sections = ["## Why", "B".repeat(1_000)];
	for (let index = 0; index < 40; index++)
		sections.push(`## Section ${index}`, "C".repeat(1_000));
	fs.writeFileSync(path.join(dir, "proposal.md"), `${sections.join("\n\n")}\n`);
	fs.writeFileSync(path.join(dir, "tasks.md"), TASKS);
	const resolved = resolveTaskReference(root, "big-change");
	expect(resolved.task.length).toBeLessThanOrEqual(TASK_CHAR_BOUND);
	expect(resolved.truncated.length).toBeGreaterThan(0);
	// The marker names a section that was dropped whole, so a missing constraint
	// is visible instead of hidden by a mid-sentence cut.
	expect(resolved.task).toMatch(/\[task truncated: .*Section \d+/);
	// A dropped section is absent whole: no half-section survives.
	expect(resolved.task).not.toContain("## Section 39");
});

test("a reference is refused for an empty reference and a repository without changes", () => {
	const root = createTempRepoFixture(
		"task-reference-empty-",
		repoPreset.readme,
	);
	expect(() => resolveTaskReference(root, "   ")).toThrow(
		/task reference is empty/,
	);
	expect(() => resolveTaskReference(root, "add-flag")).toThrow(
		/no active OpenSpec changes/,
	);
	expect(discoverChangeIds(root)).toEqual([]);
	expect(() => resolveTaskReference("", "add-flag")).toThrow(
		/needs a repository/,
	);
});

test("a dirty tree refuses the start with the dirty paths, bounded", () => {
	const root = createTempRepoFixture(
		"task-reference-dirty-",
		repoPreset.readme,
	);
	for (let index = 0; index < 23; index++)
		fs.writeFileSync(
			path.join(root, `dirty-${String(index).padStart(2, "0")}.txt`),
			"dirty\n",
		);
	let message = "";
	try {
		validateStart(root, "solo-dirty", "solo", "add a flag");
	} catch (error) {
		message = (error as Error).message;
	}
	expect(message).toMatch(
		/working tree must be clean before workflow start: 23 dirty path\(s\): dirty-00\.txt, dirty-01\.txt, .*\(\+3 more\)/,
	);
	expect(message).toContain("dirty-19.txt");
	expect(message).not.toContain("dirty-20.txt");
	// No file content, ever: the refusal is the paths and a count.
	expect(message).not.toContain("dirty\n");
});

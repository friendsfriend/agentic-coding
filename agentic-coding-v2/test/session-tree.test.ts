import { expect, test } from "bun:test";
import type { Session } from "../src/protocol/index.ts";
import { sessionTree } from "../src/tui/shell/session-tree.ts";

const sessions: Session[] = [
	{ id: 1, parent: null, task: null, title: "Payments", writable: true },
	{
		id: 2,
		parent: null,
		spawnedBy: 1,
		task: null,
		title: "openspec-workflow",
		branch: "feature/new-verification",
		writable: true,
	},
	{ id: 3, parent: 2, task: 30, title: "apply task", writable: false },
	{ id: 4, parent: 2, task: 40, title: "verify task", writable: true },
	{ id: 5, parent: 4, task: 50, title: "security task", writable: true },
	{ id: 6, parent: 4, task: 60, title: "quality task", writable: false },
	{ id: 7, parent: null, task: null, title: "Other project", writable: true },
];
const tasks = [
	{
		id: 30,
		skill: "openspec-apply-change",
		status: "terminal",
		result: { status: "completed" },
	},
	{ id: 40, skill: "verify-workflow", status: "waiting" },
	{ id: 50, skill: "security-verifier", status: "running" },
	{
		id: 60,
		skill: "code-quality-verifier",
		status: "terminal",
		result: { status: "failed" },
	},
];

test("sidebar follows visual workflow lineage and arbitrarily nested task ownership", () => {
	const rows = sessionTree(sessions, tasks, [], new Set());
	expect(rows.map((row) => row.value)).toEqual(
		[1, 2, 3, 4, 5, 6, 7].map((id) => `session:${id}`),
	);
	expect(rows[1].tree?.parent).toBe("session:1");
	// Child junctions sit under the parent's disclosure, not one column farther
	// right per level. Expanded parent detail rows continue into their children.
	expect(rows[3].tree?.continuation).toBe("    │ ");
	expect(rows[4].tree?.prefix.indexOf("├")).toBe(rows[3].tree?.prefix.length);
	expect(rows[5].tree?.continuation.trim()).toBe("");
	expect(rows[4]).toMatchObject({
		name: "Security",
		tone: "accent",
		tree: { parent: "session:4", prefix: "    ├─", continuation: "    │   " },
	});
	expect(rows[2]).toMatchObject({ name: "Apply", glyph: "✓", tone: "success" });
	expect(rows[5]).toMatchObject({
		name: "Code quality",
		glyph: "!",
		tone: "error",
	});
	const folded = sessionTree(sessions, tasks, [], new Set([2]));
	expect(folded.map((row) => row.value)).toEqual([
		"session:1",
		"session:2",
		"session:7",
	]);
	expect(folded[1]).toMatchObject({
		tone: "warning",
		tree: { collapsed: true, summary: "1 running · 1 attention" },
	});
});

test("legacy and orphaned workflows remain visible without inventing a project relationship", () => {
	const orphan = { ...sessions[1], spawnedBy: 999 };
	const rows = sessionTree(
		[orphan, sessions[3], sessions[4]],
		tasks,
		[],
		new Set(),
	);
	expect(rows.map((row) => row.value)).toEqual([
		"session:2",
		"session:4",
		"session:5",
	]);
	expect(rows[0].tree?.parent).toBeUndefined();
	expect(rows[0].tone).toBe("accent");
	expect(
		sessionTree([{ ...sessions[1], spawnedBy: undefined }], [], [], new Set()),
	).toHaveLength(1);
});

/** @jsxImportSource @opentui/solid */
// The changed-files table's shared-infrastructure column
// (`add-environment-setup-workflow`, the approval gate's flag): the flag has its
// own column instead of extending the path, so it survives the truncation the
// file list applies and the path stays the anchor identity comments match on.
import { expect, test } from "bun:test";
import { ChangedFilesView } from "@agentic-coding/ui";
import { type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

const CHANGE = {
	old_path: "apps/compose/shop-compose.yml",
	new_path: "apps/compose/shop-compose.yml",
	a_mode: "100644",
	b_mode: "100644",
	new_file: false,
	renamed_file: false,
	deleted_file: false,
	diff: "",
	lines_added: 1,
	lines_deleted: 1,
	review_finding_count: 0,
	affects_all_apps: false,
};

const SHARED = {
	...CHANGE,
	old_path: "infrastructure/definitions/postgres.json",
	new_path: "infrastructure/definitions/postgres.json",
	affects_all_apps: true,
};

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("changed-file rows retain native fields while counts, flags and order refresh", async () => {
	const [changes, setChanges] = createSignal([
		CHANGE,
		{
			...CHANGE,
			old_path: "second.ts",
			new_path: "second.ts",
			lines_added: 2,
			lines_deleted: 0,
		},
	]);
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<ChangedFilesView
				changes={changes()}
				selectedIndex={selected()}
				onClose={() => {}}
				findings
				availableLines={20}
			/>
		),
		{ width: 120, height: 30 },
	);
	try {
		await t.flush();
		const path = tree(t.renderer.root).find(
			(node) =>
				node instanceof TextRenderable && node.plainText === CHANGE.new_path,
		);
		const stats = tree(t.renderer.root).find(
			(node) => node instanceof TextRenderable && node.plainText === "+1 -1",
		);
		if (!(path instanceof TextRenderable) || !(stats instanceof TextRenderable))
			throw new Error("Missing file-row fields");
		const row = stats.parent?.parent?.parent;
		if (!row) throw new Error("Missing file-row surface");
		setChanges((current) =>
			current.map((change) => ({
				...change,
				...(change.new_path === CHANGE.new_path
					? {
							lines_added: 7,
							lines_deleted: 4,
							affects_all_apps: true,
							review_finding_count: 3,
							new_file: true,
						}
					: {}),
			})),
		);
		await t.renderOnce();
		expect(path.isDestroyed).toBe(false);
		expect(stats.isDestroyed).toBe(false);
		expect(row.isDestroyed).toBe(false);
		expect(stats.plainText).toBe("+7 -4");
		expect(t.captureCharFrame()).toContain("Shared");
		expect(t.captureCharFrame()).toContain("shared");
		const painted = t
			.captureCharFrame()
			.split("\n")
			.find((line) => line.includes(CHANGE.new_path));
		expect(painted).toMatch(/shared\s+3\s*$/);
		setChanges((current) =>
			[...current].reverse().map((change) => ({ ...change })),
		);
		setSelected(1);
		await t.renderOnce();
		expect(path.isDestroyed).toBe(false);
		expect(stats.isDestroyed).toBe(false);
		expect(row.isDestroyed).toBe(false);
		expect(path.plainText).toBe(CHANGE.new_path);
		setChanges((current) =>
			current.map((change) =>
				change.new_path === CHANGE.new_path
					? {
							...change,
							old_path: CHANGE.new_path,
							new_path: "renamed.ts",
							renamed_file: true,
							new_file: false,
						}
					: change,
			),
		);
		await t.renderOnce();
		expect(path.isDestroyed).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});

test("a shared-infrastructure change gets its own column beside the path", async () => {
	const t = await testRender(
		() => (
			<ChangedFilesView
				changes={[CHANGE, SHARED]}
				selectedIndex={0}
				onClose={() => {}}
				findings
				availableLines={20}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Shared");
	expect(frame).toContain("shared");
	// The path itself stays raw, so a comment anchored to it still matches.
	expect(frame).toContain("infrastructure/definitions/postgres.json");
	expect(frame).not.toContain("affects all apps");
	t.renderer.destroy();
});

test("no shared column is rendered when no change carries the flag", async () => {
	const t = await testRender(
		() => (
			<ChangedFilesView
				changes={[CHANGE]}
				selectedIndex={0}
				onClose={() => {}}
				findings
				availableLines={20}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Shared");
	t.renderer.destroy();
});

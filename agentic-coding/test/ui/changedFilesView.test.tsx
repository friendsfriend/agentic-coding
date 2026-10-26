/** @jsxImportSource @opentui/solid */
// The changed-files table's shared-infrastructure column
// (`add-environment-setup-workflow`, the approval gate's flag): the flag has its
// own column instead of extending the path, so it survives the truncation the
// file list applies and the path stays the anchor identity comments match on.
import { expect, test } from "bun:test";
import { ChangedFilesView } from "@agentic-coding/ui";
import { testRender } from "@opentui/solid";

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

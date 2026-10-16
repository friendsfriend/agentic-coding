/** @jsxImportSource @opentui/solid */
// Review viewers and the pointer (`tui-clipboard-copy`): a block or line row
// selects on a tap, and a drag — the gesture that selects text for copy, and
// whose release lands wherever the drag ended — changes nothing.
import { expect, spyOn, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { DiffReviewView, MarkdownReviewView } from "@ui";
import { createSignal } from "solid-js";

test("a markdown review block selects on a tap and a drag changes nothing", async () => {
	const changed = { line: (_line: number) => {} };
	const change = spyOn(changed, "line");
	const [selected, setSelected] = createSignal(0);
	const t = await testRender(
		() => (
			<MarkdownReviewView
				filePath="docs/note.md"
				content={"# Title\n\nFirst body line\n\nSecond body line\n"}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={selected()}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={(line) => {
					changed.line(line);
					setSelected(line);
				}}
				onClose={() => {}}
			/>
		),
		{ width: 80, height: 20 },
	);
	await t.flush();
	// The dialog's own rows: title, the file header, then one row per markdown
	// block (blank source lines are skipped, so the blocks sit at 4, 5, 6).
	const bodyY = 5;
	// A tap on the block row selects it.
	await t.mockMouse.click(20, bodyY);
	await t.flush();
	const afterTap = change.mock.calls.length;
	expect(afterTap).toBeGreaterThan(0);
	const tappedBlock = change.mock.calls.at(-1)?.[0] ?? -1;
	expect(tappedBlock).toBeGreaterThanOrEqual(0);
	// Tapping the same block again reports the same line, and the block below it
	// reports a later one: the hit test follows the row under the pointer.
	await t.mockMouse.click(20, bodyY);
	await t.flush();
	expect(change.mock.calls.at(-1)?.[0]).toBe(tappedBlock);
	await t.mockMouse.click(20, bodyY + 1);
	await t.flush();
	expect(change.mock.calls.at(-1)?.[0]).toBeGreaterThan(tappedBlock);
	// A drag across two rows is text selection: the review's target line stays.
	const beforeDrag = change.mock.calls.length;
	await t.mockMouse.drag(20, bodyY, 20, bodyY + 2);
	await t.flush();
	expect(change.mock.calls.length).toBe(beforeDrag);
	t.renderer.destroy();
});

test("a diff review line selects on a tap and a drag changes nothing", async () => {
	const changed = { line: (_line: number) => {} };
	const change = spyOn(changed, "line");
	const [selected, setSelected] = createSignal(0);
	const diff = [
		"@@ -1,3 +1,4 @@",
		" context line",
		"-removed line",
		"+added line",
		"+second added line",
	].join("\n");
	const t = await testRender(
		() => (
			<DiffReviewView
				filePath="src/example.ts"
				diff={diff}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={selected()}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				onSelectedLineChange={(line) => {
					changed.line(line);
					setSelected(line);
				}}
				onClose={() => {}}
			/>
		),
		{ width: 100, height: 24 },
	);
	await t.flush();
	const lines = t.captureCharFrame().split("\n");
	const addedY = lines.findIndex((line) => line.includes("added line"));
	expect(addedY).toBeGreaterThan(0);
	// A tap on a diff line moves the review's controlled selection.
	await t.mockMouse.click(30, addedY);
	await t.flush();
	const afterTap = change.mock.calls.length;
	expect(afterTap).toBeGreaterThan(0);
	const tappedLine = change.mock.calls.at(-1)?.[0] ?? -1;
	expect(tappedLine).toBeGreaterThanOrEqual(0);
	// Repeating the tap reports the same line, and the line below reports a later
	// one: the hit test follows the row under the pointer, not the row above it.
	await t.mockMouse.click(30, addedY);
	await t.flush();
	expect(change.mock.calls.at(-1)?.[0]).toBe(tappedLine);
	await t.mockMouse.click(30, addedY + 1);
	await t.flush();
	expect(change.mock.calls.at(-1)?.[0]).toBeGreaterThan(tappedLine);
	// A drag across two lines is text selection (the copy gesture): the review's
	// target line must not follow the release.
	const beforeDrag = change.mock.calls.length;
	await t.mockMouse.drag(30, addedY, 30, addedY + 1);
	await t.flush();
	expect(change.mock.calls.length).toBe(beforeDrag);
	t.renderer.destroy();
});

/** @jsxImportSource @opentui/solid */
/** Diff review viewport: the scroll position must track the selected line.
 *
 * The dashboard re-reads the review file list about once a second, and any
 * change to the open file's view model re-creates the diff rows. Re-created
 * rows have no geometry until the next frame lays them out, so an auto-scroll
 * that only runs inside the reactive effect measured nothing and the viewport
 * stayed at the top of the file with the selected line far below it.
 */
import { expect, test } from "bun:test";
import type { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import type { Discussion } from "@ui";
import { DiffReviewView } from "@ui";
import { createMemo, createSignal, Show } from "solid-js";

type TestView = Awaited<ReturnType<typeof testRender>>;

const LINE_COUNT = 300;
const SELECTED_LINE = 200;
const DIFF = [
	"--- a/file.ts",
	"+++ b/file.ts",
	`@@ -1,${String(LINE_COUNT)} +1,${String(LINE_COUNT)} @@`,
	...Array.from(
		{ length: LINE_COUNT },
		(_v, index) => `+line ${String(index)}`,
	),
].join("\n");

const NO_DISCUSSIONS: Discussion[] = [];

interface ReviewFile {
	new_path: string;
	diff: string;
	new_file: boolean;
	deleted_file: boolean;
}

/**
 * Poll with a real `setTimeout` between renders: the auto-scroll retry runs on
 * a macrotask after the re-created rows are laid out, so the frame has to be
 * pumped for the position to settle.
 */
async function settle(
	view: TestView,
	scrollBox: () => ScrollBoxRenderable | undefined,
	timeoutMs = 5000,
) {
	const start = Date.now();
	let last = scrollBox()?.scrollTop ?? 0;
	while (Date.now() - start < timeoutMs) {
		await view.renderOnce();
		await new Promise((resolve) => setTimeout(resolve, 10));
		const current = scrollBox()?.scrollTop ?? 0;
		if (current === last) return current;
		last = current;
	}
	return last;
}

test("the diff viewport opens on the selected line, not the top of the file", async () => {
	let scrollBox: ScrollBoxRenderable | undefined;
	const view = await testRender(
		() => (
			<DiffReviewView
				filePath="file.ts"
				diff={DIFF}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={SELECTED_LINE}
				visualModeActive={false}
				visualModeStart={0}
				forceSplitView={false}
				commentMode={false}
				commentText=""
				discussions={NO_DISCUSSIONS}
				onSelectedLineChange={() => {}}
				onScrollBoxReady={(box) => {
					scrollBox = box;
				}}
				onClose={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	const scrollTop = await settle(view, () => scrollBox);
	expect(scrollTop).toBeGreaterThan(0);
	// The selected row is inside the viewport, not merely somewhere below it.
	const rows = scrollBox?.getChildren()[0]?.getChildren() ?? [];
	const selected = rows.find(
		(row) => row.id === `line-${String(SELECTED_LINE)}`,
	);
	const viewport = scrollBox?.viewport;
	expect(selected?.y).toBeGreaterThanOrEqual(viewport?.y ?? 0);
	expect(selected?.y).toBeLessThanOrEqual(
		(viewport?.y ?? 0) + (viewport?.height ?? 0),
	);
	view.renderer.destroy();
});

test("the diff viewport stays on the selected line across background refreshes", async () => {
	const [refresh, setRefresh] = createSignal(0);
	// Mirrors the review route's per-file view model: the background refresh
	// hands the open diff a new object, which re-creates every diff row.
	const file = createMemo(() => {
		refresh();
		return {
			new_path: "file.ts",
			diff: DIFF,
			new_file: false,
			deleted_file: false,
		} satisfies ReviewFile;
	});
	let scrollBox: ScrollBoxRenderable | undefined;
	const view = await testRender(
		() => (
			<Show when={file()}>
				{(current) => (
					<DiffReviewView
						filePath={current().new_path}
						diff={current().diff}
						currentFileIndex={0}
						totalFiles={1}
						selectedLine={SELECTED_LINE}
						visualModeActive={false}
						visualModeStart={0}
						forceSplitView={false}
						commentMode={false}
						commentText=""
						discussions={NO_DISCUSSIONS}
						onSelectedLineChange={() => {}}
						onScrollBoxReady={(box) => {
							scrollBox = box;
						}}
						onClose={() => {}}
					/>
				)}
			</Show>
		),
		{ width: 100, height: 30 },
	);
	const opening = await settle(view, () => scrollBox);
	expect(opening).toBeGreaterThan(0);

	for (const tick of [1, 2, 3]) {
		setRefresh(tick);
		await view.flush();
		const settled = await settle(view, () => scrollBox);
		expect(settled).toBe(opening);
	}
	view.renderer.destroy();
});

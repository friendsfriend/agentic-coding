/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Discussion } from "@ui";
import { DiffReviewView, MarkdownReviewView } from "@ui";

type TestView = Awaited<ReturnType<typeof testRender>>;

/**
 * Background of the two-column left-edge selection mark on the first row whose
 * text contains `text`. The mark is a distinct span, so an unmarked row
 * returns `undefined`.
 */
function markerBackground(view: TestView, text: string) {
	const line = view.captureSpans().lines.find((candidate) =>
		candidate.spans
			.map((span) => span.text)
			.join("")
			.includes(text),
	);
	return line?.spans.find((span) => span.text === "  ")?.bg?.toInts();
}

/**
 * Markdown blocks paint their text through a background worker, so the styled
 * spans can lag the char frame. Poll with a real `setTimeout` until the
 * predicate sees the rendered spans (same reason as `markdownViewModal`).
 */
async function waitForSpans(
	view: TestView,
	predicate: (view: TestView) => boolean,
	timeoutMs = 5000,
) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await view.renderOnce();
		if (predicate(view)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for spans");
}

function comment(
	newLine: number,
	body: string,
	filePath = "file.ts",
): Discussion {
	return {
		id: `comment-${String(newLine)}`,
		individual_note: true,
		position: {
			base_sha: "",
			start_sha: "",
			head_sha: "",
			old_path: filePath,
			new_path: filePath,
			position_type: "text",
			new_line: newLine,
		},
		notes: [
			{
				id: 1,
				type: "DiffNote",
				body,
				author: { name: "Developer" },
				created_at: new Date(0).toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
			},
		],
	};
}

const DIFF = [
	"--- a/file.ts",
	"+++ b/file.ts",
	"@@ -1,3 +1,4 @@",
	" context one",
	"-old line",
	"+new line",
	"+extra line",
].join("\n");

function DiffFixture(props: {
	selectedLine: number;
	forceSplitView: boolean;
	discussions: Discussion[];
	visualModeActive?: boolean;
	visualModeStart?: number;
}) {
	return (
		<DiffReviewView
			filePath="file.ts"
			diff={DIFF}
			currentFileIndex={0}
			totalFiles={1}
			selectedLine={props.selectedLine}
			visualModeActive={props.visualModeActive ?? false}
			visualModeStart={props.visualModeStart ?? 0}
			forceSplitView={props.forceSplitView}
			commentMode={false}
			commentText=""
			discussions={props.discussions}
			onSelectedLineChange={() => {}}
			onClose={() => {}}
		/>
	);
}

test("diff view marks the comment thread anchored to the selected line", async () => {
	const view = await testRender(
		() => (
			<DiffFixture
				selectedLine={3}
				forceSplitView={false}
				discussions={[comment(3, "please rename")]}
			/>
		),
		{ width: 80, height: 30 },
	);
	await view.flush();
	// The thread shares the accent mark with the selected `extra line` row.
	const marked = markerBackground(view, "please rename");
	expect(marked).toBeDefined();
	expect(marked).toEqual(markerBackground(view, "extra line"));
	view.renderer.destroy();

	const unselected = await testRender(
		() => (
			<DiffFixture
				selectedLine={0}
				forceSplitView={false}
				discussions={[comment(3, "please rename")]}
			/>
		),
		{ width: 80, height: 30 },
	);
	await unselected.flush();
	expect(markerBackground(unselected, "please rename")).toBeUndefined();
	unselected.renderer.destroy();
});

test("split diff view marks the comment thread anchored to the selected row", async () => {
	const view = await testRender(
		() => (
			<DiffFixture
				selectedLine={2}
				forceSplitView
				discussions={[comment(3, "please rename")]}
			/>
		),
		{ width: 100, height: 30 },
	);
	await view.flush();
	const marked = markerBackground(view, "please rename");
	expect(marked).toBeDefined();
	expect(marked).toEqual(markerBackground(view, "extra line"));
	view.renderer.destroy();

	const unselected = await testRender(
		() => (
			<DiffFixture
				selectedLine={0}
				forceSplitView
				discussions={[comment(3, "please rename")]}
			/>
		),
		{ width: 100, height: 30 },
	);
	await unselected.flush();
	expect(markerBackground(unselected, "please rename")).toBeUndefined();
	unselected.renderer.destroy();
});

for (const forceSplitView of [false, true]) {
	test(`${forceSplitView ? "split " : ""}diff view marks an in-range comment thread with the range paint`, async () => {
		// The cursor stays on `context one` (index 0) while the visual range
		// reaches the commented `extra line` row (index 3 unified / 2 split), so
		// the thread mirrors its row's range paint, not the cursor accent.
		const threadIndex = forceSplitView ? 2 : 3;
		const view = await testRender(
			() => (
				<DiffFixture
					selectedLine={0}
					visualModeActive
					visualModeStart={threadIndex}
					forceSplitView={forceSplitView}
					discussions={[comment(3, "please rename")]}
				/>
			),
			{ width: forceSplitView ? 100 : 80, height: 30 },
		);
		await view.flush();
		const threadMark = markerBackground(view, "please rename");
		expect(threadMark).toBeDefined();
		expect(threadMark).toEqual(markerBackground(view, "extra line"));
		expect(threadMark).not.toEqual(markerBackground(view, "context one"));
		view.renderer.destroy();
	});
}

const ARTIFACT = `# Proposal

Make the plan review modal-based.

## What changes

- item one
- item two
`;

test("markdown view marks the comment thread anchored to the selected block", async () => {
	const view = await testRender(
		() => (
			<MarkdownReviewView
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={3}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				discussions={[comment(7, "add a diagram")]}
				onSelectedLineChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 80, height: 40 },
	);
	await view.flush();
	// The list block (index 3) spans lines 7-8 and owns the anchored comment.
	await waitForSpans(
		view,
		(candidate) => markerBackground(candidate, "item one") !== undefined,
	);
	const marked = markerBackground(view, "add a diagram");
	expect(marked).toBeDefined();
	expect(marked).toEqual(markerBackground(view, "item one"));
	view.renderer.destroy();

	const unselected = await testRender(
		() => (
			<MarkdownReviewView
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={0}
				visualModeActive={false}
				visualModeStart={0}
				commentMode={false}
				commentText=""
				discussions={[comment(7, "add a diagram")]}
				onSelectedLineChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 80, height: 40 },
	);
	await unselected.flush();
	expect(markerBackground(unselected, "add a diagram")).toBeUndefined();
	unselected.renderer.destroy();
});

test("markdown-rendered diff marks the comment thread on the selected block", async () => {
	const wikiDiff =
		"--- a/projects/demo/wiki.md\n+++ b/projects/demo/wiki.md\n@@ -1,2 +1,2 @@\n-# Old title\n+# New title\n";
	const view = await testRender(
		() => (
			<DiffReviewView
				filePath="projects/demo/wiki.md"
				diff={wikiDiff}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={1}
				visualModeActive={false}
				visualModeStart={0}
				forceSplitView={false}
				currentSideOnly
				renderMarkdown
				commentMode={false}
				commentText=""
				discussions={[comment(1, "please reword", "projects/demo/wiki.md")]}
				onSelectedLineChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 90, height: 30 },
	);
	await view.flush();
	// The removed `Old title` unit is index 0; the added heading block is 1.
	expect(markerBackground(view, "please reword")).toBeDefined();
	view.renderer.destroy();

	const unselected = await testRender(
		() => (
			<DiffReviewView
				filePath="projects/demo/wiki.md"
				diff={wikiDiff}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={0}
				visualModeActive={false}
				visualModeStart={0}
				forceSplitView={false}
				currentSideOnly
				renderMarkdown
				commentMode={false}
				commentText=""
				discussions={[comment(1, "please reword", "projects/demo/wiki.md")]}
				onSelectedLineChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 90, height: 30 },
	);
	await unselected.flush();
	expect(markerBackground(unselected, "please reword")).toBeUndefined();
	unselected.renderer.destroy();
});

test("markdown view marks an in-range comment thread with the range paint", async () => {
	const view = await testRender(
		() => (
			<MarkdownReviewView
				filePath="proposal.md"
				content={ARTIFACT}
				currentFileIndex={0}
				totalFiles={1}
				selectedLine={0}
				visualModeActive
				visualModeStart={3}
				commentMode={false}
				commentText=""
				discussions={[comment(7, "add a diagram")]}
				onSelectedLineChange={() => {}}
				onClose={() => {}}
			/>
		),
		{ width: 80, height: 40 },
	);
	await view.flush();
	// Cursor stays on block 0 while the range (0..3) includes the commented
	// list block (index 3), so the thread mirrors the range paint.
	await waitForSpans(
		view,
		(candidate) => markerBackground(candidate, "item one") !== undefined,
	);
	const threadMark = markerBackground(view, "add a diagram");
	expect(threadMark).toBeDefined();
	expect(threadMark).toEqual(markerBackground(view, "item one"));
	view.renderer.destroy();
});

/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Discussion } from "@ui";
import { DiffReviewView } from "@ui";

type TestView = Awaited<ReturnType<typeof testRender>>;

/**
 * The markdown renderable paints through a background worker, so the char
 * frame lags the first layout pass. Poll until `predicate` sees the frame.
 */
async function waitForFrame(
	view: TestView,
	predicate: (frame: string) => boolean,
	timeoutMs = 5000,
) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await view.renderOnce();
		const frame = view.captureCharFrame();
		if (predicate(frame)) return frame;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for frame: ${view.captureCharFrame()}`);
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

const MARKDOWN_BODY =
	"## Unsafe input\n\n- **User input** reaches the query.\n\nUse `parseInput()` first.\n";

function thread(body: string, findingId?: string): Discussion {
	return {
		id: findingId ? `finding-${findingId}` : "comment-3",
		individual_note: true,
		position: {
			base_sha: "",
			start_sha: "",
			head_sha: "",
			old_path: "file.ts",
			new_path: "file.ts",
			position_type: "text",
			new_line: 3,
		},
		...(findingId ? { findingId, findingSeverity: "warning" } : {}),
		notes: [
			{
				id: 1,
				type: "DiffNote",
				body,
				author: { name: findingId ? "security-verifier" : "Developer" },
				created_at: new Date(0).toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
			},
		],
	};
}

function DiffFixture(props: {
	forceSplitView: boolean;
	discussion: Discussion;
}) {
	return (
		<DiffReviewView
			filePath="file.ts"
			diff={DIFF}
			currentFileIndex={0}
			totalFiles={1}
			selectedLine={3}
			visualModeActive={false}
			visualModeStart={0}
			forceSplitView={props.forceSplitView}
			commentMode={false}
			commentText=""
			discussions={[props.discussion]}
			onSelectedLineChange={() => {}}
			onClose={() => {}}
		/>
	);
}

/** The wiki review renders its document diff as markdown blocks. */
const WIKI_DIFF = [
	"--- a/projects/demo/wiki.md",
	"+++ b/projects/demo/wiki.md",
	"@@ -1,2 +1,2 @@",
	"-# Old title",
	"+# New title",
].join("\n");

/** A finding anchored to the only block on the new side (the added title). */
function wikiFinding(body: string): Discussion {
	return {
		id: "finding-wiki",
		individual_note: true,
		position: {
			base_sha: "",
			start_sha: "",
			head_sha: "",
			old_path: "projects/demo/wiki.md",
			new_path: "projects/demo/wiki.md",
			position_type: "text",
			new_line: 1,
		},
		findingId: "wiki-1",
		findingSeverity: "warning",
		notes: [
			{
				id: 1,
				type: "DiffNote",
				body,
				author: { name: "security-verifier" },
				created_at: new Date(0).toISOString(),
				updated_at: "",
				system: false,
				resolvable: false,
				resolved: false,
			},
		],
	};
}

function WikiDiffFixture(props: { forceSplitView: boolean }) {
	return (
		<DiffReviewView
			filePath="projects/demo/wiki.md"
			diff={WIKI_DIFF}
			currentFileIndex={0}
			totalFiles={1}
			selectedLine={0}
			visualModeActive={false}
			visualModeStart={0}
			forceSplitView={props.forceSplitView}
			currentSideOnly
			renderMarkdown
			commentMode={false}
			commentText=""
			discussions={[wikiFinding(MARKDOWN_BODY)]}
			onSelectedLineChange={() => {}}
			onClose={() => {}}
		/>
	);
}

for (const forceSplitView of [false, true]) {
	test(`${forceSplitView ? "split " : ""}diff view renders a finding body as markdown`, async () => {
		const view = await testRender(
			() => (
				<DiffFixture
					forceSplitView={forceSplitView}
					discussion={thread(MARKDOWN_BODY, "f1")}
				/>
			),
			{ width: 100, height: 30 },
		);
		await view.flush();
		const frame = await waitForFrame(view, (candidate) =>
			candidate.includes("parseInput()"),
		);
		expect(frame).toContain("FIX");
		expect(frame).toContain("Unsafe input");
		expect(frame).toContain("User input");
		expect(frame).not.toContain("**User input**");
		expect(frame).toContain("parseInput()");
		expect(frame).not.toContain("`parseInput()`");
		view.renderer.destroy();
	});
}

test("diff view keeps a human comment body as plain text", async () => {
	const view = await testRender(
		() => (
			<DiffFixture forceSplitView={false} discussion={thread(MARKDOWN_BODY)} />
		),
		{ width: 100, height: 30 },
	);
	await view.flush();
	const frame = await waitForFrame(view, (candidate) =>
		candidate.includes("Unsafe input"),
	);
	expect(frame).toContain("## Unsafe input");
	expect(frame).toContain("**User input**");
	view.renderer.destroy();
});

for (const forceSplitView of [false, true]) {
	test(`${forceSplitView ? "split " : ""}markdown-rendered wiki diff shows a finding body as markdown`, async () => {
		const view = await testRender(
			() => <WikiDiffFixture forceSplitView={forceSplitView} />,
			{ width: 100, height: 30 },
		);
		await view.flush();
		const frame = await waitForFrame(view, (candidate) =>
			candidate.includes("parseInput()"),
		);
		expect(frame).toContain("New title");
		expect(frame).toContain("FIX");
		expect(frame).toContain("Unsafe input");
		expect(frame).not.toContain("**User input**");
		expect(frame).not.toContain("`parseInput()`");
		view.renderer.destroy();
	});
}

/**
 * One long line, long enough that a terminal-derived width (the old
 * `width - 12`) wraps it wider than the 90%-width modal and clips its tail.
 */
const LONG_BODY =
	"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega end";

test("a finding body wraps inside the modal instead of running past its edge", async () => {
	const view = await testRender(
		() => (
			<DiffFixture
				forceSplitView={false}
				discussion={thread(LONG_BODY, "f1")}
			/>
		),
		{ width: 80, height: 30 },
	);
	await view.flush();
	const frame = await waitForFrame(view, (candidate) =>
		candidate.includes("alpha"),
	);
	// The whole sentence is readable: nothing is cut off at the modal edge.
	expect(frame).toContain("psi omega end");
	// It wrapped inside the modal instead of running on as one over-wide line.
	expect(frame).not.toContain(LONG_BODY);
	view.renderer.destroy();
});

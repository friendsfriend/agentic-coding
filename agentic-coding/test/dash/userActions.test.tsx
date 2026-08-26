/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";

function TestDashboard(props: { noUpstream?: boolean } = {}) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	// Mirror the production detail keymap (src/tui/index.tsx → setupKeymap):
	// shift+letter events resolve to their uppercase binding ("J" ↔ Shift+J).
	const disposeKeymap = keymap.appendEventMatchResolver((event, ctx) => {
		if (
			!event.shift ||
			event.ctrl ||
			event.meta ||
			event.super ||
			event.name.length !== 1
		)
			return undefined;
		const upper = event.name.toUpperCase();
		return upper !== event.name
			? [
					ctx.resolveKey({
						name: upper,
						ctrl: false,
						shift: false,
						meta: false,
						super: false,
					}),
				]
			: undefined;
	});
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(() => {
		disposeKeymap();
		dispose();
	});
	return (
		<App
			repo="/demo"
			change="demo"
			profile="test"
			testNoUpstream={props.noUpstream}
			keymap={keymap}
		/>
	);
}

test("dismissed plan review stays closed during panel interactions", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Interacting with another panel (Shift+J to Current task, then Enter)
	// must not reopen the dismissed plan review.
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Tasks ·");
	expect(frame).not.toContain("Plan review");
	t.renderer.destroy();
});

test("plan review popup appears and executes plan approval via finish", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	// The plan approval user action opens the artifact-list popup directly.
	const actionFrame = await t.waitForFrame((frame) =>
		frame.includes("Plan review"),
	);
	expect(actionFrame).toContain("proposal.md");
	expect(actionFrame).toContain("design.md");
	expect(actionFrame).toContain("tasks.md");
	expect(actionFrame).not.toContain("Approve plan and start implementation");

	// Enter on the artifact row opens the separate markdown modal.
	t.mockInput.pressEnter();
	const markdownFrame = await t.waitForFrame((frame) =>
		frame.includes("# Proposal"),
	);
	expect(markdownFrame).toContain("Make the plan review modal-based.");
	expect(markdownFrame).not.toContain("Changed Files (4 files)");

	// Esc in the markdown modal returns to the artifact-list popup.
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes("Changed Files (4 files)"));

	// f with no comments finishes the plan review: approval is dispatched and
	// the popup closes (demo advances to the implementation phase).
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => !frame.includes("Changed Files (4 files)"));

	// Advance the demo through apply/verify to the developer review.
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("verify"));
	t.mockInput.pressEnter();
	const reviewFrame = await t.waitForFrame((frame) =>
		frame.includes("Changed Files (1 files)"),
	);
	// The developer review user action opens the changed-files popup directly.
	expect(reviewFrame).toContain("Action required · Developer review");
	expect(reviewFrame).not.toContain("Start developer review");
	expect(reviewFrame).toContain("src/example.ts");

	// Enter on the file row opens the diff in the separate diff modal.
	t.mockInput.pressEnter();
	const diffFrame = await t.waitForFrame((frame) =>
		frame.includes("reviewed();"),
	);
	expect(diffFrame).toContain("diff --git a/src/example.ts");
	expect(diffFrame).not.toContain("Changed Files (1 files)");

	// Esc in the diff returns to the files popup.
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => frame.includes("Changed Files (1 files)"));

	// f finishes the review from the popup: approval is dispatched and the
	// popup closes (message state is shell-level, not rendered in this frame).
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => !frame.includes("Changed Files (1 files)"));
	t.renderer.destroy();
});

test("plan review exposes a bounded rejection action", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	const reviewFrame = await t.waitForFrame((frame) =>
		frame.includes("Plan review"),
	);
	expect(reviewFrame).toContain("Reject plan");
	t.mockInput.pressKey("r");
	const rejectionFrame = await t.waitForFrame((frame) =>
		frame.includes("Choose a rejection reason"),
	);
	expect(rejectionFrame).toContain("Needs more detail");
	t.mockInput.pressKey("down");
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => !frame.includes("Choose a rejection reason"));
	t.renderer.destroy();
});

test("overview contains Git status and no Git panel", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((value) => value.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((value) => !value.includes("Plan review"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("GIT STATUS");
	expect(frame).toContain("+0*0-0");
	expect(frame).toContain("↑0");
	expect(frame).toContain("↓0");
	expect(frame).toContain("feature/demo-optional-realisation-date");
	expect(frame).not.toContain("clean ·");

	// Grid round trip Change → Agents → Change → Current task → Change:
	// returning to Change and pressing Enter reopens the plan review.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressKey("h", { shift: true });
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressKey("k", { shift: true });
	t.mockInput.pressEnter();
	await t.waitForFrame((value) => value.includes("Plan review"));
	expect(t.captureCharFrame()).not.toContain(
		"Action required · Developer review",
	);
	t.renderer.destroy();
});

test("overview uses a muted glyph when no upstream is usable", async () => {
	const t = await testRender(() => <TestDashboard noUpstream />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((value) => value.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((value) => !value.includes("Plan review"));
	const frame = t.captureCharFrame();
	expect(frame).toContain("+0*0-0");
	expect(frame).toContain("");
	expect(frame).not.toContain("no upstream");
	expect(frame).not.toContain("↑0");
	expect(frame).not.toContain("↓0");
	expect(frame).toContain("feature/demo-optional-realisation-date");
	t.renderer.destroy();
});

test("overview Git summary stays within the panel at a narrow width", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 50,
		height: 40,
	});

	await t.waitForFrame((value) => value.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((value) => !value.includes("Plan review"));
	const frame = t.captureCharFrame();
	const lines = frame.split("\n");
	expect(lines.every((line) => line.length <= 50)).toBe(true);
	expect(frame).toContain("+0*0-0");
	expect(frame).toContain("↑0");
	t.renderer.destroy();
});

test("plan review comment on a markdown line routes feedback to the planner", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((frame) => frame.includes("Plan review"));

	// Enter opens the markdown modal for the selected artifact.
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("# Proposal"));

	// c starts comment input on the selected line; typing and Enter submit it.
	t.mockInput.pressKey("c");
	await t.renderOnce();
	const commentFrame = t.captureCharFrame();
	expect(commentFrame).toContain("COMMENT");
	expect(commentFrame).toContain("Comment here...");
	for (const ch of "add a diagram") {
		t.mockInput.pressKey(ch);
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	await t.renderOnce();
	const afterSubmit = t.captureCharFrame();
	expect(afterSubmit).toContain("add a diagram");

	// f with comments finishes: feedback is routed to the planner (the review
	// closes and the demo stays at the proposed/plan-review phase).
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => !frame.includes("Changed Files (4 files)"));
	t.renderer.destroy();
});

test("traces panel is removed from the rendered dashboard", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// The traces panel no longer renders anywhere in the dashboard.
	expect(t.captureCharFrame()).not.toContain("Traces ·");

	// Visiting every panel through the grid never shows traces.
	const moves = [
		["j", { shift: true }], // Change → Current task
		["k", { shift: true }], // Current task → Change
		["l", { shift: true }], // Change → Agents
		["h", { shift: true }], // Agents → Change
	] as const;
	for (const [key, opts] of moves) {
		t.mockInput.pressKey(key, opts);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("Traces ·");
	}
	t.renderer.destroy();
});

test("plan review finish shows a finishing indicator before closing", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	await t.waitForFrame((frame) => frame.includes("Plan review"));

	// Pressing f enters the finishing state: the indicator paints while the
	// popup is still open (completion work is deferred by one macrotask).
	t.mockInput.pressKey("f");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Finishing review");

	// After the operation settles the indicator clears and the review closes.
	await t.waitForFrame(
		(frame) =>
			!frame.includes("Finishing review") &&
			!frame.includes("Changed Files (4 files)"),
	);
	t.renderer.destroy();
});

test("developer review finish shows a finishing indicator before closing", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});

	// Advance to the developer-review phase via plan approval.
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => !frame.includes("Changed Files (4 files)"));
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("verify"));
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("Changed Files (1 files)"));

	// The finishing indicator appears while the developer review popup remains
	// open, then clears and the popup closes once the operation settles.
	t.mockInput.pressKey("f");
	await t.renderOnce();
	const finishingFrame = t.captureCharFrame();
	expect(finishingFrame).toContain("Finishing review");
	expect(finishingFrame).toContain("Changed Files (1 files)");

	await t.waitForFrame((frame) => !frame.includes("Finishing review"));
	await t.waitForFrame((frame) => !frame.includes("Changed Files (1 files)"));
	t.renderer.destroy();
});

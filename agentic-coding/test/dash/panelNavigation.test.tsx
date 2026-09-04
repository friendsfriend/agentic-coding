/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App } from "../../src/tui/dash/App";
import { type DashboardData, testDashboard } from "../../src/tui/dash/data";

type Test = Awaited<ReturnType<typeof testRender>>;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function TestDashboard(props: { testData?: DashboardData }) {
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
			workflowId="demo"
			profile="test"
			keymap={keymap}
			testData={props.testData}
		/>
	);
}

// Dismiss the auto-opened plan review popup; focus starts on the Change panel.
async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Enter on the focused panel; the opened modal identifies the panel:
// Change → plan review popup, OpenSpec → artifact verdict. Agents is probed
// separately with `v` because Enter there dispatches a pane focus action.
async function openFocusedPanelModal(t: Test) {
	t.mockInput.pressEnter();
	await t.renderOnce();
	return t.captureCharFrame();
}

async function expectOpenSpec(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("OpenSpec ·");
	expect(frame).not.toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("OpenSpec ·"));
}

async function expectChange(t: Test) {
	const frame = await openFocusedPanelModal(t);
	expect(frame).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

// Agents panel probe: move selection to the security-verifier (planner →
// worker → security-verifier) and open its result.
async function expectAgents(t: Test) {
	t.mockInput.pressKey("j");
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressKey("v");
	const frame = await t.waitForFrame((value) =>
		value.includes("VERDICT: PASS"),
	);
	expect(frame).toContain("security-verifier · demo");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("VERDICT"));
}

/**
 * Poll for a frame predicate with real time between renders: OpenTUI's
 * block Markdown renderer highlights via a background tree-sitter worker,
 * so a single idle render may not yet contain the rendered text.
 */
async function waitForText(
	t: Test,
	predicate: (frame: string) => boolean,
	timeoutMs = 5000,
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		await t.renderOnce();
		const frame = t.captureCharFrame();
		if (predicate(frame)) return frame;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for frame predicate");
}

/** Fixture dashboard with `count` OpenSpec artifacts backed by real files. */
function artifactsFixture(count: number): DashboardData {
	const root = mkdtempSync(join(tmpdir(), "agent-dash-openspec-"));
	roots.push(root);
	const changeRoot = join(
		root,
		"openspec",
		"changes",
		"demo-optional-realisation-date",
	);
	mkdirSync(changeRoot, { recursive: true });
	for (let index = 1; index <= count; index++) {
		writeFileSync(
			join(changeRoot, `artifact-${index}.md`),
			`# Artifact ${index}\n\nBody ${index}.\n`,
		);
	}
	const dashboard = testDashboard();
	return { ...dashboard, state: { ...dashboard.state, worktree: root } };
}

test("Shift+J/K move focus vertically with wrap at both edges", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Change → (Shift+J) → OpenSpec.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectOpenSpec(t);

	// OpenSpec → (Shift+J, bottom wraps to top) → Change.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+K, top wraps to bottom) → OpenSpec.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectOpenSpec(t);

	// OpenSpec → (Shift+K) → Change.
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	t.renderer.destroy();
});

test("Shift+H/L move focus horizontally with wrap at both edges", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change → (Shift+L) → Agents (selection starts at the top).
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);

	// Agents → (Shift+H) → Change.
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+H, left edge wraps to the right) → Agents, then
	// Shift+L returns to Change — reaching Change again proves the wrap
	// landed on the only other panel of the row.
	t.mockInput.pressKey("h", { shift: true });
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	// Change → (Shift+L) → Agents, then Shift+H (right edge wraps to the
	// left) returns to Change.
	t.mockInput.pressKey("l", { shift: true });
	t.mockInput.pressKey("h", { shift: true });
	await t.renderOnce();
	await expectChange(t);

	t.renderer.destroy();
});

test("Shift+J/K without artifacts leave the active panel unchanged", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Change has no vertical neighbor without a listed OpenSpec panel: a
	// vertical move is a no-op, so Enter still opens the plan review.
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	t.mockInput.pressKey("k", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// The spanning Agents column also has no distinct vertical neighbor:
	// Shift+J/K leave it focused, so `v` still opens the selection's verdict.
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	t.mockInput.pressKey("v");
	const frame = await t.waitForFrame((value) =>
		value.includes("VERDICT: PASS"),
	);
	expect(frame).toContain("security-verifier · demo");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("VERDICT"));

	t.renderer.destroy();
});

test("Shift+J/K on the spanning Agents column stay on Agents", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	await expectAgents(t);

	// Agents → (Shift+J) and (Shift+K) have no distinct vertical neighbor
	// (the right column is a single spanning panel): focus stays on Agents.
	t.mockInput.pressKey("j", { shift: true });
	t.mockInput.pressKey("k", { shift: true });
	await t.renderOnce();
	t.mockInput.pressKey("v");
	const frame = await t.waitForFrame((value) =>
		value.includes("VERDICT: PASS"),
	);
	expect(frame).toContain("security-verifier · demo");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("VERDICT"));

	t.renderer.destroy();
});

test("focused OpenSpec panel shows five rows and scrolls with j/k", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(7)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	// Focus the OpenSpec panel.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();

	// Only five artifact rows are visible initially; the sixth is hidden.
	const initial = t.captureCharFrame();
	const initialArtifacts = initial
		.split("\n")
		.filter((line) => line.includes("artifact-"));
	expect(initialArtifacts.length).toBe(5);
	expect(initial).toContain("artifact-1.md");
	expect(initial).toContain("artifact-5.md");
	expect(initial).not.toContain("artifact-6.md");

	// j moves the selection past the initial viewport and scrolls the lower
	// artifact into view without changing panel focus.
	for (let index = 0; index < 5; index++) {
		t.mockInput.pressKey("j");
		await t.renderOnce();
	}
	expect(t.captureCharFrame()).toContain("artifact-6.md");

	// k scrolls back up toward the first artifact; the sixth leaves the
	// visible viewport while the fifth rows remain.
	t.mockInput.pressKey("k");
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("artifact-5.md");

	// Activating the scrolled selection opens the formatted artifact view.
	t.mockInput.pressKey("j");
	await t.renderOnce();
	t.mockInput.pressEnter();
	await t.waitForFrame((frame) => frame.includes("OpenSpec · artifact-6.md"));
	const verdict = await waitForText(t, (frame) => frame.includes("Body 6."));
	expect(verdict).not.toContain("Plan review");

	t.renderer.destroy();
});

test("detail view never renders a Current task panel or row", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t);

	expect(t.captureCharFrame()).not.toContain("Current task");

	// Visiting every direction of the reduced grid never surfaces it.
	const moves = [
		["j", { shift: true }], // Change → OpenSpec
		["l", { shift: true }], // OpenSpec → Agents
		["k", { shift: true }], // Agents → (no vertical neighbor)
		["h", { shift: true }], // Agents → Change
	] as const;
	for (const [key, opts] of moves) {
		t.mockInput.pressKey(key, opts);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("Current task");
	}

	t.renderer.destroy();
});

test("unshifted j scrolls without switching panels; Tab never moves panel focus", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	// Unshifted j stays on Change (no focus change) — Enter still opens the
	// plan review popup.
	t.mockInput.pressKey("j");
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Tab is unbound for panel navigation (reserved for the shell tab bar):
	// focus stays on Change, so Enter still opens the plan review.
	t.mockInput.pressTab();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// Shift+Tab similarly leaves focus on Change.
	t.mockInput.pressKey("\t", { shift: true });
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Plan review");
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));

	// From another panel Tab still does not move focus: Shift+J to OpenSpec
	// (artifacts present), Tab, then Enter opens the OpenSpec verdict.
	const t2 = await testRender(
		() => <TestDashboard testData={artifactsFixture(5)} />,
		{
			width: 120,
			height: 40,
		},
	);
	await dashboardReady(t2);
	t2.mockInput.pressKey("j", { shift: true });
	t2.mockInput.pressTab();
	t2.mockInput.pressEnter();
	await t2.renderOnce();
	expect(t2.captureCharFrame()).toContain("OpenSpec ·");

	t2.renderer.destroy();
	t.renderer.destroy();
});

test("help documents directional panel navigation", async () => {
	const t = await testRender(() => <TestDashboard />, {
		width: 120,
		height: 40,
	});
	await dashboardReady(t);

	t.mockInput.pressKey("?");
	const helpFrame = await t.waitForFrame((frame) =>
		frame.includes("Shift+J/K/H/L"),
	);
	expect(helpFrame).toContain("Move between panels");
	// In-panel scrolling stays documented alongside the new bindings.
	expect(helpFrame).toContain("Scroll focused panel");
	t.renderer.destroy();
});

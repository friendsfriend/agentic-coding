/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import { App as DashApp } from "../../src/tui/dash/App";
import { type DashboardData, testDashboard } from "../../src/tui/dash/data";
import { StatusBar } from "../../src/tui/otel/components/StatusBar";

// The shell footer reads the catalog the dashboard detail view publishes. This
// drives it through the real panel grid to prove the footer changes with the
// focused panel instead of staying static.

type Test = Awaited<ReturnType<typeof testRender>>;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function TestDashboard(props: { testData?: DashboardData }) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
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
		<box style={{ width: "100%", height: "100%", flexDirection: "column" }}>
			<box style={{ flexGrow: 1, minHeight: 0 }}>
				<DashApp
					repo="/demo"
					workflowId="demo"
					profile="test"
					keymap={keymap}
					testData={props.testData}
				/>
			</box>
			<StatusBar />
		</box>
	);
}

async function dashboardReady(t: Test) {
	await t.waitForFrame((frame) => frame.includes("Plan review"));
	t.mockInput.pressEscape();
	await t.waitForFrame((frame) => !frame.includes("Plan review"));
}

/** Fixture dashboard with OpenSpec artifacts backed by real files. */
function artifactsFixture(count: number): DashboardData {
	const root = mkdtempSync(join(tmpdir(), "agent-dash-footer-"));
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

test("footer follows the focused detail panel and hides standard keys", async () => {
	const t = await testRender(
		() => <TestDashboard testData={artifactsFixture(3)} />,
		{ width: 140, height: 40 },
	);
	await dashboardReady(t);

	// Change panel: its gate action is advertised; standard scroll is not.
	const change = t.captureCharFrame();
	expect(change).toContain("Approve gate / review changed files");
	expect(change).not.toContain("Scroll focused panel");
	expect(change).toContain("Move between panels");

	// Shift+J → OpenSpec panel: the footer swaps in the artifact action.
	t.mockInput.pressKey("j", { shift: true });
	await t.renderOnce();
	await t.waitForFrame((frame) => frame.includes("Open selected artifact"));
	const openspec = t.captureCharFrame();
	expect(openspec).not.toContain("Approve gate / review changed files");

	// Shift+L → Agents panel: its own actions replace the OpenSpec action.
	t.mockInput.pressKey("l", { shift: true });
	await t.renderOnce();
	const agents = await t.waitForFrame((frame) =>
		frame.includes("Focus selected agent"),
	);
	expect(agents).toContain("View selected verifier");
	expect(agents).not.toContain("Open selected artifact");

	t.renderer.destroy();
});

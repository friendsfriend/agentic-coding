/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type { WorkflowOverview } from "../../src/tui/dash/data";
import { Home } from "../../src/tui/dash/Home";
import { resetNotifications } from "../../src/tui/dash/notifications";
import { resetLifecycle } from "../../src/tui/lifecycle";
import {
	activeErrorModal,
	resetErrorModal,
} from "../../src/tui/shared/errorModal";

// The notification signal and lifecycle phase are module-global; bun runs all
// files in one process, so a toast or a "stopping" phase left by an earlier
// file would break this one (overlapped panel text / swallowed keys). Clear
// both before every render.
beforeEach(() => {
	resetNotifications();
	resetLifecycle();
	resetErrorModal();
});

function overview(): WorkflowOverview {
	return {
		state: {
			workflowId: "demo-change",
			changeId: "demo-change",
			phase: "implement",
			revision: 0,
			status: "active",
			health: { valid: true, attention: [] },
			repository: "/demo/repo",
			worktree: "/demo/repo",
			branch: "demo",
			workspace: "demo",
			verificationRound: 0,
			runs: [],
			panes: {},
		},
		workspaceOpen: true,
		tasks: [1, 2],
		agents: [],
	};
}

function TestHome(props: { items: WorkflowOverview[] }) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const dispose = keymap.registerLayerFields({
		name() {},
		appView(value, ctx) {
			ctx.require("app.view", String(value));
		},
		activeModal(value, ctx) {
			ctx.require("modal.active", String(value));
		},
	});
	onCleanup(dispose);
	return (
		<Home
			keymap={keymap}
			items={props.items}
			loading={false}
			projects={[]}
			refresh={() => {}}
		/>
	);
}

test("overview omits detail-dashboard Git status", async () => {
	const t = await testRender(() => <TestHome items={[overview()]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Workspaces");
	expect(frame).not.toContain("Git status");
	expect(frame).not.toContain("changed");
	t.renderer.destroy();
});

test("overview remains usable without a Git panel", async () => {
	const t = await testRender(() => <TestHome items={[]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Workspaces");
	expect(frame).toContain("No workflows found");
	expect(frame).not.toContain("Git status");
	t.renderer.destroy();
});

test("G does not open changed files from the workspace overview", async () => {
	const t = await testRender(() => <TestHome items={[overview()]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	t.mockInput.pressKey("g", { shift: true });
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Changed files ·");
	t.renderer.destroy();
});

test("overview renders no transient refresh-status row", async () => {
	const t = await testRender(() => <TestHome items={[overview()]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("Refreshing observations…");
	expect(frame).toContain("demo-change");
	t.renderer.destroy();
});

test("overview leaves observation failures to the global error modal", async () => {
	const t = await testRender(() => <TestHome items={[]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).not.toContain("Observation failed");
	expect(frame).toContain("No workflows found");
	t.renderer.destroy();
});

test("invalid workflow rows mark INVALID without inlining the diagnostic", async () => {
	const item = overview();
	item.state.health = {
		valid: false,
		attention: ["engine says broken"],
		diagnostic: "engine says broken",
	};
	const t = await testRender(() => <TestHome items={[item]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("INVALID");
	expect(frame).not.toContain("engine says broken");
	t.renderer.destroy();
});

test("opening an invalid workflow reports its diagnostic through the error modal", async () => {
	const item = overview();
	item.state.health = {
		valid: false,
		attention: ["engine says broken"],
		diagnostic: "engine says broken",
	};
	const t = await testRender(() => <TestHome items={[item]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();
	t.mockInput.pressEnter();
	await t.flush();
	expect(activeErrorModal()?.title).toBe("Invalid workflow state");
	expect(activeErrorModal()?.message).toBe("engine says broken");
	t.renderer.destroy();
});

test("`?` inside an overview dialog opens that dialog's own keybinds", async () => {
	const t = await testRender(() => <TestHome items={[overview()]} />, {
		width: 120,
		height: 40,
	});
	await t.flush();

	// `f` opens the filter dialog, which advertises `? help`.
	t.mockInput.pressKey("f");
	await t.waitForFrame((frame) => frame.includes("Filter"));
	t.mockInput.pressKey("?");
	const help = await t.waitForFrame((frame) => frame.includes("Keybindings"));
	expect(help).toContain("Toggle");

	// Esc closes the dialog's help and returns to the dialog itself.
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	const closed = await t.waitForFrame(
		(frame) => !frame.includes("Keybindings"),
	);
	expect(closed).toContain("Filter");

	t.renderer.destroy();
});

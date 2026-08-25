/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, test } from "bun:test";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { onCleanup } from "solid-js";
import type { WorkflowOverview } from "../../src/tui/dash/data";
import { Home } from "../../src/tui/dash/Home";
import { resetNotifications } from "../../src/tui/dash/notifications";
import { resetLifecycle } from "../../src/tui/lifecycle";

// The notification signal and lifecycle phase are module-global; bun runs all
// files in one process, so a toast or a "stopping" phase left by an earlier
// file would break this one (overlapped panel text / swallowed keys). Clear
// both before every render.
beforeEach(() => {
	resetNotifications();
	resetLifecycle();
});

function overview(gitStatus?: WorkflowOverview["gitStatus"]): WorkflowOverview {
	return {
		state: {
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
		gitStatus,
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

test("overview git status panel shows branch and labeled counts", async () => {
	const t = await testRender(
		() => (
			<TestHome
				items={[
					overview({
						available: true,
						branch: "feature/demo",
						changedFiles: 2,
						addedFiles: 1,
						deletedFiles: 1,
						ahead: 3,
						behind: 1,
						noUpstream: false,
					}),
				]}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Git status");
	expect(frame).toContain("feature/demo");
	expect(frame).toContain("changed 2");
	expect(frame).toContain("added 1");
	expect(frame).toContain("deleted 1");
	expect(frame).toContain("ahead 3");
	expect(frame).toContain("behind 1");
	t.renderer.destroy();
});

test("overview git status panel covers no-selection, no-upstream, and unavailable states", async () => {
	const empty = await testRender(() => <TestHome items={[]} />, {
		width: 120,
		height: 40,
	});
	await empty.flush();
	expect(empty.captureCharFrame()).toContain("No workspace selected");
	empty.renderer.destroy();

	const noUpstream = await testRender(
		() => (
			<TestHome
				items={[
					overview({
						available: true,
						branch: "feature/demo",
						changedFiles: 0,
						addedFiles: 0,
						deletedFiles: 0,
						ahead: undefined,
						behind: undefined,
						noUpstream: true,
					}),
				]}
			/>
		),
		{ width: 120, height: 40 },
	);
	await noUpstream.flush();
	const upstreamFrame = noUpstream.captureCharFrame();
	expect(upstreamFrame).toContain("no upstream configured");
	expect(upstreamFrame).not.toContain("ahead undefined");
	noUpstream.renderer.destroy();

	const unavailable = await testRender(
		() => (
			<TestHome
				items={[
					overview({
						...emptyGitStatus(),
						available: false,
						diagnostic: "worktree not found",
					}),
				]}
			/>
		),
		{ width: 120, height: 40 },
	);
	await unavailable.flush();
	expect(unavailable.captureCharFrame()).toContain(
		"Unavailable · worktree not found",
	);
	unavailable.renderer.destroy();
});

function emptyGitStatus() {
	return {
		branch: undefined,
		changedFiles: 0,
		addedFiles: 0,
		deletedFiles: 0,
		ahead: undefined,
		behind: undefined,
		noUpstream: true,
	};
}

test("G opens changed files for the selected workspace and is ignored without one", async () => {
	const withoutSelection = await testRender(() => <TestHome items={[]} />, {
		width: 120,
		height: 40,
	});
	await withoutSelection.flush();
	withoutSelection.mockInput.pressKey("g", { shift: true });
	await withoutSelection.flush();
	expect(withoutSelection.captureCharFrame()).not.toContain("Changed files ·");
	withoutSelection.renderer.destroy();

	const t = await testRender(
		() => (
			<TestHome
				items={[
					overview({ ...emptyGitStatus(), available: true, branch: "demo" }),
				]}
			/>
		),
		{ width: 120, height: 40 },
	);
	await t.flush();
	t.mockInput.pressKey("g", { shift: true });
	await t.waitForFrame((frame) =>
		frame.includes("Changed files · demo-change"),
	);
	// The fabricated repo has no workflow state, so load errors surface inside
	// the modal while the overview stays intact behind it.
	expect(t.captureCharFrame()).toContain("Search files");
	t.renderer.destroy();
});

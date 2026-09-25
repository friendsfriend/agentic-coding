/** @jsxImportSource @opentui/solid */
// Contextual creation form (launch-workflows-from-project-and-wiki-pages,
// tasks 1.2/3.1/3.2): the launch context is immutable, so the form never asks
// for a repository, a custom path or an independent target.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	type NewWorkflowInput,
	NewWorkflowModal,
} from "../../src/tui/dash/ui/NewWorkflowModal.tsx";

function key(
	name: string,
	extra: { meta?: boolean; sequence?: string } = {},
): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: extra.meta ?? false,
		shift: false,
		option: false,
		sequence: extra.sequence ?? name,
		number: false,
		raw: extra.sequence ?? name,
		eventType: "press",
		source: "raw",
	});
}

const PROJECT = {
	kind: "project",
	ident: "fixture",
	name: "Fixture",
	repository: "/managed/fixture",
} as const;

const INDEPENDENT = { kind: "independent" } as const;

const PATH = { kind: "path", repository: "/working/dir" } as const;

test("a path context prefills the working directory and lets the user replace it", async () => {
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PATH}
				onKeyReady={() => {}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	const first = t.captureCharFrame();
	// The target is a directory, prefilled with the working directory.
	expect(first).toContain("Repository");
	expect(first).toContain("/working/dir");
	expect(first).toContain("Repository path");
	// The native editor owns the field: clear the prefill and enter another path.
	for (let index = 0; index < "/working/dir".length; index += 1)
		t.mockInput.pressBackspace();
	for (const character of "/custom/repo") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.flush();
	const next = t.captureCharFrame();
	expect(next).toContain("Repository");
	expect(next).toContain("/custom/repo");
	expect(next).toContain("Workflow type");
	t.renderer.destroy();
});

test("a project context offers every registry workflow type without asking for a repository", async () => {
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={() => {}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 50 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	// The target is the page's project, named once, never chosen.
	expect(frame).toContain("Fixture");
	expect(frame).not.toContain("Custom path");
	expect(frame).not.toContain("Standalone research");
	expect(frame).not.toContain("Current directory");
	expect(frame).toContain("Openspec");
	expect(frame).toContain("Openspec apply");
	expect(frame).toContain("No OpenSpec");
	expect(frame).toContain("Openspec fusion");
	expect(frame).toContain("Openspec Propose Only");
	expect(frame).toContain("Openspec fusion propose");
	expect(frame).toContain("Wiki");
	expect(frame).toContain("Research");
	expect(frame).not.toContain("Wiki Comments");
	t.renderer.destroy();
});

test("an independent Wiki context offers a target-compatible research type only", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={INDEPENDENT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 110, height: 40 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Independent (");
	expect(frame).toContain("Research");
	// Repository-bound types and every repository selector are absent.
	expect(frame).not.toContain("Openspec");
	expect(frame).not.toContain("Custom path");
	expect(frame).not.toContain("Standalone research");
	handler?.(key("enter")); // workflow type: research
	handler?.(key("enter")); // agent preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // workflow id
	await t.flush();
	for (const character of "Survey the wiki") t.mockInput.pressKey(character);
	t.mockInput.pressEnter({ meta: true }); // task -> confirm
	handler?.(key("enter")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0]).toMatchObject({
		workflowType: "research",
		repo: "",
		task: "Survey the wiki",
	});
	t.renderer.destroy();
});

test("proposal choices submit their type, task, and fixed checkout mode", async () => {
	for (const [offset, workflowType] of [
		[6, "openspec-propose"],
		[7, "openspec-fusion-propose"],
	] as const) {
		let handler: ((event: KeyEvent) => boolean) | undefined;
		const completed: NewWorkflowInput[] = [];
		const t = await testRender(
			() => (
				<NewWorkflowModal
					context={PROJECT}
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
					onComplete={async (input) => {
						completed.push(input);
					}}
				/>
			),
			{ width: 110, height: 30 },
		);
		await t.flush();
		for (let index = 0; index < offset; index++) handler?.(key("j"));
		handler?.(key("enter")); // proposal workflow type
		await t.flush();
		handler?.(key("enter")); // preset
		await t.flush();
		t.mockInput.pressEnter(); // ticket
		await t.flush();
		for (const character of "proposal") t.mockInput.pressKey(character);
		await t.flush();
		const changeFrame = t.captureCharFrame();
		expect(changeFrame.match(/proposal/g)).toHaveLength(2);
		t.mockInput.pressEnter(); // change
		await t.flush();
		for (const character of "Draft only") t.mockInput.pressKey(character);
		await t.flush();
		t.mockInput.pressEnter({ meta: true }); // task -> confirm
		handler?.(key("enter"));
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			workflowType,
			task: "Draft only",
			mode: "checkout",
			repo: PROJECT.repository,
		});
		t.renderer.destroy();
	}
});

test("openspec-apply omits the task step and submits no task", async () => {
	const repo = mkdtempSync(join(tmpdir(), "new-workflow-modal-"));
	mkdirSync(join(repo, "openspec", "changes", "openspec-apply-test"), {
		recursive: true,
	});
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	try {
		const t = await testRender(
			() => (
				<NewWorkflowModal
					context={{
						kind: "project",
						ident: "fixture",
						name: "Fixture",
						repository: repo,
					}}
					onKeyReady={(h) => {
						handler = h;
					}}
					onCancel={() => {}}
					onComplete={async (input) => {
						completed.push(input);
					}}
				/>
			),
			{ width: 110, height: 30 },
		);
		await t.flush();
		handler?.(key("j")); // standard -> openspec-apply
		handler?.(key("enter")); // select openspec-apply
		await t.flush();
		handler?.(key("enter")); // preset: (config defaults)
		t.mockInput.pressEnter(); // ticket: optional
		handler?.(key("enter")); // change: openspec-apply-test
		handler?.(key("enter")); // mode: worktree
		handler?.(key("enter")); // create workflow
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0].workflowType).toBe("openspec-apply");
		expect(completed[0].task).toBeUndefined();
		t.renderer.destroy();
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("selecting openspec-fusion-full submits workflowType openspec-fusion-full", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async (input) => {
					completed.push(input);
				}}
			/>
		),
		{ width: 160, height: 30 },
	);
	await t.flush();
	handler?.(key("j")); // standard -> openspec-apply
	handler?.(key("j")); // openspec-apply -> openspec-jev
	handler?.(key("j")); // openspec-jev -> openspec-jev-apply
	handler?.(key("j")); // openspec-jev-apply -> quick
	handler?.(key("j")); // quick -> openspec-fusion-full
	handler?.(key("enter")); // select openspec-fusion-full
	await t.flush();
	// openspec-fusion-full uses the task-driven fields: preset -> ticket -> change -> task -> mode.
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	t.mockInput.pressEnter(); // change
	await t.flush();
	for (const character of "Compare the proposed approaches")
		t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	for (const character of "and recommend one") t.mockInput.pressKey(character);
	await t.flush();
	const taskFrame = t.captureCharFrame();
	expect(taskFrame).toContain("Compare the proposed approaches");
	expect(taskFrame).toContain("and recommend one");
	t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances
	handler?.(key("enter")); // mode: worktree
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0].workflowType).toBe("openspec-fusion-full");
	expect(completed[0].task).toBe(
		"Compare the proposed approaches\nand recommend one",
	);
	t.renderer.destroy();
});

test("creation indicator renders before completion and clears after it settles", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	let resolveComplete: (() => void) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				context={PROJECT}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={() =>
					new Promise<void>((resolve) => {
						resolveComplete = resolve;
					})
				}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	handler?.(key("enter")); // workflow type: standard
	handler?.(key("enter")); // preset: (config defaults)
	t.mockInput.pressEnter(); // ticket: optional
	for (const character of "demo") t.mockInput.pressKey(character);
	t.mockInput.pressEnter(); // change
	await t.flush();
	t.mockInput.pressEnter({ meta: true }); // task: Alt+Enter advances
	handler?.(key("enter")); // mode: worktree -> confirm
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return"));
	await t.flush();
	// The pending indicator is up, and a second Enter cannot submit twice.
	expect(t.captureCharFrame()).toContain("Starting workspace and agents");
	handler?.(key("return"));
	await t.flush();
	resolveComplete?.();
	await t.flush();
	expect(t.captureCharFrame()).not.toContain("Starting workspace and agents");
	t.renderer.destroy();
});

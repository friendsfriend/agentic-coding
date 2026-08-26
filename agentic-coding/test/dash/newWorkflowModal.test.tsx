/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	type NewWorkflowInput,
	NewWorkflowModal,
} from "../../src/tui/dash/ui/NewWorkflowModal";

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

test("workflow type list offers plan-fusion alongside existing choices", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const t = await testRender(
		() => (
			<NewWorkflowModal
				projects={[]}
				onKeyReady={(h) => {
					handler = h;
				}}
				onCancel={() => {}}
				onComplete={async () => {}}
			/>
		),
		{ width: 110, height: 30 },
	);
	await t.flush();
	handler?.(key("enter")); // repo: Current Directory -> workflow type list
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Standard");
	expect(frame).toContain("Apply");
	expect(frame).toContain("Quick Implementation");
	expect(frame).toContain("Plan Fusion");
	expect(frame).toContain("Standard Propose");
	expect(frame).toContain("Fusion Propose");
	t.renderer.destroy();
});

test("proposal choices submit their type, task, and fixed checkout mode", async () => {
	for (const [offset, workflowType] of [
		[4, "standard-propose"],
		[5, "fusion-propose"],
	] as const) {
		let handler: ((event: KeyEvent) => boolean) | undefined;
		const completed: NewWorkflowInput[] = [];
		const t = await testRender(
			() => (
				<NewWorkflowModal
					projects={[]}
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
		handler?.(key("enter")); // repo: Current Directory
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
		});
		t.renderer.destroy();
	}
});

test("direct-apply omits the task step and submits no task", async () => {
	const repo = mkdtempSync(join(tmpdir(), "new-workflow-modal-"));
	mkdirSync(join(repo, "openspec", "changes", "direct-apply-test"), {
		recursive: true,
	});
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	try {
		const t = await testRender(
			() => (
				<NewWorkflowModal
					projects={[{ name: "Fixture", path: repo, openspec: true }]}
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
		handler?.(key("enter")); // repo: Fixture -> workflow type list
		await t.flush();
		handler?.(key("j")); // standard -> direct-apply
		handler?.(key("enter")); // select direct-apply
		await t.flush();
		handler?.(key("enter")); // preset: (config defaults)
		t.mockInput.pressEnter(); // ticket: optional
		handler?.(key("enter")); // change: direct-apply-test
		handler?.(key("enter")); // mode: worktree
		handler?.(key("enter")); // create workflow
		await t.flush();
		expect(completed).toHaveLength(1);
		expect(completed[0].workflowType).toBe("direct-apply");
		expect(completed[0].task).toBeUndefined();
		t.renderer.destroy();
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});

test("selecting plan-fusion submits workflowType plan-fusion", async () => {
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const completed: NewWorkflowInput[] = [];
	const t = await testRender(
		() => (
			<NewWorkflowModal
				projects={[]}
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
	handler?.(key("enter")); // repo: Current Directory
	await t.flush();
	handler?.(key("j")); // standard -> direct-apply
	handler?.(key("j")); // direct-apply -> quick
	handler?.(key("j")); // quick -> plan-fusion
	handler?.(key("enter")); // select plan-fusion
	await t.flush();
	// plan-fusion uses the task-driven fields: preset -> ticket -> change -> task -> mode.
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
	expect(completed[0].workflowType).toBe("plan-fusion");
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
				projects={[]}
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
	handler?.(key("enter")); // repo: Current Directory
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

	handler?.(key("return")); // create workflow
	// The progress modal must be visible while the completion callback is
	// still in flight (deferred via an unresolved promise).
	const creatingFrame = await t.waitForFrame((frame) =>
		frame.includes("Starting workspace"),
	);
	expect(creatingFrame).toContain("Creating workflow");
	expect(resolveComplete).toBeDefined();
	resolveComplete?.();
	await t.waitForFrame((frame) => !frame.includes("Creating workflow"));
	t.renderer.destroy();
});

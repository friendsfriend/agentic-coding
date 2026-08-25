/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/solid";
import {
	type NewWorkflowInput,
	NewWorkflowModal,
} from "../../src/tui/dash/ui/NewWorkflowModal";

function key(name: string): KeyEvent {
	return new KeyEvent({
		name,
		ctrl: false,
		meta: false,
		shift: false,
		option: false,
		sequence: name,
		number: false,
		raw: name,
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
	t.renderer.destroy();
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
		{ width: 110, height: 30 },
	);
	await t.flush();
	handler?.(key("enter")); // repo: Current Directory
	await t.flush();
	handler?.(key("j")); // standard -> direct-apply
	handler?.(key("j")); // direct-apply -> quick
	handler?.(key("j")); // quick -> plan-fusion
	handler?.(key("enter")); // select plan-fusion
	await t.flush();
	// plan-fusion uses the base fields: preset -> ticket -> change -> mode.
	handler?.(key("enter")); // preset: (config defaults)
	handler?.(key("enter")); // ticket: optional
	handler?.(key("enter")); // change
	handler?.(key("enter")); // mode: worktree
	await t.flush();
	expect(t.captureCharFrame()).toContain("Confirm workflow");
	handler?.(key("return")); // create workflow
	await t.flush();
	expect(completed).toHaveLength(1);
	expect(completed[0].workflowType).toBe("plan-fusion");
	t.renderer.destroy();
});

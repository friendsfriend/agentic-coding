/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { type Renderable, TextRenderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { LifecycleModal } from "../../src/tui/lifecycle/LifecycleModal.tsx";
import {
	beginShutdown,
	beginStartup,
	resetLifecycle,
	setStepActive,
	setStepDone,
	setStepError,
} from "../../src/tui/lifecycle.ts";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("lifecycle progress continues from its current value while step rows update in place", async () => {
	resetLifecycle();
	const definitions = [
		{ id: "one", label: "First resource" },
		{ id: "two", label: "Second resource" },
		{ id: "three", label: "Third resource" },
	];
	beginStartup(definitions);
	const t = await testRender(() => <LifecycleModal />, {
		width: 100,
		height: 24,
	});
	const filled = () => t.captureCharFrame().match(/━/g)?.length ?? 0;
	try {
		await t.flush();
		const labels = definitions.map((step) =>
			tree(t.renderer.root).find(
				(node) =>
					node instanceof TextRenderable &&
					node.plainText.trim() === step.label,
			),
		);
		if (labels.some((node) => !node))
			throw new Error("Missing lifecycle step rows");
		setStepDone("one");
		await sleep(180);
		await t.flush();
		const before = filled();
		expect(before).toBeGreaterThan(5);
		// This changes only step status, not the progress target. It used to
		// restart the same tween from zero on every new steps-array snapshot.
		setStepActive("two");
		await sleep(20);
		await t.flush();
		expect(filled()).toBeGreaterThanOrEqual(before);
		const current = filled();
		setStepDone("two");
		await sleep(20);
		await t.flush();
		expect(filled()).toBeGreaterThanOrEqual(current);
		for (const label of labels) expect(label?.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("✓ First resource");
		expect(t.captureCharFrame()).toContain("✓ Second resource");
		setStepError("three", "A resource failed to start");
		await t.flush();
		expect(t.captureCharFrame()).toContain("✗ Third resource");
		expect(t.captureCharFrame()).toContain("A resource failed to start");
		// Failed startup can enter shutdown without an intervening running phase.
		beginShutdown(definitions);
		await t.flush();
		for (const label of labels) expect(label?.isDestroyed).toBe(true);
		expect(t.captureCharFrame()).toContain("Stopping server");
		expect(filled()).toBe(0);
		resetLifecycle();
		await t.flush();
		expect(t.captureCharFrame()).not.toContain("Stopping server");
	} finally {
		t.renderer.destroy();
		resetLifecycle();
	}
});

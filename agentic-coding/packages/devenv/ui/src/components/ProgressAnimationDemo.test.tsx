/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { ProgressAnimationDemo } from "./ProgressAnimationDemo";

describe("ProgressAnimationDemo", () => {
	test("shows Aurora, operation colors, badges, and wipe transitions", async () => {
		const view = await testRender(() => <ProgressAnimationDemo />, {
			width: 140,
			height: 18,
		});
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain("Aurora text");
		expect(frame).toContain("Aurora rounded badges");
		const lines = frame.split("\n");
		const candyBadgeLine = lines.findIndex((line) =>
			line.includes(" Candy "),
		);
		const oceanBadgeLine = lines.findIndex((line) =>
			line.includes(" Ocean "),
		);
		expect(candyBadgeLine).toBeGreaterThan(0);
		expect(oceanBadgeLine - candyBadgeLine).toBe(1);
		for (const palette of [
			"Candy",
			"Ocean",
			"Dusk",
			"Neon",
			"Neutral",
			"Twilight",
		]) {
			expect(frame).toContain(palette);
		}
		expect(frame).toContain("highlight1 → highlight2 → highlight3");
		expect(frame).toContain("highlight2 → highlight3 → primary");
		expect(frame).toContain("secondary → highlight1 → highlight2");
		expect(frame).toContain("highlight1 → primary → highlight3");
		expect(frame).toContain("Operation status color model");
		expect(frame).toContain("green + neutral · start / run");
		expect(frame).toContain("red + neutral · stop");
		expect(frame).toContain("amber + neutral · build");
		expect(frame).toContain("blue + neutral · source sync");
		expect(frame).toContain("aurora + neutral · AI work");
		expect(frame).toContain("Wipe transitions");
		expect(frame).toContain("Text status");
		expect(frame).toContain("Text → badge");
		expect(frame).not.toContain("Gradient");
	});
});

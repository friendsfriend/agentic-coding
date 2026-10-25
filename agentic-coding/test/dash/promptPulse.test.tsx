/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { uiColors } from "@ui";
import {
	PromptPulse,
	promptPulseIntensity,
} from "../../src/tui/dash/ui/PromptPulse.tsx";

test("the prompt pulse moves from the center to both edges without reversing", () => {
	const centerPeak = 2 / 9;
	const edgePeak = 7 / 9;
	const center = promptPulseIntensity(0.5, centerPeak);
	expect(center).toBeCloseTo(0.65);
	for (const position of [0, 0.25, 0.75, 1])
		expect(promptPulseIntensity(position, centerPeak)).toBeLessThan(center);
	expect(promptPulseIntensity(0.25, 0.5)).toBeCloseTo(center);
	expect(promptPulseIntensity(0.75, 0.5)).toBeCloseTo(center);
	expect(promptPulseIntensity(0, edgePeak)).toBeCloseTo(center);
	expect(promptPulseIntensity(1, edgePeak)).toBeCloseTo(center);
	expect(promptPulseIntensity(0.5, edgePeak)).toBeLessThan(center);
});

test("the pulse is symmetric, subdued, and continuous at the loop boundary", () => {
	for (let phase = 0; phase <= 20; phase++) {
		for (let cell = 0; cell <= 20; cell++) {
			const position = cell / 20;
			const intensity = promptPulseIntensity(position, phase / 20);
			expect(intensity).toBeGreaterThanOrEqual(0.06);
			expect(intensity).toBeLessThanOrEqual(0.65);
			expect(intensity).toBeCloseTo(
				promptPulseIntensity(1 - position, phase / 20),
			);
			expect(promptPulseIntensity(position, 0)).toBeCloseTo(
				promptPulseIntensity(position, 1),
			);
		}
	}
	expect(promptPulseIntensity(Number.NaN, 0.5)).toBe(0.06);
});

test("the working line uses only the current theme highlight blended into the prompt surface", async () => {
	const t = await testRender(() => <PromptPulse active />, {
		width: 30,
		height: 1,
	});
	try {
		await t.renderOnce();
		expect(t.captureCharFrame().trim()).toBe("▔".repeat(30));
		const background = parseColor(uiColors.bgMantle);
		const highlight = parseColor(uiColors.highlight);
		const base = [background.r, background.g, background.b].map(
			(value) => value * 255,
		);
		const delta = [
			highlight.r - background.r,
			highlight.g - background.g,
			highlight.b - background.b,
		].map((value) => value * 255);
		const channel = delta
			.map(Math.abs)
			.indexOf(Math.max(...delta.map(Math.abs)));
		for (const span of t.captureSpans().lines.flatMap((line) => line.spans)) {
			if (!span.text.includes("▔")) continue;
			const rgb = Array.from(span.fg.buffer).slice(0, 3);
			const change = delta[channel] ?? 0;
			if (Math.abs(change) < 1) continue;
			const intensity = ((rgb[channel] ?? 0) - (base[channel] ?? 0)) / change;
			expect(intensity).toBeGreaterThanOrEqual(0.04);
			expect(intensity).toBeLessThanOrEqual(0.68);
			for (let index = 0; index < 3; index++)
				expect(
					Math.abs(
						(rgb[index] ?? 0) -
							((base[index] ?? 0) + (delta[index] ?? 0) * intensity),
					),
				).toBeLessThanOrEqual(2);
		}
	} finally {
		t.renderer.destroy();
	}
});

test("idle prompts stay blank and errors retain the static error line", async () => {
	for (const error of [false, true]) {
		const t = await testRender(
			() => <PromptPulse active={false} error={error} />,
			{ width: 12, height: 1 },
		);
		try {
			await t.renderOnce();
			expect(t.captureCharFrame().trim()).toBe(error ? "▔".repeat(12) : "");
			if (error) {
				const expected = parseColor(uiColors.error);
				for (const span of t.captureSpans().lines.flatMap((line) => line.spans))
					expect(
						Array.from(span.fg.buffer).slice(0, 3).map(Math.round),
					).toEqual(
						[expected.r, expected.g, expected.b].map((value) =>
							Math.round(value * 255),
						),
					);
			}
		} finally {
			t.renderer.destroy();
		}
	}
});

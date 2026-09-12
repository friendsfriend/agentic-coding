/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { Header } from "./Header";
import type { Highlight } from "./Highlight";
import {
	DEFAULT_INLINE_PROGRESS_HIGHLIGHTS,
	InlineProgressAnimation,
} from "./InlineProgressAnimation";

const logo = ["D", "Ξ", "V"];

async function renderColors(
	highlights: readonly [Highlight, Highlight, Highlight],
) {
	const view = await testRender(
		() => (
			<InlineProgressAnimation
				text="DΞV"
				highlights={highlights}
				duration={1_000_000_000}
			/>
		),
		{ width: 20, height: 2 },
	);
	await view.renderOnce();
	const spans = view.captureSpans().lines.flatMap((line) => line.spans);
	const colors = logo.map((character) =>
		spans.find((span) => span.text.includes(character))?.fg.toInts(),
	);
	view.renderer.destroy();
	return colors;
}

describe("Header", () => {
	test("uses default three-highlight palette without underlining", async () => {
		expect(DEFAULT_INLINE_PROGRESS_HIGHLIGHTS).toEqual([
			"highlight1",
			"highlight2",
			"highlight3",
		]);

		const view = await testRender(() => <Header title="Apps" />, {
			width: 80,
			height: 8,
		});
		await view.renderOnce();
		const logoSpans = view
			.captureSpans()
			.lines[0]?.spans.filter((span) =>
				logo.some((character) => span.text.includes(character)),
			);
		view.renderer.destroy();

		expect(logoSpans.map((span) => span.text).join("")).toContain("DΞV");
		logoSpans.forEach((span) => {
			expect(span.attributes & TextAttributes.UNDERLINE).toBe(0);
		});
	});

	test("accepts a custom three-highlight palette", async () => {
		const custom = await renderColors(["positive", "warning", "negative"]);
		const defaults = await renderColors(DEFAULT_INLINE_PROGRESS_HIGHLIGHTS);

		expect(custom).not.toEqual(defaults);
	});
});

/** @jsxImportSource @opentui/solid */
// Shared TUI test helpers.
//
// The OpenTUI test renderer paints on its own schedule, and a fixed number of
// `renderOnce()` calls is unreliable under load. Every shell test waits for the
// frame it actually needs instead.
import type { TestRendererSetup } from "@opentui/core/testing";

export type Test = TestRendererSetup;

/** Render until the frame satisfies the predicate; false when it never does. */
export async function renderUntil(
	t: Test,
	expected: string | ((frame: string) => boolean),
	passes = 40,
): Promise<boolean> {
	const matches =
		typeof expected === "string"
			? (frame: string) => frame.includes(expected)
			: expected;
	for (let pass = 0; pass < passes; pass += 1) {
		await t.renderOnce();
		if (matches(t.captureCharFrame())) return true;
	}
	return false;
}

/**
 * Let real async work (a body's data load, an effect chain) finish before
 * asserting: `renderOnce()` alone can spin ahead of a promise the body awaits,
 * so each tick waits a little wall-clock time and then paints.
 */
export async function advance(t: Test, ticks = 6, waitMs = 60): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		await t.renderOnce();
	}
}

/**
 * Press Escape and let the input parser flush it (a lone ESC byte is only
 * delivered after a short delay), then settle the resulting frame.
 */
export async function pressEscapeAndSettle(
	t: Test,
	expected?: string | ((frame: string) => boolean),
): Promise<boolean> {
	t.mockInput.pressEscape();
	await new Promise((resolve) => setTimeout(resolve, 80));
	if (!expected) {
		await t.renderOnce();
		return true;
	}
	return renderUntil(t, expected);
}

/** `Ctrl+O`: chronological Back. */
export async function pressBack(
	t: Test,
	expected?: string | ((frame: string) => boolean),
): Promise<boolean> {
	t.mockInput.pressKey("o", { ctrl: true });
	if (!expected) {
		await t.renderOnce();
		return true;
	}
	return renderUntil(t, expected);
}

/** `Alt+Left`: chronological Back on a terminal without the kitty protocol. */
export async function pressAltLeft(
	t: Test,
	expected?: string | ((frame: string) => boolean),
): Promise<boolean> {
	t.mockInput.pressArrow("left", { meta: true });
	if (!expected) {
		await t.renderOnce();
		return true;
	}
	return renderUntil(t, expected);
}

/** Type a query into the location picker and open the top match. */
export async function jumpTo(t: Test, query: string): Promise<void> {
	t.mockInput.pressKey("p", { ctrl: true });
	await renderUntil(t, "Locations");
	for (const character of query) {
		t.mockInput.pressKey(character);
		await t.renderOnce();
	}
	t.mockInput.pressEnter();
	await renderUntil(t, (frame) => !frame.includes("Locations"));
}

/** The breadcrumb row of the current frame, trimmed; "" when there is none. */
export function crumb(t: Test): string {
	return (
		t
			.captureCharFrame()
			.split("\n")
			.find((line) => line.includes("›"))
			?.trim() ?? ""
	);
}

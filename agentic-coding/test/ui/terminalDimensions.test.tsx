/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { useTerminalDimensions } from "@ui";
import { For } from "solid-js";

function Resizer() {
	const size = useTerminalDimensions();
	return <text>{`${size().width}x${size().height}`}</text>;
}

// The shell can mount more than ten dimension consumers at once. OpenTUI's own
// hook installs a renderer listener per call, which trips Node's default
// MaxListeners limit; the shared hook must keep the count at one and still
// follow the renderer.
test("dimension consumers share one renderer resize listener", async () => {
	const warnings: Error[] = [];
	const onWarning = (warning: Error) => warnings.push(warning);
	process.on("warning", onWarning);
	try {
		const t = await testRender(
			() => (
				<box style={{ flexDirection: "column" }}>
					<For each={Array.from({ length: 12 })}>{() => <Resizer />}</For>
				</box>
			),
			{ width: 80, height: 24 },
		);
		await t.renderOnce();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(t.renderer.listenerCount("resize")).toBe(1);
		expect(
			warnings.filter(
				(warning) => warning.name === "MaxListenersExceededWarning",
			),
		).toEqual([]);

		t.resize(100, 30);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("100x30");

		t.renderer.destroy();
	} finally {
		process.off("warning", onWarning);
	}
});

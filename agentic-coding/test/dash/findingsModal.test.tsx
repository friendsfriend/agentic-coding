/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { FindingsModal } from "../../src/tui/dash/ui/FindingsModal.tsx";

test("finding renders verifier, markdown detail, and markdown recommendation", async () => {
	const t = await testRender(
		() => (
			<FindingsModal
				title="Verifier findings"
				selected={0}
				onDetailScrollBoxReady={() => {}}
				events={[
					{
						type: "finding",
						severity: "warning",
						verifier: "security-verifier",
						path: "src/example.ts",
						line: 12,
						detail: "## Unsafe input\n\n**User input** reaches the query.",
						recommendation: "Validate with `parseInput()` before querying.",
					},
				]}
			/>
		),
		{ width: 110, height: 55 },
	);
	let frame = t.captureCharFrame();
	for (
		let attempt = 0;
		attempt < 50 && !frame.includes("parseInput()");
		attempt++
	) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		frame = t.captureCharFrame();
	}
	expect(frame).toContain("security-verifier");
	expect(frame).toContain("Unsafe input");
	expect(frame).toContain("User input");
	expect(frame).not.toContain("**User input**");
	expect(frame).toContain("Recommended fix");
	expect(frame).toContain("parseInput()");
	expect(frame).not.toContain("`parseInput()`");
	t.renderer.destroy();
});

/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { Badge } from "./Badge";

describe("Badge", () => {
	test("renders through the animated badge surface", async () => {
		const view = await testRender(
			() => <Badge text="Running" highlight="positive" />,
			{ width: 30, height: 3 },
		);
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain(" Running ");
	});

	test("renders plain text before badge appearance", async () => {
		const view = await testRender(
			() => <Badge text="Ready" appearance="text" highlight="positive" />,
			{ width: 30, height: 3 },
		);
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain("Ready");
		expect(frame).not.toContain("");
	});

	test("combines text and pixel background in one row", async () => {
		const view = await testRender(
			() => <Badge text="Ready" highlight="positive" />,
			{ width: 30, height: 1 },
		);
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain(" Ready ");
		expect(frame.trimEnd().split("\n")).toHaveLength(1);
	});

	test("renders animated palette and semantic tones", async () => {
		const view = await testRender(
			() => (
				<box style={{ flexDirection: "column" }}>
					<Badge
						text="Candy"
						animatedHighlights={["highlight1", "highlight2", "highlight3"]}
					/>
					<Badge text="Starting" appearance="text" animatedTone="positive" />
				</box>
			),
			{ width: 30, height: 3 },
		);
		await view.renderOnce();
		const frame = view.captureCharFrame();
		view.renderer.destroy();

		expect(frame).toContain("Candy");
		expect(frame).toContain("Starting");
	});

	test("continues wipe after keyed list remount", async () => {
		const first = await testRender(
			() => (
				<Badge
					text="Starting"
					appearance="text"
					highlight="positive"
					transitionKey="badge-remount-test"
				/>
			),
			{ width: 30, height: 3 },
		);
		await first.renderOnce();
		first.renderer.destroy();

		const second = await testRender(
			() => (
				<Badge
					text="Ready"
					appearance="badge"
					highlight="positive"
					transitionKey="badge-remount-test"
					transitionDuration={1000}
				/>
			),
			{ width: 30, height: 3 },
		);
		await second.renderOnce();
		const frame = second.captureCharFrame();
		second.renderer.destroy();

		expect(frame).toContain("Starting");
	});
});

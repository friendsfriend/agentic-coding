/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { MarkdownRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ScheduleDetails } from "../src/tui/schedules/ScheduleDetails.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}

test("schedule field refreshes and reordering retain Markdown renderers without freezing their content", async () => {
	const [content, setContent] = createSignal(
		JSON.stringify({
			prompt: "Stable prompt",
			metadata: { description: "Stable description", revision: 1 },
		}),
	);
	const t = await testRender(
		() => <ScheduleDetails content={content()} width={100} />,
		{ width: 100, height: 30 },
	);
	try {
		await t.renderOnce();
		const prompt = tree(t.renderer.root).find(
			(node) =>
				node instanceof MarkdownRenderable && node.content === "Stable prompt",
		);
		const description = tree(t.renderer.root).find(
			(node) =>
				node instanceof MarkdownRenderable &&
				node.content === "Stable description",
		);
		if (
			!(prompt instanceof MarkdownRenderable) ||
			!(description instanceof MarkdownRenderable)
		)
			throw new Error("Missing schedule Markdown fields");
		setContent(
			JSON.stringify({
				metadata: { revision: 2, description: "Stable description" },
				prompt: "Stable prompt",
			}),
		);
		await t.renderOnce();
		expect(prompt.isDestroyed).toBe(false);
		expect(description.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Revision: 2");
		setContent(
			JSON.stringify({
				metadata: { revision: 3, description: "Updated description" },
				prompt: "Updated prompt",
			}),
		);
		await t.renderOnce();
		expect(prompt.isDestroyed).toBe(false);
		expect(description.isDestroyed).toBe(false);
		expect(prompt.content).toBe("Updated prompt");
		expect(description.content).toBe("Updated description");
		setContent(
			JSON.stringify({
				metadata: { revision: 4, description: "Updated description" },
				prompt: { nested: "Changed shape" },
			}),
		);
		await t.renderOnce();
		expect(prompt.isDestroyed).toBe(true);
		expect(description.isDestroyed).toBe(false);
		expect(t.captureCharFrame()).toContain("Changed shape");
	} finally {
		t.renderer.destroy();
	}
});

for (const width of [38, 100]) {
	test(`schedule details preserve nested and unfamiliar fields at width ${width}`, async () => {
		const t = await testRender(
			() => (
				<ScheduleDetails
					width={width}
					content={JSON.stringify({
						name: "Daily review",
						state: "paused",
						timing: { kind: "cron", timezone: "Europe/Berlin" },
						extraFutureField: { evidence: "retained evidence" },
						history: [{ status: "failed", reason: "full failure reason" }],
						empty: [],
						nullable: null,
					})}
				/>
			),
			{ width, height: 45 },
		);
		try {
			await t.renderOnce();
			const frame = t.captureCharFrame();
			for (const value of [
				"Daily review",
				"paused",
				"Europe/Berlin",
				"Extra Future Field",
				"retained evidence",
				"full failure reason",
				"None",
			])
				expect(frame).toContain(value);
			expect(frame).not.toContain('"timezone"');
		} finally {
			t.renderer.destroy();
		}
	});
}

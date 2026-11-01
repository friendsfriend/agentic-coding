/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import { MarkdownViewer } from "@agentic-coding/ui";
import { testRender, useRenderer } from "@opentui/solid";
import { createSessionMermaidRenderer } from "../../src/tui/pi-durable/mermaid/renderer.ts";

test("multiple diagrams remain visible after narrowing transcript", async () => {
	const content =
		"```mermaid\nflowchart LR\nAlpha --> Beta --> Gamma --> Delta\n```\n\n```mermaid\nsequenceDiagram\nAlice->>Bob: Hello\n```";
	const t = await testRender(
		() => {
			const renderNode = createSessionMermaidRenderer(useRenderer());
			return (
				<MarkdownViewer
					content={content}
					renderNode={renderNode}
					fg="#ffffff"
				/>
			);
		},
		{ width: 100, height: 40 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Delta");
		expect(t.captureCharFrame()).toContain("Hello");
		t.resize(40, 40);
		for (let i = 0; i < 4; i++) await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("Alpha");
		expect(frame).toContain("Delta");
		expect(frame).toContain("Hello");
		expect(frame).not.toContain("flowchart LR");
	} finally {
		t.renderer.destroy();
	}
});

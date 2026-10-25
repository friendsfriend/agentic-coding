/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test";
import {
	CodeRenderable,
	type Renderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { testRender } from "@opentui/solid";
import { uiColors } from "@ui";
import { createSignal } from "solid-js";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import { buildAgentSessionView } from "../../src/tui/dash/agent-session.ts";
import { AgentSessionView } from "../../src/tui/dash/ui/AgentSessionView.tsx";
import { ToolTable } from "../../src/tui/dash/ui/ToolTable.tsx";

function tree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(tree)];
}
function Session(props: { block: AgentSessionBlock }) {
	return (
		<AgentSessionView
			role="worker"
			blocks={[props.block]}
			draft=""
			history={[]}
			working={false}
			models={[]}
			thinkingLevels={[]}
			onHistoryAppend={() => {}}
			onDraftChange={() => {}}
			onSubmit={() => {}}
			onAbort={() => {}}
			onBack={() => {}}
			onConfigure={() => {}}
			onCompact={() => {}}
		/>
	);
}

for (const name of ["read", "edit", "write"]) {
	test(`${name} separates its header, native file body, and notes`, async () => {
		const t = await testRender(
			() => (
				<Session
					block={{
						id: `spacing:${name}`,
						kind: "tool",
						tone: "success",
						text: name,
						toolCall: {
							name,
							args: {
								path: "spacing.txt",
								content: "spacing_content",
								edits: [{ oldText: "before", newText: "spacing_content" }],
							},
							result: {
								lines: ["spacing_content"],
								notes: ["spacing_note"],
								isError: false,
								details: { diff: "@@ -1 +1 @@\n-before\n+spacing_content\n" },
							},
						},
					}}
				/>
			),
			{ width: 140, height: 40 },
		);
		try {
			for (let index = 0; index < 6; index++) await t.renderOnce();
			const lines = t.captureCharFrame().split("\n");
			const header = lines.findIndex((line) => line.includes("spacing.txt"));
			const note = lines.findIndex((line) => line.includes("spacing_note"));
			expect(header).toBeGreaterThanOrEqual(0);
			expect(lines[header + 1]?.replaceAll("┃", "").trim()).toBe("");
			expect(note).toBeGreaterThan(header + 2);
			const headerColumn = lines[header]?.search(/[→←]/);
			expect(lines[note]?.indexOf("spacing_note")).toBe(headerColumn);
			expect(lines[note - 1]?.replaceAll("┃", "").trim()).toBe("");
			expect(lines.some((line) => line.includes("spacing_content"))).toBe(true);
		} finally {
			t.renderer.destroy();
		}
	});
}

test("expanded tool content has a blank line below its header", async () => {
	const t = await testRender(
		() => (
			<Session
				block={{
					id: "workflow-spacing",
					kind: "tool",
					tone: "success",
					text: "Workflow agent-navigation-sidebar-v2",
					toolCall: {
						name: "workflow_status",
						args: { workflowId: "agent-navigation-sidebar-v2" },
						result: {
							lines: ["unique workflow content"],
							notes: [],
							isError: false,
						},
					},
				}}
			/>
		),
		{ width: 140, height: 40 },
	);
	try {
		for (let index = 0; index < 6; index++) await t.renderOnce();
		const lines = t.captureCharFrame().split("\n");
		const content = lines.findIndex((line) =>
			line.includes("unique workflow content"),
		);
		expect(content).toBeGreaterThan(1);
		expect(lines[content - 1]?.replaceAll("┃", "").trim()).toBe("");
	} finally {
		t.renderer.destroy();
	}
});

test("environment build cards render live detail snapshots without stdout chunks", async () => {
	const [output, setOutput] = createSignal("first build output");
	const block = () =>
		buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "build-live",
									name: "env_build",
									arguments: { app: "demo" },
								},
							],
						},
					],
				},
			],
			docs: {
				"pi.live": {
					tools: [
						{
							name: "env_build",
							callId: "build-live",
							status: "running",
							details: { view: { status: "running", output: output() } },
						},
					],
				},
			},
		})[0];
	const requiredBlock = () => {
		const current = block();
		if (!current) throw new Error("Missing live block");
		return current;
	};
	const t = await testRender(() => <Session block={requiredBlock()} />, {
		width: 100,
		height: 50,
	});
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Build demo");
		expect(t.captureCharFrame()).toContain("first build output");
		setOutput("second build output");
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("second build output");
		expect(t.captureCharFrame()).not.toContain("first build output");
	} finally {
		t.renderer.destroy();
	}
});

test("search cards use native line gutters and accent the literal match", async () => {
	const block: AgentSessionBlock = {
		id: "search",
		kind: "tool",
		text: "grep",
		tone: "success",
		toolCall: {
			name: "grep",
			args: { pattern: "needle", path: "src" },
			result: {
				lines: ["src/a.ts:12:const needle = 1;"],
				notes: [],
				isError: false,
			},
		},
	};
	const t = await testRender(() => <Session block={block} />, {
		width: 100,
		height: 30,
	});
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toMatch(/12\s+const needle = 1;/);
		const line = t.captureSpans().lines.find((line) =>
			line.spans
				.map((span) => span.text)
				.join("")
				.includes("const needle"),
		);
		const match = line?.spans.find((span) => span.text === "needle");
		expect(match).toBeDefined();
		const expected = Number.parseInt(uiColors.accent.replace("#", ""), 16);
		expect(
			Array.from(match?.fg.buffer ?? [])
				.slice(0, 3)
				.map(Math.round),
		).toEqual([(expected >> 16) & 255, (expected >> 8) & 255, expected & 255]);
	} finally {
		t.renderer.destroy();
	}
});

for (const width of [48, 140])
	test(`custom HTTP sections start expanded and isolate hover at width ${width}`, async () => {
		const block: AgentSessionBlock = {
			id: "http",
			kind: "tool",
			text: "http_request",
			tone: "success",
			toolCall: {
				name: "http_request",
				args: {
					method: "GET",
					path: "/health",
					app: "demo",
					headers: { authorization: "hidden-auth" },
				},
				result: {
					lines: [],
					notes: [],
					isError: false,
					details: {
						view: {
							status: 200,
							statusText: "OK",
							headers: { "content-type": "application/json" },
							body: '{"healthy":true}',
							bytes: 16,
						},
					},
				},
			},
		};
		const t = await testRender(() => <Session block={block} />, {
			width,
			height: 60,
		});
		const background = (text: string) => {
			const span = t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes(text));
			if (!span) throw new Error(`Missing text: ${text}`);
			return Array.from(span.bg.buffer).join(",");
		};
		try {
			await t.renderOnce();
			await t.renderOnce();
			const frame = t.captureCharFrame();
			expect(frame).toContain("GET /health");
			expect(frame).toContain("healthy");
			expect(frame).toContain("Request");
			expect(frame).toContain("Response body");
			expect(frame).not.toContain("hidden-auth");
			expect(frame).not.toMatch(/[▸▾]/);
			const code = tree(t.renderer.root).find(
				(node) => node instanceof CodeRenderable,
			);
			if (!(code instanceof CodeRenderable))
				throw new Error("Missing JSON renderer");
			expect(code.filetype).toBe("json");
			const headerRest = background("GET /health");
			const bodyRest = background("Response body");
			const requestRest = background("Request");
			const row = frame
				.split("\n")
				.findIndex((line) => line.includes("Request"));
			await t.mockMouse.moveTo(10, row);
			await t.renderOnce();
			expect(background("Request")).not.toBe(requestRest);
			expect(background("Response body")).toBe(bodyRest);
			expect(background("GET /health")).toBe(headerRest);
			await t.mockMouse.click(10, row);
			await t.renderOnce();
			expect(t.captureCharFrame()).not.toContain("App: demo");
			expect(t.captureCharFrame()).toContain("healthy");
		} finally {
			t.renderer.destroy();
		}
	});

test("SQL code and result tables use native highlighting and retain long values on resize", async () => {
	const block: AgentSessionBlock = {
		id: "db",
		kind: "tool",
		text: "db_query",
		tone: "success",
		toolCall: {
			name: "db_query",
			args: { infra: "postgres", sql: "select id, note from notes" },
			result: {
				lines: [],
				isError: false,
				notes: [],
				details: {
					view: {
						columns: ["id", "note"],
						rows: [[1, "long value that wraps without losing the finalWord"]],
					},
				},
			},
		},
	};
	const t = await testRender(() => <Session block={block} />, {
		width: 140,
		height: 50,
	});
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("finalWord");
		const code = tree(t.renderer.root).find(
			(node) => node instanceof CodeRenderable,
		);
		if (!(code instanceof CodeRenderable))
			throw new Error("Missing SQL renderer");
		expect(code.filetype).toBe("sql");
		t.resize(40, 50);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("finalWord");
		expect(t.captureCharFrame()).toContain("Id: 1");
	} finally {
		t.renderer.destroy();
	}
});

test("tables pass their mouse wheel to the enclosing transcript", async () => {
	let box: ScrollBoxRenderable | undefined;
	const t = await testRender(
		() => (
			<scrollbox
				ref={(value) => {
					box = value;
				}}
				height={12}
			>
				<ToolTable
					table={{
						columns: ["id", "status"],
						rows: Array.from({ length: 50 }, (_, index) => [
							String(index),
							"ready",
						]),
					}}
				/>
			</scrollbox>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		if (!box) throw new Error("Missing scroll box");
		await t.mockMouse.scroll(10, 5, "down");
		await t.renderOnce();
		expect(box.scrollTop).toBeGreaterThan(0);
		await t.mockMouse.scroll(10, 5, "up");
		await t.renderOnce();
		expect(box.scrollTop).toBe(0);
	} finally {
		t.renderer.destroy();
	}
});

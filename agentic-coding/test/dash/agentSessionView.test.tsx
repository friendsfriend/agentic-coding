/** @jsxImportSource @opentui/solid */
// add-pi-durable-runtime, dashboard-agent-session-view: the live agent
// session page renders the run title and transcript blocks (opencode v2
// styling), and its input drives submit/abort without any competing text keymap
// binding while the view owns the keyboard (see the module comment in
// AgentSessionView.tsx for why).
import { expect, spyOn, test } from "bun:test";
import {
	CodeRenderable,
	DiffRenderable,
	type KeyEvent,
	parseColor,
	type Renderable,
	type ScrollBoxRenderable,
} from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { testRender, useRenderer } from "@opentui/solid";
import { uiColors } from "@ui";
import { createSignal, onCleanup } from "solid-js";
import {
	AGENT_SESSION_BLOCK_LIMIT,
	type AgentSessionBlock,
	type AgentSessionConnection,
	BROWSER_TOOL_GLYPH,
	buildAgentSessionView,
} from "../../src/tui/dash/agent-session.ts";
import {
	AgentSessionView,
	SESSION_PICKER_KEYS,
} from "../../src/tui/dash/ui/AgentSessionView.tsx";
import { SessionMarkdownCache } from "../../src/tui/dash/ui/session-markdown-cache.ts";
import { TranscriptFile } from "../../src/tui/dash/ui/TranscriptFile.tsx";
import { shellOutputPreview } from "../../src/tui/dash/ui/TranscriptShellOutput.tsx";
import { guardOrchestratorSubmit } from "../../src/tui/orchestrator/submission.ts";

for (const connection of ["connecting", "disconnected"] as const) {
	test(`${connection} preserves drafts and pauses submit and session commands until recovery`, async () => {
		const [state, setState] = createSignal<AgentSessionConnection>(connection);
		const [draft, setDraft] = createSignal("keep draft");
		const calls: string[] = [];
		const t = await testRender(
			() => (
				<AgentSessionView
					role="worker"
					blocks={[]}
					working={false}
					connection={state()}
					history={[]}
					onHistoryAppend={() => calls.push("history")}
					models={["test/model"]}
					thinkingLevels={["off", "high"]}
					draft={draft()}
					onDraftChange={setDraft}
					onSubmit={(text) => calls.push(`submit:${text}`)}
					onAbort={() => calls.push("abort")}
					onBack={() => {}}
					onConfigure={() => calls.push("configure")}
					onCompact={() => calls.push("compact")}
				/>
			),
			{ width: 110, height: 30 },
		);
		try {
			await t.renderOnce();
			const frame = t.captureCharFrame();
			expect(frame).toContain("keep draft");
			expect(frame).toContain("controls paused");
			if (connection === "connecting") {
				expect(frame).toContain("Connecting to the recorded session");
				expect(frame).not.toContain("stale");
			} else expect(frame).toContain("Transcript is stale");
			for (const text of [
				"/compact retain important context",
				"/abort",
				"/model",
				"/thinking",
				"keep draft",
			]) {
				setDraft(text);
				await t.renderOnce();
				t.mockInput.pressEnter();
				await t.renderOnce();
				expect(draft()).toBe(text);
				expect(calls).toEqual([]);
			}
			setState("connected");
			await t.renderOnce();
			expect(t.captureCharFrame()).not.toContain("controls paused");
			expect(t.captureCharFrame()).toContain("keep draft");
			t.mockInput.pressEnter();
			await t.renderOnce();
			expect(calls).toEqual(["history", "submit:keep draft"]);
			expect(draft()).toBe("");
		} finally {
			t.renderer.destroy();
		}
	});
}

test("a picker opened before disconnection cannot dispatch configuration while paused", async () => {
	const [connection, setConnection] =
		createSignal<AgentSessionConnection>("connected");
	const [draft, setDraft] = createSignal("");
	let handler: ((event: KeyEvent) => boolean) | undefined;
	let configured = 0;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				connection={connection()}
				history={[]}
				onHistoryAppend={() => {}}
				models={["test/model"]}
				thinkingLevels={["off"]}
				draft={draft()}
				onDraftChange={setDraft}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => configured++}
				onCompact={() => {}}
				onPickerKeyReady={(value) => {
					handler = value;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.renderOnce();
		for (const character of "/model") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		setConnection("disconnected");
		handler?.({ name: "enter" } as KeyEvent);
		await t.renderOnce();
		expect(configured).toBe(0);
		expect(t.captureCharFrame()).not.toContain("Select model");
	} finally {
		t.renderer.destroy();
	}
});

test("rolling session-view blocks use a projection-bounded markdown cache", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([]);
	const seen = new Set<SessionMarkdownCache>();
	const original = SessionMarkdownCache.prototype.parts;
	const parts = spyOn(
		SessionMarkdownCache.prototype,
		"parts",
	).mockImplementation(function (this: SessionMarkdownCache, key, content) {
		seen.add(this);
		return original.call(this, key, content);
	});
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={false}
				history={[]}
				onHistoryAppend={() => {}}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		for (let batch = 0; batch < 16; batch++) {
			setBlocks(
				Array.from({ length: 24 }, (_, index) => ({
					id: `batch-${batch}-${index}`,
					kind: "assistant",
					text: `answer batch ${batch} message ${index}`,
					tone: "base",
				})),
			);
			await t.renderOnce();
			await t.renderOnce();
		}
		expect(seen.size).toBe(1);
		expect(parts.mock.calls.length).toBeGreaterThan(AGENT_SESSION_BLOCK_LIMIT);
		for (const cache of seen)
			expect(cache.size).toBe(AGENT_SESSION_BLOCK_LIMIT);
		expect(t.captureCharFrame()).toContain("answer batch 15");
	} finally {
		t.renderer.destroy();
		parts.mockRestore();
	}
});

function renderTree(node: Renderable): Renderable[] {
	return [node, ...node.getChildren().flatMap(renderTree)];
}

test("bash streams the latest output without expansion and retains its full log", async () => {
	const command = "bun run streaming-test";
	const entries = [
		{
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "bash-live",
							name: "bash",
							arguments: { command },
						},
					],
				},
			],
		},
	];
	const [output, setOutput] = createSignal("");
	const [done, setDone] = createSignal(false);
	const blocks = () =>
		buildAgentSessionView({
			entries: done()
				? [
						...entries,
						{
							kind: "pi.tool-result",
							model: [
								{
									toolName: "bash",
									toolCallId: "bash-live",
									isError: false,
									content: [{ type: "text", text: output() }],
								},
							],
						},
					]
				: entries,
			docs: {
				"pi.live": {
					tools: done()
						? []
						: [
								{
									name: "bash",
									callId: "bash-live",
									status: "running",
									output: output(),
								},
							],
				},
			},
		});
	const t = await testRender(
		() => (
			<PickerRoute
				onSubmit={() => {}}
				onConfigure={() => {}}
				blocks={blocks()}
			/>
		),
		{ width: 100, height: 40 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(command);
		setOutput("first chunk\n\n  indented chunk");
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("first chunk");
		expect(t.captureCharFrame()).toContain("  indented chunk");
		const log = Array.from(
			{ length: 20 },
			(_, index) => `stream row ${index}`,
		).join("\n");
		setOutput(log);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("stream row 19");
		expect(t.captureCharFrame()).toContain("stream row 0");
		expect(t.captureCharFrame()).not.toContain("earlier lines");
		const row = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes(command));
		await t.mockMouse.click(8, row);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("stream row 0");
		expect(t.captureCharFrame()).toContain("earlier lines");
		await t.mockMouse.click(8, row);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("stream row 0");
		expect(t.captureCharFrame()).toContain("stream row 19");
		setDone(true);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame().match(/bun run streaming-test/g)).toHaveLength(
			1,
		);
		expect(t.captureCharFrame()).toContain("$ bun run streaming-test");
		expect(t.captureCharFrame()).toContain("stream row 19");
		await t.mockMouse.click(8, row);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("stream row 0");
		expect(t.captureCharFrame()).toContain("stream row 19");
	} finally {
		t.renderer.destroy();
	}
});

test("shell previews retain the newest output within OpenCode's compact budget", () => {
	const output = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const preview = shellOutputPreview("bun test", output, 80);
	expect(preview.split("\n")).toHaveLength(8);
	expect(preview).toStartWith("(13 earlier lines)");
	expect(preview).toEndWith("line 19");
	expect(
		shellOutputPreview("first\nsecond", output, 80).split("\n"),
	).toHaveLength(7);
	expect(shellOutputPreview("bun test", "small output", 80)).toBe(
		"small output",
	);
	expect(
		shellOutputPreview("bun test", `${"x".repeat(1000)}TAIL`, 20),
	).toEndWith("TAIL");
});

for (const width of [80, 160]) {
	test(`diff content and gutters follow their card hover at width ${width}`, async () => {
		const t = await testRender(
			() => (
				<PickerRoute
					onSubmit={() => {}}
					onConfigure={() => {}}
					blocks={[
						{
							id: "hover-diff",
							kind: "tool",
							text: "edit",
							tone: "success",
							toolCall: {
								name: "edit",
								args: { path: "a.ts" },
								result: {
									lines: [],
									notes: [],
									isError: false,
									details: {
										diff: "@@ -1,2 +1,2 @@\n context_line();\n-removed_line();\n+added_line();",
									},
								},
							},
						},
					]}
				/>
			),
			{ width, height: 24 },
		);
		const background = (text: string) => {
			const span = t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes(text));
			if (!span) throw new Error(`Missing painted text: ${text}`);
			return Array.from(span.bg.buffer).map(Math.round).join(",");
		};
		const rowOf = (text: string) =>
			t
				.captureCharFrame()
				.split("\n")
				.findIndex((line) => line.includes(text));
		try {
			await t.renderOnce();
			await t.renderOnce();
			const resting = [
				background("context_line"),
				background("removed_line"),
				background("added_line"),
			];
			// Hovering the header must lift the whole diff, not only its padding.
			await t.mockMouse.moveTo(12, rowOf("Edit a.ts"));
			await t.renderOnce();
			await t.renderOnce();
			const lifted = [
				background("context_line"),
				background("removed_line"),
				background("added_line"),
			];
			for (let i = 0; i < resting.length; i++)
				expect(lifted[i]).not.toBe(resting[i]);
			expect(background("context_line")).toBe(background("Edit a.ts"));
			expect(lifted[1]).not.toBe(lifted[0]);
			expect(lifted[2]).not.toBe(lifted[0]);
			const diff = renderTree(t.renderer.root).find(
				(node) => node instanceof DiffRenderable,
			);
			if (!(diff instanceof DiffRenderable)) throw new Error("Missing diff");
			expect(diff.lineNumberBg).toEqual(diff.contextBg);
			expect(diff.addedLineNumberBg).toEqual(diff.addedBg);
			expect(diff.removedLineNumberBg).toEqual(diff.removedBg);
			// Entering the file itself is still the same card hover.
			await t.mockMouse.moveTo(20, rowOf("context_line"));
			await t.renderOnce();
			expect(background("context_line")).toBe(lifted[0]);
			await t.mockMouse.moveTo(width - 2, 23);
			await t.renderOnce();
			await t.renderOnce();
			expect([
				background("context_line"),
				background("removed_line"),
				background("added_line"),
			]).toEqual(resting);
		} finally {
			t.renderer.destroy();
		}
	});
}

for (const width of [80, 160]) {
	for (const kind of ["code", "diff"] as const) {
		test(`wheel over full ${kind} content scrolls the transcript at width ${width}`, async () => {
			let transcript: ScrollBoxRenderable | undefined;
			const content =
				kind === "diff"
					? `@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, i) => `-old ${i}`).join("\n")}\n${Array.from({ length: 30 }, (_, i) => `+new ${i}`).join("\n")}\n`
					: Array.from({ length: 60 }, (_, i) => `source ${i}`).join("\n");
			const t = await testRender(
				() => (
					<scrollbox
						ref={(box) => {
							transcript = box;
						}}
						height={24}
					>
						<text height={8} flexShrink={0}>
							before diff
						</text>
						<box flexShrink={0}>
							<TranscriptFile file={{ kind, path: "a.txt", content }} />
						</box>
						<text height={40} flexShrink={0}>
							after diff
						</text>
					</scrollbox>
				),
				{ width, height: 24 },
			);
			try {
				await t.renderOnce();
				await t.renderOnce();
				if (!transcript) throw new Error("Missing transcript scroll box");
				transcript.scrollTop = 4;
				await t.renderOnce();
				const codes = renderTree(transcript).filter(
					(node) => node instanceof CodeRenderable,
				);
				const code = codes[0];
				if (!code) throw new Error("Missing diff code renderer");
				const x = code.x + 8;
				const y = 6;
				const initial = transcript.scrollTop;
				await t.mockMouse.scroll(x, y, "down");
				await t.renderOnce();
				expect(transcript.scrollTop).toBeGreaterThan(initial);
				expect(code.scrollY).toBe(0);
				await t.mockMouse.scroll(x, y, "up");
				await t.renderOnce();
				expect(transcript.scrollTop).toBe(initial);
				expect(code.scrollY).toBe(0);
				// The line-number gutters also pass their wheel to the transcript.
				await t.mockMouse.scroll(1, y, "down");
				await t.renderOnce();
				expect(transcript.scrollTop).toBeGreaterThan(initial);
				await t.mockMouse.scroll(1, y, "up");
				await t.renderOnce();
				expect(transcript.scrollTop).toBe(initial);
				if (width > 120 && kind === "diff") {
					const right = codes[1];
					if (!right) throw new Error("Missing right diff side");
					expect(right.scrollY).toBe(code.scrollY);
					await t.mockMouse.scroll(right.x + 8, y, "down");
					await t.renderOnce();
					expect(transcript.scrollTop).toBeGreaterThan(initial);
					expect(right.scrollY).toBe(0);
					await t.mockMouse.scroll(right.x + 8, y, "up");
					await t.renderOnce();
					expect(transcript.scrollTop).toBe(initial);
				}
				// Moving outside the diff changes the scroll owner, not keyboard focus.
				await t.mockMouse.scroll(x, 1, "down");
				await t.renderOnce();
				expect(transcript.scrollTop).toBeGreaterThan(initial);
				await t.mockMouse.scroll(x, 1, "up");
				await t.renderOnce();
				expect(transcript.scrollTop).toBe(initial);
			} finally {
				t.renderer.destroy();
			}
		});
	}
}

test("file code configures native syntax highlighting and numbered source", async () => {
	const t = await testRender(
		() => (
			<TranscriptFile
				file={{
					kind: "code",
					path: "a.ts",
					content: "const answer = 42;\n\nrun(answer);",
					startLine: 40,
				}}
			/>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const code = renderTree(t.renderer.root).find(
			(node) => node instanceof CodeRenderable,
		);
		expect(code).toBeInstanceOf(CodeRenderable);
		if (!(code instanceof CodeRenderable))
			throw new Error("Missing source renderer");
		expect(code.filetype).toBe("typescript");
		expect(code.syntaxStyle).toBeDefined();
		const frame = t.captureCharFrame();
		expect(frame).toContain("40 const answer = 42;");
		expect(frame).toContain("42 run(answer);");
	} finally {
		t.renderer.destroy();
	}
});

test("native diffs switch between split and unified as available width changes", async () => {
	const t = await testRender(
		() => (
			<TranscriptFile
				file={{
					kind: "diff",
					path: "a.ts",
					content:
						"--- a/a.ts\n+++ b/a.ts\n@@ -40,1 +40,1 @@\n-const old = 1;\n+const updated = 2;\n",
				}}
			/>
		),
		{ width: 160, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const diff = renderTree(t.renderer.root).find(
			(node) => node instanceof DiffRenderable,
		);
		if (!(diff instanceof DiffRenderable))
			throw new Error("Missing diff renderer");
		expect(diff.view).toBe("split");
		expect(diff.filetype).toBe("typescript");
		expect(t.captureCharFrame()).toContain("const updated = 2;");
		t.resize(80, 12);
		await t.renderOnce();
		await t.renderOnce();
		expect(diff.view).toBe("unified");
		expect(t.captureCharFrame()).toContain("40 - const old = 1;");
		expect(t.captureCharFrame()).toContain("40 + const updated = 2;");
	} finally {
		t.renderer.destroy();
	}
});

const SAMPLE_BLOCKS: AgentSessionBlock[] = [
	{ id: "b1", kind: "user", text: "fix the parser", tone: "accent" },
	{ id: "b2", kind: "assistant", text: "Reading the parser", tone: "base" },
	{ id: "b3", kind: "tool", text: "read path=a.ts", tone: "muted", icon: "→" },
	{ id: "b4", kind: "result", text: "read: file contents", tone: "success" },
];

for (const name of ["read", "write", "edit"] as const) {
	test(`${name} starts fully expanded and toggles without disclosure indicators`, async () => {
		const lines = Array.from({ length: 12 }, (_, i) => `${name} source ${i}`);
		const t = await testRender(
			() => (
				<PickerRoute
					onSubmit={() => {}}
					onConfigure={() => {}}
					blocks={[
						{
							id: "file",
							kind: "tool",
							text: name,
							tone: "success",
							toolCall: {
								name,
								args: { path: "src/file.ts", content: lines.join("\n") },
								result: {
									lines,
									notes: [],
									isError: false,
									...(name === "edit"
										? {
												details: {
													diff: lines.map((line) => `+${line}`).join("\n"),
												},
											}
										: {}),
								},
							},
						},
					]}
				/>
			),
			{ width: 100, height: 32 },
		);
		try {
			await t.renderOnce();
			await t.renderOnce();
			const compact = t.captureCharFrame();
			expect(compact).toContain(`${name} source 0`);
			expect(compact).toContain(`${name} source 7`);
			expect(compact).toContain(`${name} source 11`);
			expect(compact).not.toContain("more lines");
			const row = compact
				.split("\n")
				.findIndex((line) => line.includes("src/file.ts"));
			const contentRow = compact
				.split("\n")
				.findIndex((line) => line.includes(`${name} source 7`));
			await t.mockMouse.click(15, contentRow);
			await t.renderOnce();
			expect(t.captureCharFrame()).not.toContain(`${name} source 11`);
			expect(t.captureCharFrame()).not.toContain("more lines");
			await t.mockMouse.click(4, row);
			await t.renderOnce();
			expect(t.captureCharFrame()).toContain(`${name} source 11`);
			expect(t.captureCharFrame()).not.toMatch(/[▸▾]/);
		} finally {
			t.renderer.destroy();
		}
	});
}

function Harness(props: {
	onSubmit: (text: string) => void;
	onAbort: () => void;
	onBack: () => void;
	onCompact?: (instructions?: string) => void;
	history?: readonly string[];
	inputActive?: () => boolean;
}) {
	const [draft, setDraft] = createSignal("");
	const [history, setHistory] = createSignal<readonly string[]>(
		props.history ?? [],
	);
	return (
		<AgentSessionView
			role="worker"
			blocks={SAMPLE_BLOCKS}
			working={false}
			models={["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"]}
			thinkingLevels={["off", "low", "medium", "high"]}
			draft={draft()}
			history={history()}
			onHistoryAppend={(text) =>
				setHistory((items) =>
					items.at(-1) === text ? items : [...items, text],
				)
			}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={props.onAbort}
			onBack={props.onBack}
			onConfigure={() => {}}
			onCompact={props.onCompact ?? (() => {})}
			inputActive={props.inputActive}
		/>
	);
}

test("the page is body content: no title row, and the prompt ends it", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	// Two passes: the transcript's sticky scroll settles on the first one.
	await t.renderOnce();
	await t.renderOnce();
	const frame = t.captureCharFrame();
	expect(frame).toContain("fix the parser");
	expect(frame).toContain("Reading the parser");
	expect(frame).toContain("read path=a.ts");
	// The run is named by the prompt's metadata row, not a title row: the host
	// owns the blank lines around its header and footer, so the page adds none
	// of its own above the transcript or below the prompt.
	// `captureCharFrame` ends with a newline: the rows are the trimmed split.
	const lines = frame.trimEnd().split("\n");
	expect(frame).not.toContain("Agent · worker");
	// The user prompt block owns the first row (its own blank line above the
	// text), and the prompt's metadata row is the last.
	expect(lines[0]).not.toContain("fix the parser");
	expect(lines[1]).toContain("fix the parser");
	expect(lines.at(-1)).toContain("Worker");
	t.renderer.destroy();
});

test("a long sent message expands and collapses on click", async () => {
	const prompt = Array.from(
		{ length: 12 },
		(_, index) => `prompt line ${index}`,
	).join("\n");
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{ id: "user:long", kind: "user", text: prompt, tone: "accent" },
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 24 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("prompt line 0");
		expect(collapsed).not.toContain("prompt line 8");
		const firstLine = collapsed
			.split("\n")
			.findIndex((line) => line.includes("prompt line 0"));
		const firstColumn =
			collapsed.split("\n")[firstLine]?.indexOf("prompt line 0") ?? 0;
		await t.mockMouse.click(firstColumn, firstLine);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("prompt line 11");
		await t.mockMouse.click(firstColumn, firstLine);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("prompt line 8");
	} finally {
		t.renderer.destroy();
	}
});

test("the reader can jump back to the newest transcript output", async () => {
	let scroll:
		| {
				scrollTop: number;
				scrollHeight: number;
				viewport: { height: number };
		  }
		| undefined;
	const blocks: AgentSessionBlock[] = Array.from(
		{ length: 40 },
		(_, index) => ({
			id: `row-${index}`,
			kind: "result",
			text: `transcript row ${index}`,
			tone: "success",
		}),
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(box) => {
					scroll = box as unknown as typeof scroll;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		if (scroll) scroll.scrollTop = 0;
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const lines = frame.split("\n");
		const actionLine = lines.findIndex((line) =>
			line.includes("Jump to latest"),
		);
		expect(actionLine).toBeGreaterThanOrEqual(0);
		const actionColumn = lines[actionLine]?.indexOf("Jump to latest") ?? 0;
		await t.mockMouse.click(actionColumn, actionLine);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("transcript row 39");
		expect(t.captureCharFrame()).not.toContain("Jump to latest");
		expect(scroll?.scrollTop).toBeGreaterThanOrEqual(
			Math.max(
				0,
				(scroll?.scrollHeight ?? 0) - (scroll?.viewport.height ?? 0) - 1,
			),
		);
	} finally {
		t.renderer.destroy();
	}
});

test("renders a provider error block", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b5",
						kind: "error",
						text: "400: MissingSessionID",
						tone: "error",
					},
				]}
				working={false}
				error="400: MissingSessionID"
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Error: 400: MissingSessionID");
	const errorSpan = t
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) => span.text.includes("Error: 400: MissingSessionID"));
	const actual = (
		errorSpan?.fg as { buffer?: Record<number, number> } | undefined
	)?.buffer;
	const expectedColor = parseColor(uiColors.error) as unknown as {
		r: number;
		g: number;
		b: number;
	};
	if (!actual) throw new Error("error row has no foreground color");
	expect(
		[actual[0] ?? -1, actual[1] ?? -1, actual[2] ?? -1].map(Math.round),
	).toEqual(
		[expectedColor.r, expectedColor.g, expectedColor.b].map((part) =>
			Math.round(part * 255),
		),
	);
	t.renderer.destroy();
});

test("status rows stay on the page background instead of tinted boxes", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "notice",
						kind: "notice",
						text: "Queued follow-up",
						tone: "warning",
					},
					{ id: "result", kind: "result", text: "done", tone: "success" },
					{ id: "error", kind: "error", text: "failed", tone: "error" },
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 24 },
	);
	try {
		await t.flush();
		const spans = t.captureSpans().lines.flatMap((line) => line.spans);
		const background = (text: string) => {
			const span = spans.find((item) => item.text.includes(text));
			const buffer = (
				span?.bg as { buffer?: Record<number, number> } | undefined
			)?.buffer;
			if (!buffer) return undefined;
			return [buffer[0] ?? -1, buffer[1] ?? -1, buffer[2] ?? -1].map(
				Math.round,
			);
		};
		const base = parseColor(uiColors.bgBase) as unknown as {
			r: number;
			g: number;
			b: number;
		};
		const expected = [base.r, base.g, base.b].map((part) =>
			Math.round(part * 255),
		);
		// The raised fill is reserved for prompts, user messages and tool calls;
		// notices, results and errors are drawn on the page background, with the
		// status color living in the marker and text.
		expect(background("Queued follow-up")).toEqual(expected);
		expect(background("done")).toEqual(expected);
		expect(background("failed")).toEqual(expected);
	} finally {
		t.renderer.destroy();
	}
});

test("renders a blocked Orchestrator message with a red model-selection error", async () => {
	let blocks: readonly AgentSessionBlock[] = [];
	guardOrchestratorSubmit(
		"please fix this",
		{},
		"local:orchestrator-model-gate:test",
		{
			onSubmit: () => {},
			onBlocked: (next) => {
				blocks = next;
			},
		},
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="orchestrator"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("please fix this");
	expect(frame).toContain("Error: No model and no thinking level are selected");
	expect(frame).toContain("/thinking, then send your message again.");
	const errorSpan = t
		.captureSpans()
		.lines.flatMap((line) => line.spans)
		.find((span) =>
			span.text.includes("Error: No model and no thinking level are selected"),
		);
	const actual = (
		errorSpan?.fg as { buffer?: Record<number, number> } | undefined
	)?.buffer;
	const expectedColor = parseColor(uiColors.error) as unknown as {
		r: number;
		g: number;
		b: number;
	};
	if (!actual) throw new Error("gate error row has no foreground color");
	expect(
		[actual[0] ?? -1, actual[1] ?? -1, actual[2] ?? -1].map(Math.round),
	).toEqual(
		[expectedColor.r, expectedColor.g, expectedColor.b].map((part) =>
			Math.round(part * 255),
		),
	);
	t.renderer.destroy();
});

test("typing a message and pressing Enter submits it, not /abort", async () => {
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "use approach B") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(submitted).toBe("use approach B");
	expect(aborted).toBe(false);
	t.renderer.destroy();
});

test("typing /abort and pressing Enter aborts instead of sending a message", async () => {
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/abort") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(aborted).toBe(true);
	expect(submitted).toBeUndefined();
	t.renderer.destroy();
});

test("typing /hide and pressing Enter hides the view without submitting or aborting", async () => {
	let closed = false;
	let submitted: string | undefined;
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {
					closed = true;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/hide") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(closed).toBe(true);
	expect(aborted).toBe(false);
	expect(submitted).toBeUndefined();
	t.renderer.destroy();
});

test("thinking blocks collapse to 'Thinking…' and Ctrl+T expands them", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b6",
						kind: "reasoning",
						text: "the hidden chain of thought",
						tone: "muted",
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const collapsed = t.captureCharFrame();
	expect(collapsed).toContain("Thinking…");
	expect(collapsed).not.toContain("the hidden chain of thought");
	t.mockInput.pressKey("t", { ctrl: true });
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("the hidden chain of thought");
	t.renderer.destroy();
});

test("a live thinking block collapses, expands, and keeps streaming into it", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{
			id: "live:reasoning",
			kind: "reasoning",
			text: "weighing options",
			tone: "muted",
			live: true,
		},
	]);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={blocks()}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Collapsed by default, exactly like a committed one.
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("Thinking…");
		// A live thinking block carries the same animated marker as a running
		// tool; a committed thought does not.
		expect(collapsed).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Thinking…/);
		expect(collapsed).not.toContain("weighing options");
		t.mockInput.pressKey("t", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("weighing options");
		// The fold keeps its state as the partial grows: later watch frames carry
		// more text into the same open block.
		setBlocks(() => [
			{
				id: "live:reasoning",
				kind: "reasoning",
				text: "weighing options and the parser",
				tone: "muted",
				live: true,
			},
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("and the parser");
	} finally {
		t.renderer.destroy();
	}
});

test("a thinking block with a measured duration renders 'Thought: 1.6s'", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b7",
						kind: "reasoning",
						text: "weighing options",
						tone: "muted",
						durationMs: 1600,
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	expect(t.captureCharFrame()).toContain("Thought: 1.6s");
	t.renderer.destroy();
});

test("assistant text renders as markdown without a status box", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b8",
						kind: "assistant",
						text: "- first item\n- second item",
						tone: "base",
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = await t.waitForFrame((value) => value.includes("second item"));
	expect(frame).toContain("first item");
	expect(frame).toContain("second item");
	t.renderer.destroy();
});

test("renders the assistant footer and the context/cost meter", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				history={[]}
				onHistoryAppend={() => {}}
				blocks={[
					{
						id: "b9",
						kind: "summary",
						text: "opencode-go/deepseek · 4.1K out",
						tone: "muted",
					},
				]}
				working={false}
				contextTokens={63900}
				contextWindow={1000000}
				cost={0.012}
				models={[]}
				thinkingLevels={[]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	const frame = t.captureCharFrame();
	expect(frame).toContain("Worker · opencode-go/deepseek · 4.1K out");
	expect(frame).toContain("63.9K (6%) · $0.01");
	t.renderer.destroy();
});

test("typing / opens the command autocomplete and Tab completes the command", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressKey("/");
	await t.renderOnce();
	const open = t.captureCharFrame();
	expect(open).toContain("/model");
	expect(open).toContain("/timeline");
	expect(open).toContain("/latest");
	expect(open).toContain("Change the model for this run");
	expect(open).toContain("Change the thinking level");
	// Tab completes the highlighted command into the draft.
	t.mockInput.pressArrow("down");
	t.mockInput.pressTab();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("/thinking");
	t.renderer.destroy();
});

test("the autocomplete's highlighted command runs on Enter", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressKey("/");
	await t.renderOnce();
	// Second entry is /thinking, which opens the thinking picker.
	t.mockInput.pressArrow("down");
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Select thinking level");
	t.renderer.destroy();
});

test("/model opens the picker and the prompt follows the selected model", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	// The host's watch carries the new model back as metadata; the prompt reads
	// it through a reactive prop, so the footer must not stay on the old one.
	const [model, setModel] = createSignal<string | undefined>(
		"opencode-go/deepseek-v4.1-flash",
	);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				history={[]}
				model={model()}
				onHistoryAppend={() => {}}
				models={[
					"opencode-go/deepseek-v4.1-flash",
					"openai-codex/gpt-5.6-luna",
				]}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => {
					configured = change;
					if (change.model) setModel(change.model);
				}}
				onCompact={() => {}}
				onPickerKeyReady={(value) => {
					handler = value as unknown as (event: { name: string }) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		expect(t.captureCharFrame()).toContain(
			"Worker · opencode-go/deepseek-v4.1-flash",
		);
		for (const character of "/model") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		handler?.({ name: "j" });
		handler?.({ name: "enter" });
		expect(configured).toEqual({ model: "openai-codex/gpt-5.6-luna" });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(
			"Worker · openai-codex/gpt-5.6-luna",
		);
		// opencode spells the command `/models`, and reopening the picker starts
		// on the model the prompt now shows: Enter accepts it instead of silently
		// selecting the first catalog entry again.
		configured = undefined;
		for (const character of "/models") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		handler?.({ name: "enter" });
		expect(configured as { model?: string } | undefined).toEqual({
			model: "openai-codex/gpt-5.6-luna",
		});
	} finally {
		t.renderer.destroy();
	}
});

test("the command autocomplete filters live as the command is typed", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressKey("/");
		await t.renderOnce();
		const open = t.captureCharFrame();
		expect(open).toContain("/model");
		expect(open).toContain("/thinking");
		expect(open).toContain("/compact");

		for (const character of "mo") t.mockInput.pressKey(character);
		await t.renderOnce();
		const filtered = t.captureCharFrame();
		expect(filtered).toContain("/model");
		expect(filtered).not.toContain("/thinking");
		expect(filtered).not.toContain("/compact");

		// A query with no command closes the list, and deleting the character
		// that stopped matching brings it back.
		t.mockInput.pressKey("x");
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("/model");
		t.mockInput.pressBackspace();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("/model");
	} finally {
		t.renderer.destroy();
	}
});

test("/compact is offered, forwards its instructions and never sends a prompt", async () => {
	const compacted: Array<string | undefined> = [];
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
				onCompact={(instructions) => compacted.push(instructions)}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		// `/com` autocompletes to the command, description included.
		for (const character of "/com") t.mockInput.pressKey(character);
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("/compact");
		expect(frame).toContain("Summarize the context");
		// The bare command runs the compaction and asks for no instructions.
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(compacted).toEqual([undefined]);
		expect(submitted).toEqual([]);

		// Free text after the command is the summarizer's guidance; the prompt is
		// cleared instead of being sent as a message.
		for (const character of "/compact focus on the open findings")
			t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(compacted).toEqual([undefined, "focus on the open findings"]);
		expect(submitted).toEqual([]);
	} finally {
		t.renderer.destroy();
	}
});

/** The route's `agent-session-picker` layer, built from the modal's own key
 * list: while a picker is open the prompt input is unfocused, so the picker's
 * keys (including the terminal's Enter spelling) reach the modal through the
 * keymap rather than through the input. */
function PickerRoute(props: {
	onSubmit: (text: string) => void;
	onConfigure: (change: { model?: string; thinking?: string }) => void;
	blocks?: readonly AgentSessionBlock[];
}) {
	const renderer = useRenderer();
	const keymap = createDefaultOpenTuiKeymap(renderer);
	const [draft, setDraft] = createSignal("");
	let handler: ((event: KeyEvent) => boolean) | undefined;
	const dispose = keymap.registerLayer({
		priority: 1100,
		commands: [
			{
				name: "agent-session-picker.handle",
				run: ({ event }) => (handler ? handler(event) : false),
			},
		],
		bindings: SESSION_PICKER_KEYS.map((key) => ({
			key,
			cmd: "agent-session-picker.handle",
		})),
	});
	onCleanup(dispose);
	return (
		<AgentSessionView
			role="worker"
			blocks={props.blocks ?? []}
			working={false}
			models={["opencode-go/deepseek-v4.1-flash", "openai-codex/gpt-5.6-luna"]}
			thinkingLevels={["off", "low"]}
			draft={draft()}
			history={[]}
			onHistoryAppend={() => {}}
			onDraftChange={setDraft}
			onSubmit={props.onSubmit}
			onAbort={() => {}}
			onBack={() => {}}
			onConfigure={props.onConfigure}
			onCompact={() => {}}
			onPickerKeyReady={(value) => {
				handler = value;
			}}
		/>
	);
}

test("/timeline lists prompts and jumps to older messages outside the live window", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "user:early",
			kind: "user",
			text: "Earlier request: inspect the parser",
			tone: "accent",
			startedAt: 1_700_000_000_000,
		},
		...Array.from({ length: 80 }, (_, index) => ({
			id: `output:${index}`,
			kind: "result" as const,
			text: `output row ${index}`,
			tone: "success" as const,
		})),
		{
			id: "user:latest",
			kind: "user",
			text: "Latest follow-up",
			tone: "accent",
		},
		{
			id: "assistant:latest",
			kind: "assistant",
			text: "The parser is fixed",
			tone: "base",
		},
	];
	const t = await testRender(
		() => (
			<PickerRoute blocks={blocks} onSubmit={() => {}} onConfigure={() => {}} />
		),
		{ width: 100, height: 24 },
	);
	try {
		await t.flush();
		for (const character of "/timeline") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		const picker = t.captureCharFrame();
		expect(picker).toContain("Jump to message");
		expect(picker).toContain("Latest follow-up");
		expect(picker).toContain("Earlier request: inspect the parser");
		// Newest prompt is first; one `j` selects the older prompt.
		t.mockInput.pressKey("j");
		t.mockInput.pressEnter();
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain(
			"Earlier request: inspect the parser",
		);
		expect(t.captureCharFrame()).not.toContain("Jump to message");
	} finally {
		t.renderer.destroy();
	}
});

test("the picker layer selects on the terminal's Enter spelling", async () => {
	const configured: Array<{ model?: string; thinking?: string }> = [];
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<PickerRoute
				onConfigure={(change) => configured.push(change)}
				onSubmit={(text) => submitted.push(text)}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const character of "/model") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select model");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(configured).toEqual([{ model: "openai-codex/gpt-5.6-luna" }]);
		expect(submitted).toEqual([]);
		// The prompt accepts ordinary keys again once the picker is closed.
		for (const character of "carry on") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toEqual(["carry on"]);
	} finally {
		t.renderer.destroy();
	}
});

test("model and thinking slash commands remain available while prompts are gated", async () => {
	const configured: Array<{ model?: string; thinking?: string }> = [];
	const blocked: AgentSessionBlock[][] = [];
	let pickerHandler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="orchestrator"
				blocks={[]}
				working={false}
				history={[]}
				onHistoryAppend={() => {}}
				models={["provider/model"]}
				thinkingLevels={["off", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={(text) =>
					guardOrchestratorSubmit(text, {}, "gate-test", {
						onSubmit: () => {},
						onBlocked: (blocks) => blocked.push([...blocks]),
					})
				}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => configured.push(change)}
				onCompact={() => {}}
				onPickerKeyReady={(handler) => {
					pickerHandler = handler as unknown as (event: {
						name: string;
					}) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const command of ["/model", "/thinking"]) {
			for (const character of command) t.mockInput.pressKey(character);
			t.mockInput.pressEnter();
			await t.renderOnce();
			expect(t.captureCharFrame()).toContain(
				command === "/model" ? "Select model" : "Select thinking level",
			);
			pickerHandler?.({ name: "enter" });
			await t.renderOnce();
		}
		expect(configured).toEqual([
			{ model: "provider/model" },
			{ thinking: "off" },
		]);
		expect(blocked).toEqual([]);
		for (const character of "plain prompt") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(blocked[0]?.[0]?.text).toBe("plain prompt");
	} finally {
		t.renderer.destroy();
	}
});

test("/thinking opens the picker and selecting applies the thinking override", async () => {
	let configured: { model?: string; thinking?: string } | undefined;
	let handler: ((event: { name: string }) => boolean) | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				history={[]}
				onHistoryAppend={() => {}}
				thinkingLevels={["off", "low", "medium", "high"]}
				draft=""
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={(change) => {
					configured = change;
				}}
				onCompact={() => {}}
				onPickerKeyReady={(value) => {
					handler = value as unknown as (event: { name: string }) => boolean;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	for (const character of "/thinking") t.mockInput.pressKey(character);
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(t.captureCharFrame()).toContain("Select thinking level");
	handler?.({ name: "j" });
	handler?.({ name: "j" });
	handler?.({ name: "enter" });
	expect(configured).toEqual({ thinking: "medium" });
	t.renderer.destroy();
});

test("an empty submission does nothing", async () => {
	let calls = 0;
	const t = await testRender(
		() => (
			<Harness
				onSubmit={() => {
					calls++;
				}}
				onAbort={() => {
					calls++;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	await t.flush();
	t.mockInput.pressEnter();
	await t.renderOnce();
	expect(calls).toBe(0);
	t.renderer.destroy();
});

test("empty prompt recalls submitted input; arrows browse history without overwriting edits", async () => {
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		for (const text of ["first input", "second input"]) {
			for (const character of text) t.mockInput.pressKey(character);
			t.mockInput.pressEnter();
			await t.renderOnce();
		}
		expect(submitted).toEqual(["first input", "second input"]);
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("second input");
		t.mockInput.pressArrow("up");
		t.mockInput.pressArrow("up"); // Clamp at oldest.
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("first input");
		t.mockInput.pressArrow("down");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("second input");
		t.mockInput.pressArrow("down");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Ask anything…");
		for (const character of "new draft") t.mockInput.pressKey(character);
		t.mockInput.pressArrow("up");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted.at(-1)).toBe("new draft");
		t.mockInput.pressArrow("up");
		t.mockInput.pressKey("!");
		t.mockInput.pressArrow("up");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted.at(-1)).toBe("new draft!");
	} finally {
		t.renderer.destroy();
	}
});

test("restored history recalls slash commands without interfering with typed autocomplete", async () => {
	let aborted = false;
	const t = await testRender(
		() => (
			<Harness
				history={["saved message", "/abort"]}
				onSubmit={() => {}}
				onAbort={() => {
					aborted = true;
				}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("/abort");
		t.mockInput.pressArrow("up");
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("saved message");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(aborted).toBe(true);
		t.mockInput.pressKey("/");
		t.mockInput.pressArrow("down");
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("Select thinking level");
	} finally {
		t.renderer.destroy();
	}
});

test("a frame that arrives while scrolled up leaves the viewport alone", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 20 }, (_, index) => ({
			id: "b10",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box: { scrollBy: (delta: number) => void; scrollTop: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(value) => {
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// The keymap scrolls with `scrollBy`, which the box's sticky logic does
		// not read as "the reader left the bottom".
		box?.scrollBy(-12);
		await t.renderOnce();
		// The top row of the viewport, so the assertion is about position rather
		// than about how far one scroll happened to move.
		const topLine = (frame: string) =>
			Number(/line (\d+)/.exec(frame)?.[1] ?? -1);
		const scrolled = t.captureCharFrame();
		expect(topLine(scrolled)).toBeGreaterThan(0);
		expect(scrolled).not.toContain("line 19");

		// New output arrives: the viewport stays where the reader left it.
		setBlocks((current) => [
			...current,
			{ id: "b11", kind: "assistant", text: "a new answer", tone: "base" },
		]);
		await t.renderOnce();
		const after = t.captureCharFrame();
		expect(topLine(after)).toBe(topLine(scrolled));
		expect(after).not.toContain("a new answer");
	} finally {
		t.renderer.destroy();
	}
});

test("output arriving while scrolled up does not slide the transcript", async () => {
	// More rows than the window renders, so the window would slide (and drag the
	// viewport toward the bottom with it) if it were not anchored.
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 100 }, (_, index) => ({
			id: "b12",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box: { scrollBy: (delta: number) => void; scrollTop: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(value) => {
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	/** The line at the top of the viewport. */
	const topLine = () => Number(/line (\d+)/.exec(t.captureCharFrame())?.[1]);
	try {
		await t.renderOnce();
		await t.renderOnce();
		box?.scrollBy(-20);
		await t.renderOnce();
		const scrolled = box?.scrollTop ?? 0;
		const top = topLine();
		expect(top).toBeGreaterThan(0);

		for (let index = 0; index < 4; index++) {
			setBlocks((current) => [
				...current,
				{
					id: "b13",
					kind: "assistant",
					text: `streaming ${index}`,
					tone: "base",
				},
			]);
			await t.renderOnce();
		}
		expect(box?.scrollTop).toBe(scrolled);
		expect(topLine()).toBe(top);
	} finally {
		t.renderer.destroy();
	}
});

test("reaching the top loads the older rows the window left out", async () => {
	const [blocks] = createSignal<readonly AgentSessionBlock[]>(
		Array.from({ length: 80 }, (_, index) => ({
			id: "b14",
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	);
	let box:
		| {
				scrollTop: number;
				scrollHeight: number;
		  }
		| undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(value) => {
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const opened = box?.scrollHeight ?? 0;
		expect(t.captureCharFrame()).not.toContain("line 0");

		// Reaching the top renders the older rows the window left out.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		await t.renderOnce();
		expect(box?.scrollHeight ?? 0).toBeGreaterThan(opened);

		// The loaded rows are above the viewport, so scrolling on reaches them.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("line 0");
	} finally {
		t.renderer.destroy();
	}
});

test("the divider opens the newest run of the model's output", async () => {
	const [blocks, setBlocks] = createSignal<readonly AgentSessionBlock[]>([
		{ id: "u1", kind: "user", text: "first question", tone: "accent" },
		{ id: "a1", kind: "assistant", text: "first answer", tone: "base" },
		{ id: "s1", kind: "summary", text: "600 out", tone: "muted" },
	]);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 20 },
	);
	const rows = () => t.captureCharFrame().trimEnd().split("\n");
	const rowOf = (text: string) =>
		rows().findIndex((line) => line.includes(text));
	const dividerRow = () =>
		rows().findIndex((line) => line.includes("new ↓") && line.includes("─"));
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Opening a page adds no output, so nothing is separated.
		expect(dividerRow()).toBe(-1);

		// The model answers the first question: the divider opens that answer,
		// below the user's message.
		setBlocks((current) => [
			...current,
			{ id: "u2", kind: "user", text: "second question", tone: "accent" },
			{ id: "a2", kind: "assistant", text: "second answer", tone: "base" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeGreaterThan(rowOf("second question"));
		expect(dividerRow()).toBeLessThan(rowOf("second answer"));

		// The turn's own steps join the same run: the divider stays put.
		setBlocks((current) => [
			...current,
			{ id: "s2", kind: "summary", text: "4 out", tone: "muted" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeLessThan(rowOf("4 out"));
		expect(dividerRow()).toBeGreaterThan(rowOf("second question"));

		// A new user message does not move it: the divider marks output, and
		// keeps the position it had until the model answers.
		setBlocks((current) => [
			...current,
			{ id: "u3", kind: "user", text: "third question", tone: "accent" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeLessThan(rowOf("third question"));

		// The next answer starts the next run.
		setBlocks((current) => [
			...current,
			{ id: "a3", kind: "assistant", text: "third answer", tone: "base" },
		]);
		await t.renderOnce();
		expect(dividerRow()).toBeGreaterThan(rowOf("third question"));
		expect(dividerRow()).toBeLessThan(rowOf("third answer"));
	} finally {
		t.renderer.destroy();
	}
});

test("an expanded block stays expanded when the window loads older rows", async () => {
	const [blocks] = createSignal<readonly AgentSessionBlock[]>([
		...Array.from({ length: 70 }, (_, index) => ({
			id: `r${index}`,
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
			detail: [`detail ${index}`],
		})),
		{ id: "think", kind: "reasoning", text: "weighing options", tone: "muted" },
	]);
	let box: { scrollTop: number; scrollHeight: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(value) => {
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Ctrl+T expands the thinking block.
		t.mockInput.pressKey("t", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("weighing options");

		// Loading older rows shifts every rendered row's position: the expansion
		// follows the block, not the position.
		if (box) box.scrollTop = 0;
		await t.renderOnce();
		await t.renderOnce();
		if (box) box.scrollTop = box.scrollHeight;
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("weighing options");
		expect(frame).not.toContain("detail 59");
	} finally {
		t.renderer.destroy();
	}
});

test("tool rows get a view from their call and result, and a generic default", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "r1",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts", offset: 40, limit: 80 },
				callId: "c1",
				result: {
					lines: ["const a = 1;"],
					isError: false,
					notes: ["Showing lines 40-120 of 512. Use offset=121 to continue."],
				},
			},
		},
		{
			id: "e1",
			kind: "tool",
			text: "edit path=src/a.ts",
			tone: "success",
			icon: "←",
			tool: "edit",
			toolCall: {
				name: "edit",
				args: { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] },
				callId: "c2",
				result: {
					lines: ["Successfully replaced 1 block(s) in src/a.ts."],
					isError: false,
					details: { diff: "-const a = 1;\n+const b = 2;" },
					notes: [],
				},
			},
		},
		{
			id: "j1",
			kind: "tool",
			text: "ask_jev",
			tone: "success",
			icon: "◆",
			tool: "ask_jev",
			toolCall: {
				name: "ask_jev",
				args: { questions: { leak: { type: "noul" } }, paths: ["src/a.ts"] },
				callId: "c3",
				result: {
					lines: [
						"## Jev",
						"state s1 · judged files (1), 12.3k tokens",
						"",
						"leak (noul): 0.12 confidence 0.93",
					],
					isError: false,
					details: { answers: { leak: { noul: 0.12, confidence: 0.93 } } },
					notes: [],
				},
			},
		},
		{
			id: "p1",
			kind: "tool",
			text: "agent_ask role=planner",
			tone: "success",
			icon: "•",
			tool: "agent_ask",
			toolCall: { name: "agent_ask", args: { role: "planner" } },
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 70 },
	);
	const diffSign = (source: string, sign: string) =>
		t
			.captureSpans()
			.lines.find((line) =>
				line.spans
					.map((span) => span.text)
					.join("")
					.includes(source),
			)
			?.spans.find((span) => span.text.includes(sign));
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		// Each view names its own subject: the file, the range, the command.
		expect(collapsed).toContain("→ Read src/a.ts");
		expect(collapsed).toContain("40-120 of 512");
		expect(collapsed).toContain("← Edit src/a.ts");
		expect(collapsed).toContain("1 edit · +1 −1");
		// The judgment view names the verdict; a tool without a view keeps the
		// generic row.
		expect(collapsed).toContain("◆ Judge files (1)");
		expect(collapsed).toContain("leak (noul) · 0.12");
		expect(collapsed).toContain("Agent ask planner");

		// Tool output is already expanded by default.
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("- const a = 1;");
		expect(expanded).toContain("+ const b = 2;");
		expect(expanded).toContain("const a = 1;");
		// Additions and removals carry their own tone.
		const rgb = (color: unknown) => {
			const buffer = (color as { buffer: Record<string, number> }).buffer;
			return [buffer[0], buffer[1], buffer[2]].map(Math.round).join(",");
		};
		const theme = (hex: string) => {
			const parsed = parseColor(hex) as unknown as {
				r: number;
				g: number;
				b: number;
			};
			// RGBA carries normalized components; the spans carry bytes.
			return [parsed.r, parsed.g, parsed.b]
				.map((part) => Math.round(part * 255))
				.join(",");
		};
		// Source uses syntax colors; the dedicated diff signs keep change colors.
		expect(rgb(diffSign("const b = 2;", "+")?.fg)).toBe(
			theme(uiColors.diffAdded),
		);
		expect(rgb(diffSign("- const a = 1;", "-")?.fg)).toBe(
			theme(uiColors.diffRemoved),
		);
		expect(rgb(diffSign("const b = 2;", "+")?.bg)).toBe(
			theme(uiColors.diffAddedBg),
		);
		expect(rgb(diffSign("- const a = 1;", "-")?.bg)).toBe(
			theme(uiColors.diffRemovedBg),
		);
	} finally {
		t.renderer.destroy();
	}
});

test("tool-view headers keep their label regular and their hint muted", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "read",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts", offset: 40, limit: 80 },
				result: {
					lines: ["const a = 1;"],
					isError: false,
					notes: ["Showing lines 40-120 of 512. Use offset=121 to continue."],
				},
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const spans = t.captureSpans();
		const foreground = (text: string) => {
			for (const line of spans.lines) {
				for (const span of line.spans) {
					if (span.text.includes(text)) return span.fg;
				}
			}
			return undefined;
		};
		const rgb = (color: unknown) => {
			const buffer = (color as { buffer: Record<string, number> }).buffer;
			return [buffer[0], buffer[1], buffer[2]].map(Math.round).join(",");
		};
		const theme = (hex: string) => {
			const parsed = parseColor(hex) as unknown as {
				r: number;
				g: number;
				b: number;
			};
			return [parsed.r, parsed.g, parsed.b]
				.map((part) => Math.round(part * 255))
				.join(",");
		};
		// The call's subject is the primary content; the range is supporting
		// context, and the action glyph sits between the two weights.
		expect(rgb(foreground("Read src/a.ts"))).toBe(theme(uiColors.textPrimary));
		expect(rgb(foreground("40-120 of 512"))).toBe(theme(uiColors.textMuted));
		expect(rgb(foreground("→"))).toBe(theme(uiColors.textMuted));
	} finally {
		t.renderer.destroy();
	}
});

test("generic tool output and result detail use primary text", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "search",
			kind: "tool",
			text: "search pattern=needle",
			tone: "success",
			icon: "✱",
			tool: "search",
			request: "pattern: needle",
			detail: ["src/a.ts:1: const needle = 1;"],
		},
		{
			id: "missing",
			kind: "tool",
			text: "grep pattern=missing",
			tone: "error",
			icon: "✱",
			tool: "grep",
			request: "pattern: missing",
			detail: ["no matches"],
		},
		{
			id: "result",
			kind: "result",
			text: "Command finished",
			tone: "success",
			detail: ["line one"],
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const spans = t.captureSpans();
		const foreground = (text: string) => {
			for (const line of spans.lines) {
				for (const span of line.spans) {
					if (span.text.includes(text)) return span.fg;
				}
			}
			return undefined;
		};
		const rgb = (color: unknown) => {
			const buffer = (color as { buffer: Record<string, number> }).buffer;
			return [buffer[0], buffer[1], buffer[2]].map(Math.round).join(",");
		};
		const theme = (hex: string) => {
			const parsed = parseColor(hex) as unknown as {
				r: number;
				g: number;
				b: number;
			};
			return [parsed.r, parsed.g, parsed.b]
				.map((part) => Math.round(part * 255))
				.join(",");
		};
		// A request is supporting context; successful output and result detail
		// are what the reader came for. A failed call's output stays red.
		expect(rgb(foreground("pattern: needle"))).toBe(theme(uiColors.textMuted));
		expect(rgb(foreground("const needle = 1;"))).toBe(
			theme(uiColors.textPrimary),
		);
		expect(rgb(foreground("no matches"))).toBe(theme(uiColors.error));
		expect(rgb(foreground("line one"))).toBe(theme(uiColors.textPrimary));
	} finally {
		t.renderer.destroy();
	}
});

test("every tool row uses the raised block surface", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "r1",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts" },
				result: { lines: ["a"], isError: false, notes: [] },
			},
		},
		{
			id: "s1",
			kind: "tool",
			text: "search query=needle",
			tone: "success",
			icon: "•",
			tool: "search",
			toolCall: {
				name: "search",
				args: { query: "needle" },
				result: { lines: ["src/a.ts"], isError: false, notes: [] },
			},
			detail: ["src/a.ts"],
		},
		{
			id: "b1",
			kind: "tool",
			text: "bash command=bun test",
			tone: "success",
			icon: "$",
			tool: "bash",
			toolCall: {
				name: "bash",
				args: { command: "bun test" },
				result: { lines: ["ok"], isError: false, notes: [] },
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 70 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const lines = frame.split("\n");
		const row = (needle: string) =>
			lines.find((line) => line.includes(needle)) ?? "";
		// A specialized view and the generic fallback share the same raised block:
		// the heavy left rule is the first cell of every tool row.
		expect(row("Read src/a.ts")).toContain("→ Read src/a.ts");
		expect(row("Read src/a.ts").trimStart().startsWith("┃")).toBe(true);
		// The block keeps one blank line of its raised surface above and below the
		// call, rather than letting the header touch the block's edge.
		const readLine = lines.findIndex((line) => line.includes("Read src/a.ts"));
		expect(readLine).toBeGreaterThan(0);
		expect(lines[readLine - 1]).toMatch(/^┃\s*$/);
		expect(lines[readLine + 1]).toMatch(/^┃\s*$/);
		expect(lines[readLine + 2]).toMatch(/^┃\s+1 a\s*$/);
		expect(lines[readLine + 3]).toMatch(/^┃\s*$/);
		expect(row("Search “needle”")).toContain("✱ Search “needle”");
		expect(row("Search “needle”").trimStart().startsWith("┃")).toBe(true);
		expect(row("bun test")).toContain("$ bun test");
		expect(row("bun test").trimStart().startsWith("┃")).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});

test("transcript rows lift on hover and settle when the pointer leaves", async () => {
	const blocks: AgentSessionBlock[] = [
		{ id: "u1", kind: "user", text: "hover this prompt", tone: "accent" },
		{
			id: "t1",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/a.ts" },
				result: { lines: ["const a = 1;"], isError: false, notes: [] },
			},
		},
		{ id: "r1", kind: "result", text: "read complete", tone: "success" },
		{ id: "think", kind: "reasoning", text: "weighing options", tone: "muted" },
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 29 },
	);
	const background = (text: string) => {
		for (const line of t.captureSpans().lines) {
			for (const span of line.spans) {
				if (!span.text.includes(text)) continue;
				const buffer = span.bg.buffer;
				return [buffer[0] ?? -1, buffer[1] ?? -1, buffer[2] ?? -1]
					.map(Math.round)
					.join(",");
			}
		}
		return undefined;
	};
	const rowOf = (text: string) =>
		t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes(text));
	const theme = (hex: string) => {
		const parsed = parseColor(hex) as unknown as {
			r: number;
			g: number;
			b: number;
		};
		return [parsed.r, parsed.g, parsed.b]
			.map((part) => Math.round(part * 255))
			.join(",");
	};
	const resting = theme(uiColors.bgMantle);
	const lifted = theme(uiColors.bgHover);
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(background("hover this prompt")).toBe(resting);
		expect(background("Read src/a.ts")).toBe(resting);
		const thinkingResting = background("Thinking");

		// A prompt is a raised block too: the pointer lifts only the block under
		// it, not the rest of the transcript.
		const promptRow = rowOf("hover this prompt");
		expect(promptRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(10, promptRow);
		await t.renderOnce();
		expect(background("hover this prompt")).toBe(lifted);
		expect(background("Read src/a.ts")).toBe(resting);

		// Moving from the block's padding onto its label is still one hover.
		const toolRow = rowOf("Read src/a.ts");
		expect(toolRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(10, toolRow);
		await t.renderOnce();
		expect(background("hover this prompt")).toBe(resting);
		expect(background("Read src/a.ts")).toBe(lifted);

		// Status rows are not raised surfaces, so leaving for one settles the
		// block it left.
		const resultRow = rowOf("read complete");
		expect(resultRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(10, resultRow);
		await t.renderOnce();
		expect(background("Read src/a.ts")).toBe(resting);

		// Thinking is a flat, click-to-fold row rather than a raised block, but
		// it still answers the pointer with the same hover surface.
		const thinkingRow = rowOf("Thinking");
		expect(thinkingRow).toBeGreaterThanOrEqual(0);
		await t.mockMouse.moveTo(10, thinkingRow);
		await t.renderOnce();
		expect(background("Thinking")).toBe(lifted);

		await t.mockMouse.moveTo(10, resultRow);
		await t.renderOnce();
		expect(background("Thinking")).toBe(thinkingResting);
	} finally {
		t.renderer.destroy();
	}
});

test("browser tools carry the browser glyph before their action icon", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "browser",
			kind: "tool",
			text: "browser_snapshot stage=checkout",
			tone: "success",
			icon: "•",
			tool: "browser_snapshot",
		},
		{
			id: "pending",
			kind: "tool",
			text: "browser_click ref=e3",
			tone: "warning",
			icon: "•",
			tool: "browser_click",
			pending: true,
			live: true,
			toolCall: { name: "browser_click", args: { ref: "e3" }, callId: "c1" },
		},
		{
			id: "stage",
			kind: "tool",
			text: "stage_step",
			tone: "success",
			icon: "•",
			tool: "stage_step",
		},
		{
			id: "read",
			kind: "tool",
			text: "read path=src/a.ts",
			tone: "success",
			icon: "→",
			tool: "read",
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 40 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const lines = t.captureCharFrame().split("\n");
		const row = (needle: string) =>
			lines.find((line) => line.includes(needle)) ?? "";
		// The browser family glyph sits immediately before the action icon, with
		// the usual gap before the label.
		expect(row("browser_snapshot stage=checkout")).toContain(
			`${BROWSER_TOOL_GLYPH}• browser_snapshot stage=checkout`,
		);
		// A running browser call keeps the glyph in front of its spinner.
		expect(row("e3")).toContain(BROWSER_TOOL_GLYPH);
		// Stage tools are a separate family, and other tools are unaffected.
		expect(row("stage_step")).toContain("• stage_step");
		expect(row("stage_step")).not.toContain(BROWSER_TOOL_GLYPH);
		expect(row("read path=src/a.ts")).toContain("→ read path=src/a.ts");
		expect(row("read path=src/a.ts")).not.toContain(BROWSER_TOOL_GLYPH);
	} finally {
		t.renderer.destroy();
	}
});

test("a tool block's left rule carries its running, success or failure state", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "running",
			kind: "tool",
			text: "read path=src/running.ts",
			tone: "warning",
			icon: "→",
			tool: "read",
			pending: true,
			live: true,
			toolCall: {
				name: "read",
				args: { path: "src/running.ts" },
				callId: "run",
			},
		},
		{
			id: "success",
			kind: "tool",
			text: "read path=src/ok.ts",
			tone: "success",
			icon: "→",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/ok.ts" },
				callId: "ok",
				result: { lines: ["ok"], isError: false, notes: [] },
			},
		},
		{
			id: "failure",
			kind: "tool",
			text: "bash command=bun failing-test",
			tone: "error",
			icon: "$",
			tool: "bash",
			toolCall: {
				name: "bash",
				args: { command: "bun failing-test" },
				callId: "bad",
				result: { lines: ["failed"], isError: true, notes: [] },
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 24 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const spans = t.captureSpans();
		const rule = (needle: string) => {
			const line = spans.lines.find((line) =>
				line.spans.some((span) => span.text.includes(needle)),
			);
			return line?.spans.find((span) => span.text.includes("┃"))?.fg;
		};
		const rgb = (color: unknown) => {
			const buffer = (color as { buffer?: Record<number, number> } | undefined)
				?.buffer;
			if (!buffer) return undefined;
			return [buffer[0] ?? -1, buffer[1] ?? -1, buffer[2] ?? -1]
				.map(Math.round)
				.join(",");
		};
		const theme = (hex: string) => {
			const parsed = parseColor(hex) as unknown as {
				r: number;
				g: number;
				b: number;
			};
			return [parsed.r, parsed.g, parsed.b]
				.map((part) => Math.round(part * 255))
				.join(",");
		};
		expect(rgb(rule("Reading src/running.ts"))).toBe(theme(uiColors.textMuted));
		expect(rgb(rule("Read src/ok.ts"))).toBe(theme(uiColors.success));
		expect(rgb(rule("bun failing-test"))).toBe(theme(uiColors.error));
	} finally {
		t.renderer.destroy();
	}
});

test("consecutive successful reads group without adding or replacing tools", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "read-a",
			kind: "tool",
			text: "read: alpha contents",
			tone: "success",
			icon: "✓",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/alpha.ts" },
				callId: "call-a",
				result: { lines: ["alpha contents"], isError: false, notes: [] },
			},
			detail: ["alpha contents"],
		},
		{
			id: "read-b",
			kind: "tool",
			text: "read: beta contents",
			tone: "success",
			icon: "✓",
			tool: "read",
			toolCall: {
				name: "read",
				args: { path: "src/beta.ts" },
				callId: "call-b",
				result: { lines: ["beta contents"], isError: false, notes: [] },
			},
			detail: ["beta contents"],
		},
		{
			id: "read-pending",
			kind: "tool",
			text: "read path=src/gamma.ts",
			tone: "warning",
			icon: "→",
			tool: "read",
			pending: true,
			live: true,
			toolCall: {
				name: "read",
				args: { path: "src/gamma.ts" },
				callId: "call-gamma",
			},
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 35 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("2 reads");
		expect(collapsed).toContain("src/alpha.ts");
		expect(collapsed).toContain("src/beta.ts");
		expect(collapsed).toContain("src/gamma.ts");
		const groupLine = collapsed
			.split("\n")
			.findIndex((line) => line.includes("2 reads"));
		// A grouped read summary is still a tool row and keeps the raised block.
		expect(collapsed.split("\n")[groupLine]?.trimStart().startsWith("┃")).toBe(
			true,
		);
		await t.mockMouse.click(8, groupLine);
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).not.toContain("src/alpha.ts");
		expect(expanded).not.toContain("src/beta.ts");
	} finally {
		t.renderer.destroy();
	}
});

test("a running tool shows an in-progress row that its result replaces in place", async () => {
	const running: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash command=npm test",
			tone: "warning",
			icon: "$",
			tool: "bash",
			pending: true,
			live: true,
			toolCall: { name: "bash", args: { command: "npm test" }, callId: "c1" },
			detail: ["compiling…"],
		},
	];
	const finished: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash: all good",
			tone: "success",
			icon: "✓",
			tool: "bash",
			pending: false,
			toolCall: {
				name: "bash",
				args: { command: "npm test" },
				callId: "c1",
				result: { lines: ["all good"], isError: false, notes: [] },
			},
			detail: ["all good"],
		},
	];
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(running);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const pending = t.captureCharFrame();
		// The call's subject appears as soon as it starts, with opencode's
		// animated spinner in the icon gutter.
		expect(pending).toContain("npm test");
		expect(pending).not.toContain("running…");
		expect(pending).not.toContain("$ npm test");
		expect(pending).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] npm test/);
		// No result section yet: the answer is not on screen while the call runs.
		expect(pending).not.toContain("all good");
		expect(pending.match(/npm test/g)).toHaveLength(1);

		// Live output is visible without opening the tool; expansion retains it.
		expect(pending).toContain("compiling…");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("compiling…");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();

		// The result lands at the same position: one row, now the finished view.
		setBlocks(finished);
		await t.renderOnce();
		await t.renderOnce();
		const done = t.captureCharFrame();
		expect(done).not.toContain("running…");
		expect(done).toContain("$ npm test");
		expect(done).toContain("1 lines");
		expect(done.match(/npm test/g)).toHaveLength(1);
	} finally {
		t.renderer.destroy();
	}
});

test("a streaming write stays one compact line instead of its content", async () => {
	const content = Array.from(
		{ length: 400 },
		(_, index) => `line ${index}`,
	).join("\n");
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{
						id: "w1",
						kind: "tool",
						text: "write path=src/a.ts",
						tone: "warning",
						icon: "←",
						tool: "write",
						pending: true,
						live: true,
						toolCall: {
							name: "write",
							args: { path: "src/a.ts", content },
							callId: "c1",
						},
					},
				]}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// The icon gutter carries the spinner while the content streams; the
		// path names the file and the hint measures what has arrived.
		expect(frame).not.toContain("writing…");
		expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Writing src\/a\.ts/);
		expect(frame).toContain("400 lines");
		// The content itself is measured, never laid out: only its size is shown.
		expect(frame).not.toContain("line 399");
	} finally {
		t.renderer.destroy();
	}
});

test("file and generic summaries wrap fully while shell commands expand beyond two rows", async () => {
	const command =
		"cd /Users/dev/project && bun run test --filter alpha-suite --reporter verbose && echo the-very-last-word";
	const path =
		"src/some/deeply/nested/directory/with/a/long/path/to/the/module-under-edit.ts";
	const blocks: AgentSessionBlock[] = [
		{
			id: "t3",
			kind: "tool",
			text: "custom_tool query=src/some/deeply/nested/directory/with/a/long/value/that/reachesTheLastWord",
			tone: "muted",
			icon: "•",
			tool: "custom_tool",
			toolCall: {
				name: "custom_tool",
				args: {
					query:
						"src/some/deeply/nested/directory/with/a/long/value/that/reachesTheLastWord",
				},
				callId: "c3",
			},
		},
		{
			id: "t1",
			kind: "tool",
			text: "bash command",
			tone: "warning",
			icon: "$",
			tool: "bash",
			pending: true,
			live: true,
			toolCall: { name: "bash", args: { command }, callId: "c1" },
		},
		{
			id: "t2",
			kind: "tool",
			text: "read path",
			tone: "warning",
			icon: "→",
			tool: "read",
			pending: true,
			live: true,
			toolCall: { name: "read", args: { path }, callId: "c2" },
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 50, height: 50 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// Shell commands reserve at most two compact rows; file paths and generic
		// tool summaries keep their full wrapping.
		expect(frame).toContain("very-last-word");
		expect(frame).toContain("reporter verbose");
		expect(frame).toContain("module-under-edit.");
		// The raised block's left rule is repeated on every wrapped row.
		expect(frame).toContain("module-under-edit.ts");
		// A tool without a specialized view wraps its own summary too.
		expect(frame).toContain("reachesTheLastWord");
		// The spinner in the icon gutter is the running marker; the row's own
		// text adds no ellipsis.
		expect(frame).not.toContain("running…");
		expect(frame).not.toContain("reading…");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("very-last-word");
	} finally {
		t.renderer.destroy();
	}
});

test("a generic tool view wraps its request and output instead of truncating them", async () => {
	const block: AgentSessionBlock = {
		id: "g1",
		kind: "tool",
		text: "custom_tool query=src/some/deeply/nested/value/that/reachesTheLastWord",
		tone: "muted",
		icon: "•",
		tool: "custom_tool",
		toolCall: {
			name: "custom_tool",
			args: { query: "src/some/deeply/nested/value/that/reachesTheLastWord" },
			callId: "c1",
		},
		request: "custom_tool query=aRequestThatReachesItsOwnLastWord",
		detail: ["anOutputLineThatReachesItsOwnLastWord"],
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 50, height: 35 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("reachesTheLastWord");
		expect(collapsed).not.toContain("...");
		expect(collapsed).toContain("ItsOwnLastWord");

		// Ctrl+O opens the fold: the request line and the output rows are read
		// whole too, not cut in the middle.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("ItsOwnLastWord");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).not.toContain("aRequestThatReachesItsOwnLastWord");
		expect(expanded).toContain("anOutputLineThatReachesItsOwnLastWord");
		expect(expanded).not.toContain("...");
	} finally {
		t.renderer.destroy();
	}
});

test("an expanded specialized tool wraps its output rows instead of truncating them", async () => {
	const line = `${"prefix ".repeat(12)}theLastOutputWord`;
	const block: AgentSessionBlock = {
		id: "r1",
		kind: "tool",
		text: "read path=src/a.ts",
		tone: "success",
		icon: "→",
		tool: "read",
		toolCall: {
			name: "read",
			args: { path: "src/a.ts" },
			callId: "c1",
			result: { lines: [line], isError: false, notes: [] },
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 50, height: 20 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("theLastOutputWord");
		expect(frame).not.toContain("...");
	} finally {
		t.renderer.destroy();
	}
});

test("rows show their start time, and a tool call its duration, at the right edge", async () => {
	const at = (h: number, m: number, sec: number) =>
		new Date(2026, 9, 19, h, m, sec).getTime();
	const blocks: AgentSessionBlock[] = [
		{
			id: "u1",
			kind: "user",
			text: "run the tests",
			tone: "accent",
			startedAt: at(14, 3, 20),
		},
		{
			id: "r1",
			kind: "reasoning",
			text: "plan the run",
			tone: "muted",
			durationMs: 1600,
			startedAt: at(14, 3, 21),
		},
		{
			id: "t1",
			kind: "tool",
			text: "bash: ok",
			tone: "success",
			icon: "✓",
			tool: "bash",
			startedAt: at(14, 3, 23),
			durationMs: 42_000,
			toolCall: {
				name: "bash",
				args: { command: "bun test" },
				callId: "c1",
				result: { lines: ["ok"], isError: false, notes: [] },
			},
		},
		{
			id: "t2",
			kind: "tool",
			text: "read: a",
			tone: "success",
			icon: "✓",
			tool: "read",
			startedAt: at(14, 4, 5),
			durationMs: 340,
			toolCall: {
				name: "read",
				args: { path: "a.ts" },
				callId: "c2",
				result: { lines: ["a"], isError: false, notes: [] },
			},
		},
		{
			id: "s1",
			kind: "summary",
			text: "opencode-go/deepseek · 2.0s",
			tone: "muted",
			startedAt: at(14, 4, 6),
		},
	];
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 26 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		const line = (needle: string) =>
			frame.split("\n").find((row) => row.includes(needle)) ?? "";
		expect(line("14:03:20").trimEnd().endsWith("14:03:20")).toBe(true);
		expect(line("Thought: 1.6s").trimEnd().endsWith("14:03:21")).toBe(true);
		// A tool row: its duration, then its start time, at the right edge.
		expect(line("bun test").trimEnd()).toMatch(/42\.0s +14:03:23$/);
		expect(line("a.ts").trimEnd()).toMatch(/340ms +14:04:05$/);
		expect(line("Worker").trimEnd().endsWith("14:04:06")).toBe(true);
	} finally {
		t.renderer.destroy();
	}
});

test("a tool call aborted before it ran is marked aborted", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{
						id: "t1",
						kind: "tool",
						text: "read path=src/a.ts",
						tone: "warning",
						icon: "→",
						tool: "read",
						aborted: true,
						toolCall: {
							name: "read",
							args: { path: "src/a.ts" },
							callId: "c1",
						},
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 12 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		expect(frame).toContain("→ Read src/a.ts");
		expect(frame).toContain("aborted");
	} finally {
		t.renderer.destroy();
	}
});

test("codemode renders live native tool progress and full script output by default", async () => {
	const [output, setOutput] = createSignal("script first");
	const [nested, setNested] = createSignal("nested first");
	const blocks = () =>
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
									id: "cm-live",
									name: "codemode",
									arguments: {
										code: 'text("script first"); await tools.bash({command: "run-task"});',
									},
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
							name: "codemode",
							callId: "cm-live",
							status: "running",
							output: output(),
							details: {
								calls: [
									{
										name: "bash",
										args: { command: "run-task" },
										status: "running",
										output: nested(),
									},
								],
							},
						},
					],
				},
			},
		});
	const t = await testRender(
		() => (
			<PickerRoute
				blocks={blocks()}
				onSubmit={() => {}}
				onConfigure={() => {}}
			/>
		),
		{ width: 100, height: 70 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("nested first");
		expect(t.captureCharFrame()).toContain("script first");
		expect(t.captureCharFrame()).toContain("Codemode running…");
		expect(t.captureCharFrame()).not.toContain("failed");
		setOutput(
			Array.from({ length: 20 }, (_, i) => `script output ${i}`).join("\n"),
		);
		setNested("nested second");
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("nested second");
		setNested("nested without script output");
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("nested without script output");
		expect(t.captureCharFrame()).toContain("script output 0");
		expect(t.captureCharFrame()).toContain("script output 19");
		const header = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Output"));
		await t.mockMouse.click(10, header);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("script output 0");
		expect(t.captureCharFrame()).toContain("script output 19");
		expect(t.captureCharFrame()).toContain("earlier lines");
		// New frames preserve a reader's fold choices.
		setOutput(`${output()}\nscript output 20`);
		await t.renderOnce();
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("script output 0");
		expect(t.captureCharFrame()).toContain("script output 20");
	} finally {
		t.renderer.destroy();
	}
});

test("codemode brackets expanded script, native tool cards and output that fold independently", async () => {
	const block: AgentSessionBlock = {
		id: "c1",
		kind: "tool",
		text: "codemode",
		tone: "success",
		icon: "λ",
		tool: "codemode",
		toolCall: {
			name: "codemode",
			args: {
				code: 'const hits = await tools.glob({ pattern: "*.ts" });\nreturn hits.length;',
			},
			callId: "k1",
			result: {
				lines: [
					"Script completed",
					'return: ["a.ts","b.ts"]',
					"calls: glob (ok), read (error)",
				],
				isError: false,
				details: {
					calls: [
						{ name: "glob", status: "ok", args: { pattern: "*.ts" } },
						{ name: "read", status: "error", args: { path: "src/a.ts" } },
					],
				},
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 50 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("╭─ λ Codemode");
		expect(expanded).not.toMatch(/[▸▾]/);
		expect(expanded).toContain("2 calls · 1 failed");
		expect(expanded).toContain("Glob *.ts");
		expect(expanded).toContain("Read src/a.ts");
		expect(expanded).toContain("λ Script");
		expect(expanded).toContain("$ Output");
		expect(expanded).toContain("tools.glob");
		expect(expanded).toContain('return: ["a.ts","b.ts"]');
		expect(expanded).toContain("╰─ Codemode completed");
		const scriptRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("λ Script"));
		await t.mockMouse.click(10, scriptRow);
		await t.renderOnce();
		const opened = t.captureCharFrame();
		expect(opened).toContain("λ Script");
		expect(opened).not.toContain("tools.glob");
		expect(opened).toContain("$ Output");
		expect(opened).toContain("Read src/a.ts");
	} finally {
		t.renderer.destroy();
	}
});

test("codemode uses native file cards expanded by default and lets each fold to a header", async () => {
	const block: AgentSessionBlock = {
		id: "c2",
		kind: "tool",
		text: "codemode",
		tone: "success",
		icon: "λ",
		tool: "codemode",
		toolCall: {
			name: "codemode",
			args: { code: "return 1;" },
			callId: "k2",
			result: {
				lines: ["Script completed"],
				isError: false,
				details: {
					calls: [
						{
							name: "edit",
							status: "ok",
							args: {
								path: "src/b.ts",
								edits: [{ oldText: "a", newText: "b" }],
							},
							// The nested edit's diff, captured from the tool's own
							// `result.details`.
							details: { diff: "@@ -1 +1 @@\n-a\n+b" },
						},
						{
							name: "read",
							status: "ok",
							args: { path: "src/c.ts" },
							output: "line one\nline two",
							isError: false,
						},
					],
				},
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 80, height: 50 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("Edit src/b.ts");
		expect(expanded).toContain("+ b");
		expect(expanded).toContain("line one");
		const background = (text: string) => {
			const span = t
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.find((span) => span.text.includes(text));
			if (!span) throw new Error(`Missing text: ${text}`);
			return Array.from(span.bg.buffer).join(",");
		};
		const scriptRest = background("Script");
		const readRest = background("Read src/c.ts");
		const editRest = background("Edit src/b.ts");
		const bracketRest = background("╭─ λ Codemode");
		const editRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("Edit src/b.ts"));
		await t.mockMouse.moveTo(20, editRow);
		await t.renderOnce();
		expect(background("Edit src/b.ts")).not.toBe(editRest);
		expect(background("Read src/c.ts")).toBe(readRest);
		expect(background("Script")).toBe(scriptRest);
		expect(background("╭─ λ Codemode")).toBe(bracketRest);
		await t.mockMouse.click(10, editRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("+ b");
		expect(t.captureCharFrame()).toContain("line one");

		// The read call folds into the text it read.
		const readRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Read src/c.ts"));
		await t.mockMouse.click(10, readRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("line one");
		const promptRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Ask anything"));
		await t.mockMouse.click(10, promptRow);
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("return 1;");
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("return 1;");
		expect(t.captureCharFrame()).toContain("+ b");
		expect(t.captureCharFrame()).toContain("line one");
		expect(t.captureCharFrame()).not.toMatch(/[▸▾]/);
	} finally {
		t.renderer.destroy();
	}
});

test("a developer question shows its context, options, and chosen answer", async () => {
	const options = [
		{
			title: "SQLite in-process",
			value: "sqlite",
			recommended: true,
			description: "No service to run.",
		},
		{ title: "Postgres via compose", value: "postgres" },
	];
	const block: AgentSessionBlock = {
		id: "d1",
		kind: "tool",
		text: "developer_question",
		tone: "success",
		icon: "?",
		tool: "developer_question",
		toolCall: {
			name: "developer_question",
			args: {
				description: "Which backend should the wiki use?",
				context: "The migration script must pick one.",
				options,
			},
			callId: "d1",
			result: {
				lines: [
					JSON.stringify({
						id: "q1",
						role: "planner",
						status: "answered",
						description: "Which backend should the wiki use?",
						context: "The migration script must pick one.",
						options,
						answer: { kind: "option", value: "sqlite" },
					}),
				],
				isError: false,
				notes: [],
			},
		},
	};
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[block]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 70 },
	);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Collapsed: the question and what came back are the row's own line.
		const collapsed = t.captureCharFrame();
		expect(collapsed).toContain("? Which backend should the wiki use?");
		expect(collapsed).toContain("answered · developer");
		expect(collapsed).toContain("SQLite in-process");

		// Details start open and each subcomponent folds independently.
		const expanded = t.captureCharFrame();
		expect(expanded).toContain("Context");
		expect(expanded).toContain("→ SQLite in-process");
		expect(expanded).toContain("No service to run.");
		expect(expanded).not.toMatch(/[▸▾]/);

		// The context folds open into the markdown it is.
		const contextRow = expanded
			.split("\n")
			.findIndex((line) => line.includes("Context"));
		await t.mockMouse.click(10, contextRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain(
			"The migration script must pick one.",
		);

		// The question folds into every option it offered, the chosen one marked.
		const questionRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Choices and answer"));
		await t.mockMouse.click(10, questionRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("● ★ SQLite in-process");
		const foldedQuestionRow = t
			.captureCharFrame()
			.split("\n")
			.findIndex((line) => line.includes("Choices and answer"));
		await t.mockMouse.click(10, foldedQuestionRow);
		await t.renderOnce();
		const opened = t.captureCharFrame();
		expect(opened).toContain("● ★ SQLite in-process");
		expect(opened).toContain("○   Postgres via compose");

		// An option folds into the description the agent attached to it.
		const optionRow = opened
			.split("\n")
			.findIndex((line) => line.includes("● ★ SQLite in-process"));
		await t.mockMouse.click(10, optionRow);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("No service to run.");
	} finally {
		t.renderer.destroy();
	}
});

test("expanding a block keeps the reader's place", async () => {
	const blocks: AgentSessionBlock[] = [
		{
			id: "t1",
			kind: "tool",
			text: "bash npm test",
			tone: "muted",
			icon: "$",
			tool: "bash",
			detail: Array.from({ length: 20 }, (_, index) => `output ${index}`),
		},
		...Array.from({ length: 30 }, (_, index) => ({
			id: `r${index}`,
			kind: "result" as const,
			text: `line ${index}`,
			tone: "success" as const,
		})),
	];
	let box: { scrollTop: number; scrollHeight: number } | undefined;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onScrollBoxReady={(value) => {
					box = value as unknown as typeof box;
				}}
			/>
		),
		{ width: 80, height: 16 },
	);
	/** The result line at the top of the viewport. */
	const topLine = () => Number(/line (\d+)/.exec(t.captureCharFrame())?.[1]);
	try {
		await t.renderOnce();
		await t.renderOnce();
		// Scroll into the transcript: the tool block is now above the viewport.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		await t.renderOnce();
		if (box) box.scrollTop = 12;
		await t.renderOnce();
		const before = topLine();
		const height = box?.scrollHeight ?? 0;
		expect(before).toBeGreaterThan(0);

		// Ctrl+O expands the tool block above: its rows land above the reader,
		// and the viewport follows the line it was resting on.
		t.mockInput.pressKey("o", { ctrl: true });
		await t.renderOnce();
		await t.renderOnce();
		expect(box?.scrollHeight ?? 0).toBeGreaterThan(height);
		expect(topLine()).toBe(before);
	} finally {
		t.renderer.destroy();
	}
});

test("a streaming message holds its fenced code instead of re-drawing it", async () => {
	const text = "Here is the fix:\n\n```ts\nconst a = 1;\n```\n";
	const frameOf = async (block: AgentSessionBlock) => {
		const t = await testRender(
			() => (
				<AgentSessionView
					role="worker"
					blocks={[block]}
					working={true}
					models={[]}
					thinkingLevels={[]}
					draft=""
					history={[]}
					onHistoryAppend={() => {}}
					onDraftChange={() => {}}
					onSubmit={() => {}}
					onAbort={() => {}}
					onBack={() => {}}
					onConfigure={() => {}}
					onCompact={() => {}}
				/>
			),
			{ width: 60, height: 14 },
		);
		await t.renderOnce();
		await t.renderOnce();
		const frame = t.captureCharFrame();
		t.renderer.destroy();
		return frame;
	};

	// A committed message draws its fence immediately (the raw text first, the
	// highlight concealing the markers a moment later).
	const committed = await frameOf({
		id: "e1:0",
		kind: "assistant",
		text,
		tone: "base",
	});
	expect(committed).toContain("Here is the fix:");
	expect(committed).toContain("const a = 1;");

	// A live one keeps the text it already laid out rather than re-laying the
	// chunk: re-drawing shows the fence markers again, which changes the block's
	// height by a line on every frame — the jump the reader sees as unreadable
	// output. The prose still draws through its streaming preview.
	const live = await frameOf({
		id: "live:generation",
		kind: "assistant",
		text,
		tone: "base",
		live: true,
	});
	expect(live).toContain("Here is the fix:");
	// A warm grammar may already paint the code. The invariant is that raw
	// fences do not flash back into the streaming transcript.
	expect(live).not.toContain("```");
});

test("a watch frame never blanks the transcript's markdown", async () => {
	const committed: AgentSessionBlock[] = [
		{ id: "b19", kind: "user", text: "fix the parser", tone: "accent" },
		{
			id: "b20",
			kind: "assistant",
			text: "Reading the parser now.\n\n```ts\nconst a = 1;\n```\n",
			tone: "base",
		},
	];
	const [blocks, setBlocks] =
		createSignal<readonly AgentSessionBlock[]>(committed);
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={blocks()}
				working={true}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.waitForFrame((frame) => frame.includes("Reading the parser"));
		// Every frame rebuilds the block objects and grows the in-flight one.
		for (let index = 0; index < 4; index++) {
			setBlocks(() => [
				...committed.map((block) => ({ ...block })),
				{
					id: "b21",
					kind: "assistant",
					text: `streaming ${index}`,
					tone: "base",
				},
			]);
			await t.renderOnce();
			const frame = t.captureCharFrame();
			expect(frame).toContain("Reading the parser");
			// The code fence draws in the same frame, before its syntax pass.
			expect(frame).toContain("const a = 1;");
			expect(frame).toContain(`streaming ${index}`);
		}
		// The in-flight block commits: the message keeps drawing as it settles.
		setBlocks(() => [
			...committed,
			{ id: "b22", kind: "assistant", text: "streaming 3", tone: "base" },
		]);
		await t.renderOnce();
		expect(t.captureCharFrame()).toContain("streaming 3");
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt reads keys only while the view owns the keyboard", async () => {
	const [active, setActive] = createSignal(false);
	let submitted: string | undefined;
	const t = await testRender(
		() => (
			<Harness
				inputActive={active}
				onSubmit={(text) => {
					submitted = text;
				}}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		// A keymap-only surface (the workspace sidebar, a modal) owns the
		// keyboard: the unfocused prompt must not swallow what is typed at it.
		for (const character of "sidebar") t.mockInput.pressKey(character);
		await t.renderOnce();
		expect(t.captureCharFrame()).not.toContain("sidebar");
		// Handing the keyboard back focuses the prompt again, so the same input
		// accepts text and submits.
		setActive(true);
		await t.renderOnce();
		for (const character of "hello") t.mockInput.pressKey(character);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toBe("hello");
	} finally {
		t.renderer.destroy();
	}
});

test("`?` on an empty prompt opens the shared help, and a typed `?` stays literal", async () => {
	let help = 0;
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				thinkingLevels={["off", "low"]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				onHelp={() => {
					help++;
				}}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		t.mockInput.pressKey("?");
		await t.renderOnce();
		expect(help).toBe(1);
		// A message may start with `?`: once anything is typed the key is text.
		t.mockInput.pressKey("w");
		t.mockInput.pressKey("?");
		await t.renderOnce();
		expect(help).toBe(1);
		expect(t.captureCharFrame()).toContain("w?");
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt's metadata row shows context, cost, tokens and tok/s", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[]}
				working={false}
				models={[]}
				thinkingLevels={["off"]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
				contextTokens={12_500}
				contextWindow={100_000}
				cost={0.42}
				inputTokens={2500}
				outputTokens={800}
				tokensPerSecond={40}
			/>
		),
		{ width: 100, height: 30 },
	);
	try {
		await t.flush();
		const frame = t.captureCharFrame();
		expect(frame).toContain("12.5K (13%)");
		expect(frame).toContain("$0.42");
		expect(frame).toContain("tok 2.5K→800");
		expect(frame).toContain("40 tok/s");
	} finally {
		t.renderer.destroy();
	}
});

test("Shift+Enter starts a new prompt line and Enter sends the whole message", async () => {
	const submitted: string[] = [];
	const t = await testRender(
		() => (
			<Harness
				onSubmit={(text) => submitted.push(text)}
				onAbort={() => {}}
				onBack={() => {}}
			/>
		),
		// A terminal in the kitty keyboard protocol (the renderer's own mode):
		// only then is Shift+Enter distinguishable from Enter.
		{ width: 100, height: 30, kittyKeyboard: true },
	);
	try {
		await t.flush();
		for (const character of "first line") t.mockInput.pressKey(character);
		t.mockInput.pressEnter({ shift: true });
		for (const character of "second line") t.mockInput.pressKey(character);
		await t.renderOnce();
		const frame = t.captureCharFrame();
		// Both lines are on screen at once, not one line with a lost separator.
		expect(frame).toContain("first line");
		expect(frame).toContain("second line");
		expect(submitted).toEqual([]);
		t.mockInput.pressEnter();
		await t.renderOnce();
		expect(submitted).toEqual(["first line\nsecond line"]);
	} finally {
		t.renderer.destroy();
	}
});

test("the prompt grows with the message and scrolls once it is eight lines tall", async () => {
	const t = await testRender(
		() => <Harness onSubmit={() => {}} onAbort={() => {}} onBack={() => {}} />,
		{ width: 100, height: 30, kittyKeyboard: true },
	);
	try {
		await t.flush();
		for (const line of ["alpha", "beta", "gamma"]) {
			for (const character of line) t.mockInput.pressKey(character);
			t.mockInput.pressEnter({ shift: true });
		}
		await t.renderOnce();
		const grown = t.captureCharFrame();
		// The transcript above the prompt keeps its rows: the prompt grew into
		// the space it needs instead of covering the conversation.
		expect(grown).toContain("fix the parser");
		expect(grown).toContain("alpha");
		expect(grown).toContain("beta");
		expect(grown).toContain("gamma");
		// Past the cap the editor scrolls instead of eating the transcript.
		const numbered = Array.from(
			{ length: 12 },
			(_, index) => `line${String(index).padStart(2, "0")}`,
		);
		for (const line of numbered) {
			for (const character of line) t.mockInput.pressKey(character);
			t.mockInput.pressEnter({ shift: true });
		}
		await t.renderOnce();
		const capped = t.captureCharFrame();
		expect(capped).toContain("fix the parser");
		expect(capped).toContain(numbered.at(-1) ?? "");
		const visible = numbered.filter((line) => capped.includes(line));
		expect(visible.length).toBeGreaterThan(0);
		expect(visible.length).toBeLessThanOrEqual(8);
	} finally {
		t.renderer.destroy();
	}
});

test("assistant markdown leaves one blank row between top-level blocks", async () => {
	const t = await testRender(
		() => (
			<AgentSessionView
				role="worker"
				blocks={[
					{
						id: "tight",
						kind: "assistant",
						tone: "base",
						text: [
							"# Tight",
							"Tight paragraph",
							"- tight item",
							"```ts",
							"const tight = 1;",
							"```",
							"Tight tail",
						].join("\n"),
					},
					{
						id: "spaced",
						kind: "assistant",
						tone: "base",
						text: [
							"# Spaced",
							"",
							"Spaced paragraph",
							"",
							"- spaced item",
							"",
							"```ts",
							"const spaced = 1;",
							"```",
							"",
							"Spaced tail",
						].join("\n"),
					},
				]}
				working={false}
				models={[]}
				thinkingLevels={[]}
				draft=""
				history={[]}
				onHistoryAppend={() => {}}
				onDraftChange={() => {}}
				onSubmit={() => {}}
				onAbort={() => {}}
				onBack={() => {}}
				onConfigure={() => {}}
				onCompact={() => {}}
			/>
		),
		{ width: 100, height: 40 },
	);
	try {
		await t.flush();
		const frame = await t.waitForFrame(
			(value) =>
				value.includes("Tight tail") &&
				value.includes("Spaced tail") &&
				value.includes("const tight = 1;") &&
				value.includes("const spaced = 1;") &&
				!value.includes("```"),
		);
		const lines = frame
			.trimEnd()
			.split("\n")
			.map((line) => line.trimEnd());
		const at = (needle: string) => {
			const index = lines.findIndex(
				(line) => line.trim().replace(/^(?:#{1,6}|[-•●])\s+/, "") === needle,
			);
			expect(index).toBeGreaterThanOrEqual(0);
			return index;
		};
		const oneBlankApart = (labels: readonly string[]) => {
			const indices = labels.map(at);
			for (let index = 1; index < indices.length; index += 1) {
				const previous = indices[index - 1] ?? 0;
				const current = indices[index] ?? 0;
				expect(current).toBe(previous + 2);
				expect(lines[previous + 1]?.trim()).toBe("");
			}
		};
		// The first message has no blank source lines between blocks; the
		// renderer must add the separation itself. The second already carries
		// them; it must not get a second blank row from the inter-part margin.
		oneBlankApart([
			"Tight",
			"Tight paragraph",
			"tight item",
			"const tight = 1;",
			"Tight tail",
		]);
		oneBlankApart([
			"Spaced",
			"Spaced paragraph",
			"spaced item",
			"const spaced = 1;",
			"Spaced tail",
		]);
	} finally {
		t.renderer.destroy();
	}
});

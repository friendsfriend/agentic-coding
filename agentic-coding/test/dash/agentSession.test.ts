import { describe, expect, test } from "bun:test";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import {
	buildAgentSessionView,
	readAgentSessionMetadata,
	renderAgentSessionSummary,
	reuseAgentSessionBlocks,
} from "../../src/tui/dash/agent-session.ts";

describe("buildAgentSessionView", () => {
	test("an empty conversation has no blocks", () => {
		expect(buildAgentSessionView({ entries: [] })).toEqual([]);
	});

	test("renders committed user, assistant, thinking, and tool-call entries", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.user",
					model: [{ role: "user", content: "fix the parser" }],
				},
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "weighing options" },
								{ type: "text", text: "Reading the parser" },
								{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
							],
						},
					],
				},
			],
		});
		expect(blocks).toEqual([
			{ kind: "user", text: "fix the parser", tone: "accent" },
			{ kind: "reasoning", text: "weighing options", tone: "muted" },
			{ kind: "assistant", text: "Reading the parser", tone: "base" },
			{
				kind: "tool",
				text: "read path=a.ts",
				tone: "muted",
				icon: "→",
				tool: "read",
			},
		]);
	});

	test("renders tool results with a success or error tone", () => {
		const result = (isError: boolean) =>
			buildAgentSessionView({
				entries: [
					{
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolName: "bash",
								isError,
								content: [{ type: "text", text: "boom" }],
							},
						],
					},
				],
			})[0];
		expect(result(true)).toMatchObject({
			kind: "result",
			text: "bash: boom",
			tone: "error",
		});
		expect(result(false)).toMatchObject({ kind: "result", tone: "success" });
	});

	test("adds an assistant footer with the model and output tokens", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.user",
					model: [{ role: "user", content: "hi", timestamp: 1000 }],
				},
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							provider: "opencode-go",
							model: "deepseek",
							timestamp: 57000,
							stopReason: "stop",
							content: [{ type: "text", text: "ok" }],
							usage: { input: 0, output: 4100, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			],
		});
		const summary = blocks.find((block) => block.kind === "summary");
		expect(summary?.text).toBe("opencode-go/deepseek · 4.1K out");
	});

	test("uses host timings for the assistant footer and the thinking duration", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					id: "e1",
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							provider: "opencode-go",
							model: "deepseek",
							stopReason: "stop",
							content: [
								{ type: "thinking", thinking: "weighing options" },
								{ type: "text", text: "ok" },
							],
							usage: { output: 4100 },
						},
					],
				},
			],
			timings: { e1: { generationMs: 50000, thinkingMs: 1600 } },
		});
		expect(blocks.find((block) => block.kind === "reasoning")?.durationMs).toBe(
			1600,
		);
		expect(blocks.find((block) => block.kind === "summary")?.text).toBe(
			"opencode-go/deepseek · 50.0s · 82.0 tok/s",
		);
	});

	test("pairs a tool call with its result into one minimized entry", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									name: "bash",
									arguments: { command: "ls" },
								},
							],
						},
					],
				},
				{
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolName: "bash",
							isError: false,
							content: [{ type: "text", text: "a\nb" }],
						},
					],
				},
			],
		});
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "tool",
			text: "bash: a",
			tone: "success",
			icon: "✓",
			pending: false,
			request: "$ bash command=ls",
			detail: ["a", "b"],
		});
	});

	test("strips ANSI runs from tool output, with or without the ESC byte", () => {
		const result = (text: string) =>
			buildAgentSessionView({
				entries: [
					{
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolName: "bash",
								isError: false,
								content: [{ type: "text", text }],
							},
						],
					},
				],
			})[0];
		expect(result("\u001b[32m✓\u001b[0m done")?.text).toBe("bash: ✓ done");
		// The durable transcript loses the ESC byte, leaving literal SGR runs.
		expect(result("[0m[32m✓[0m dashboard data layer")?.text).toBe(
			"bash: ✓ dashboard data layer",
		);
	});

	test("strips pi-durable's <harness> diagnostics wrapper from tool output", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolName: "bash",
							isError: true,
							content: [
								{
									type: "text",
									text: "<harness>\n[error] Tool bash was aborted\n</harness>",
								},
							],
						},
					],
				},
			],
		});
		expect(blocks[0]?.text).toBe("bash: [error] Tool bash was aborted");
		expect(blocks[0]?.text).not.toContain("harness");
	});

	test("renders a running tool and the in-flight generation as live blocks", () => {
		const blocks = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					run: { taskId: "t1", inputs: ["s1"] },
					tools: [{ name: "bash", status: "running", output: "compiling…" }],
					generation: {
						attempt: 1,
						message: {
							content: [{ type: "text", text: "Writing the fix" }],
						},
					},
				},
			},
		});
		expect(blocks).toEqual([
			{
				kind: "tool",
				text: "bash",
				tone: "warning",
				icon: "$",
				pending: true,
				tool: "bash",
				detail: ["compiling…"],
			},
			{ kind: "assistant", text: "Writing the fix", tone: "base" },
		]);
	});

	test("surfaces a failed generation as a red error block", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: "400: MissingSessionID",
						},
					],
				},
			],
		});
		expect(blocks).toEqual([
			{ kind: "error", text: "400: MissingSessionID", tone: "error" },
		]);
	});

	test("reports a retry backoff as a warning notice", () => {
		const blocks = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					generation: { attempt: 2, retry: { at: 1, error: "rate limited" } },
				},
			},
		});
		expect(blocks).toEqual([
			{ kind: "notice", text: "Retrying: rate limited", tone: "warning" },
		]);
	});

	test("keeps only the newest blocks so the modal does not overflow", () => {
		const entries = Array.from({ length: 100 }, (_, index) => ({
			kind: "pi.user",
			model: [{ role: "user", content: `message-${index}` }],
		}));
		const blocks = buildAgentSessionView({ entries });
		expect(blocks.at(-1)?.text).toBe("message-99");
		expect(blocks.some((block) => block.text === "message-0")).toBe(false);
	});

	test("queued messages show their delivery mode and disappear when placed", () => {
		const queued = { mode: "steer", content: "use approach B" };
		const snapshot = {
			entries: [],
			docs: {
				"pi.inbox": {
					items: [
						queued,
						{
							mode: "followUp",
							content: [{ type: "text", text: "then run tests" }],
						},
						{ mode: "write", entry: {} },
						null,
					],
				},
			},
		};
		expect(buildAgentSessionView(snapshot)).toEqual([
			{
				kind: "notice",
				tone: "warning",
				text: "Queued steering: use approach B",
			},
			{
				kind: "notice",
				tone: "warning",
				text: "Queued follow-up: then run tests",
			},
		]);
		expect(readAgentSessionMetadata(snapshot).working).toBe(true);
		expect(
			buildAgentSessionView({
				entries: [{ kind: "pi.user", model: [{ content: queued.content }] }],
				docs: { "pi.inbox": { items: [] } },
			}),
		).toEqual([{ kind: "user", tone: "accent", text: queued.content }]);
		expect(
			buildAgentSessionView({
				docs: {
					"pi.inbox": { items: [false, {}, { mode: "steer", content: {} }] },
				},
			}),
		).toEqual([]);
	});

	test("degrades to no blocks instead of throwing on an unexpected shape", () => {
		expect(buildAgentSessionView(null)).toEqual([]);
		expect(buildAgentSessionView("not an object")).toEqual([]);
		expect(() =>
			buildAgentSessionView({ docs: { "pi.live": "not an object" } }),
		).not.toThrow();
	});
});

describe("readAgentSessionMetadata", () => {
	test("reads the model and thinking level from pi.agent", () => {
		const info = readAgentSessionMetadata({
			entries: [],
			docs: {
				"pi.agent": {
					model: { provider: "opencode-go", modelId: "deepseek-v4.1-flash" },
					thinkingLevel: "high",
				},
			},
		});
		expect(info.model).toBe("opencode-go/deepseek-v4.1-flash");
		expect(info.thinking).toBe("high");
		expect(info.working).toBe(false);
	});

	test("reports the newest context size and accumulated cost", () => {
		const info = readAgentSessionMetadata({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							stopReason: "stop",
							usage: {
								input: 100,
								cacheRead: 50000,
								cacheWrite: 13800,
								output: 10,
							},
						},
					],
				},
			],
			docs: {
				"pi.usage": {
					models: { "opencode-go/x": { cost: { total: 0.012 } } },
					tools: {},
				},
			},
		});
		expect(info.contextTokens).toBe(63900);
		expect(info.cost).toBeCloseTo(0.012);
	});

	test("reports working while a run, tool, generation, or queued input is live", () => {
		const working = (live: Record<string, unknown>) =>
			readAgentSessionMetadata({ entries: [], docs: { "pi.live": live } })
				.working;
		expect(working({ run: { taskId: "t", inputs: [] } })).toBe(true);
		expect(working({ tools: [{ name: "bash", status: "running" }] })).toBe(
			true,
		);
		expect(working({ generation: { attempt: 1 } })).toBe(true);
		expect(working({})).toBe(false);
	});

	test("surfaces the newest failed generation as the error", () => {
		const info = readAgentSessionMetadata({
			entries: [
				{
					kind: "pi.assistant",
					model: [{ stopReason: "error", errorMessage: "boom" }],
				},
			],
		});
		expect(info.error).toBe("boom");
	});

	test("degrades to idle on an unexpected shape", () => {
		expect(readAgentSessionMetadata(null)).toEqual({ working: false });
	});
});

describe("renderAgentSessionSummary", () => {
	test("projects the blocks to plain lines", () => {
		const text = renderAgentSessionSummary({
			entries: [{ kind: "pi.user", model: [{ content: "hello" }] }],
		});
		expect(text).toContain("hello");
	});
});

describe("reuseAgentSessionBlocks", () => {
	const block = (text: string): AgentSessionBlock => ({
		kind: "assistant",
		text,
		tone: "base",
	});

	test("hands the previous array back when a frame changed nothing", () => {
		const first = [block("one"), block("two")];
		// Every watch frame rebuilds the block objects, content identical.
		const frame = [block("one"), block("two")];
		const reused = reuseAgentSessionBlocks(first, frame);
		expect(reused).toBe(first);
		expect(reused[0]).toBe(first[0]);
		expect(reused[1]).toBe(first[1]);
	});

	test("reuses the unchanged blocks and replaces only the changed one", () => {
		const first = [block("one"), block("two"), block("streaming 1")];
		const frame = [block("one"), block("two"), block("streaming 2")];
		const reused = reuseAgentSessionBlocks(first, frame);
		expect(reused).not.toBe(first);
		expect(reused[0]).toBe(first[0]);
		expect(reused[1]).toBe(first[1]);
		expect(reused[2]).toBe(frame[2]);
	});

	test("keeps the blocks that survive a trim or an insertion", () => {
		const one = block("one");
		const two = block("two");
		const three = block("three");
		// A front trim: the oldest block is gone, the rest keep their identity.
		expect(
			reuseAgentSessionBlocks(
				[one, two, three],
				[block("two"), block("three")],
			),
		).toEqual([two, three]);
		// An insertion in the middle leaves both surviving blocks untouched.
		expect(
			reuseAgentSessionBlocks([one, three], [one, block("two"), three]),
		).toEqual([one, block("two"), three]);
	});

	test("distinguishes blocks by their whole content, not just the text", () => {
		const result = (tone: AgentSessionBlock["tone"]): AgentSessionBlock => ({
			kind: "result",
			text: "read: done",
			tone,
		});
		const first = [result("success")];
		const reused = reuseAgentSessionBlocks(first, [result("error")]);
		expect(reused[0]).not.toBe(first[0]);
	});
});

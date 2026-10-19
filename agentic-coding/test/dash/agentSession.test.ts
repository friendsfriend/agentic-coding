import { describe, expect, test } from "bun:test";
import type { AgentSessionBlock } from "../../src/tui/dash/agent-session.ts";
import {
	buildAgentSessionView,
	createAgentSessionProjection,
	readAgentSessionMetadata,
	renderAgentSessionSummary,
	reuseAgentSessionBlocks,
	streamAgentSessionProjection,
	submissionStateNote,
} from "../../src/tui/dash/agent-session.ts";

/** Blocks without their identity or structured tool payload: these assertions
 * are about the rendered content (the tool payload has its own tests). */
const blocksOf = (value: unknown) =>
	buildAgentSessionView(value).map(
		({ id: _id, toolCall: _toolCall, live: _live, ...block }) => block,
	);

describe("buildAgentSessionView", () => {
	test("an empty conversation has no blocks", () => {
		expect(blocksOf({ entries: [] })).toEqual([]);
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
		expect(
			blocks.map(
				({ id: _id, toolCall: _toolCall, live: _live, ...block }) => block,
			),
		).toEqual([
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

	test("carries when each row started and how long a tool call took", () => {
		const T0 = 1_792_400_000_000;
		const blocks = buildAgentSessionView({
			entries: [
				{
					id: "u1",
					kind: "pi.user",
					model: [{ role: "user", content: "run it", timestamp: T0 }],
				},
				{
					id: "a1",
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							stopReason: "toolUse",
							timestamp: T0 + 1_000,
							content: [
								{ type: "thinking", thinking: "plan" },
								{
									type: "toolCall",
									id: "c1",
									name: "bash",
									arguments: { command: "bun test" },
								},
								// A second call of the same message, answered later.
								{
									type: "toolCall",
									id: "c2",
									name: "read",
									arguments: { path: "a.ts" },
								},
							],
						},
					],
				},
				{
					id: "r1",
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "c1",
							toolName: "bash",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: T0 + 1_000 + 2_000 + 12_345,
						},
					],
				},
				{
					id: "r2",
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "c2",
							toolName: "read",
							content: [{ type: "text", text: "x" }],
							isError: false,
							timestamp: T0 + 1_000 + 2_000 + 12_400,
						},
					],
				},
			],
			// The generation took two seconds: the calls were issued then.
			timings: { a1: { generationMs: 2_000, thinkingMs: 900 } },
		});
		expect(blocks.find((block) => block.kind === "user")?.startedAt).toBe(T0);
		const thought = blocks.find((block) => block.kind === "reasoning");
		// A thought started with the generation.
		expect(thought?.startedAt).toBe(T0 + 1_000);
		const bash = blocks.find((block) => block.tool === "bash");
		// A call started when the generation ended, and took until its result.
		expect(bash?.startedAt).toBe(T0 + 3_000);
		expect(bash?.durationMs).toBe(12_345);
		const read = blocks.find((block) => block.tool === "read");
		expect(read?.durationMs).toBe(12_400);
	});

	test("a call whose generation time is unknown shows no duration rather than a wrong one", () => {
		const T0 = 1_792_400_000_000;
		const blocks = buildAgentSessionView({
			entries: [
				{
					id: "a1",
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							stopReason: "toolUse",
							timestamp: T0,
							content: [
								{
									type: "toolCall",
									id: "c1",
									name: "bash",
									arguments: { command: "ls" },
								},
							],
						},
					],
				},
				{
					id: "r1",
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId: "c1",
							toolName: "bash",
							content: [{ type: "text", text: "ok" }],
							isError: false,
							timestamp: T0 + 40_000,
						},
					],
				},
			],
		});
		const bash = blocks.find((block) => block.tool === "bash");
		expect(bash?.startedAt).toBeUndefined();
		expect(bash?.durationMs).toBeUndefined();
	});

	test("writes one assistant footer per turn, not per generation", () => {
		const assistant = (
			stopReason: string,
			content: unknown[],
			output: number,
		) => ({
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					provider: "opencode-go",
					model: "deepseek",
					stopReason,
					content,
					usage: { output },
				},
			],
		});
		const user = {
			kind: "pi.user",
			model: [{ role: "user", content: "what is this repo" }],
		};
		const call = assistant(
			"toolUse",
			[{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }],
			100,
		);
		const answer = assistant(
			"stop",
			[{ type: "text", text: "A workflow engine." }],
			600,
		);

		// The turn's intermediate generation (a tool call) carries no footer; the
		// answer that ended the turn carries the turn's own.
		const finished = buildAgentSessionView({
			entries: [
				user,
				call,
				{
					kind: "pi.tool-result",
					model: [{ toolName: "read", content: "contents", isError: false }],
				},
				answer,
			],
		});
		expect(
			finished
				.filter((block) => block.kind === "summary")
				.map((block) => block.text),
		).toEqual(["opencode-go/deepseek · 600 out"]);

		// A turn still working through its tools has no footer yet.
		expect(
			buildAgentSessionView({ entries: [user, call] }).filter(
				(block) => block.kind === "summary",
			),
		).toEqual([]);
	});

	test("pairs a result with the call it answers, not the next same-named one", () => {
		const call = (id: string, path: string) => ({
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "toolCall", id, name: "read", arguments: { path } },
					],
				},
			],
		});
		const result = (id: string, text: string) => ({
			kind: "pi.tool-result",
			model: [
				{ role: "toolResult", toolCallId: id, toolName: "read", content: text },
			],
		});
		// Two parallel reads whose results come back in the other order.
		const blocks = buildAgentSessionView({
			entries: [
				call("a", "a.ts"),
				call("b", "b.ts"),
				result("b", "contents of b"),
				result("a", "contents of a"),
			],
		});
		const rows = blocks.map((block) => ({
			args: block.toolCall?.args.path,
			lines: block.toolCall?.result?.lines,
		}));
		expect(rows).toEqual([
			{ args: "a.ts", lines: ["contents of a"] },
			{ args: "b.ts", lines: ["contents of b"] },
		]);
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

	test("keeps every line of a tool result for the expanded view", () => {
		// The harness already bounds what a tool may keep; the transcript must
		// not cut it again, or the expanded view hides what is being analyzed.
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolName: "read",
							content: lines.join("\n"),
							isError: false,
						},
					],
				},
			],
		});
		expect(blocks[0]?.toolCall?.result?.lines).toEqual(lines);
		expect(blocks[0]?.detail).toEqual(lines);
	});

	test("marks the blocks that are still being produced as live", () => {
		// The view renders a live block's fenced code without re-laying it out on
		// every chunk, which is what keeps the transcript from jolting line by
		// line while a message streams.
		const live = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					generation: {
						message: { content: [{ type: "text", text: "writing" }] },
					},
					tools: [{ name: "read", status: "running" }],
				},
			},
		});
		expect(live.map((block) => block.live)).toEqual([true, true]);

		// A committed generation is not live.
		const committed = buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							stopReason: "stop",
							content: [{ type: "text", text: "done" }],
						},
					],
				},
			],
		});
		expect(committed[0]?.live).toBeUndefined();
	});

	test("streams the in-flight generation's thinking as its own live block", () => {
		// The partial carries thinking and text in emission order; the view renders
		// the reasoning fold first, then the answer, so the reader can watch both.
		const blocks = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					generation: {
						message: {
							content: [
								{ type: "thinking", thinking: "weighing options" },
								{ type: "text", text: "here is the fix" },
							],
						},
					},
				},
			},
		});
		expect(
			blocks.map(({ kind, text, live }) => ({ kind, text, live })),
		).toEqual([
			{ kind: "reasoning", text: "weighing options", live: true },
			{ kind: "assistant", text: "here is the fix", live: true },
		]);

		// A partial that has not started thinking yet carries no reasoning block.
		expect(
			buildAgentSessionView({
				entries: [],
				docs: {
					"pi.live": {
						generation: {
							message: { content: [{ type: "text", text: "answer" }] },
						},
					},
				},
			}).map((block) => block.kind),
		).toEqual(["assistant"]);
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
		expect(
			blocks.map(
				({ id: _id, toolCall: _toolCall, live: _live, ...block }) => block,
			),
		).toEqual([
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

	test("shows a streamed tool call as an in-progress block before it is committed", () => {
		// The provider names the tool and streams its arguments long before the
		// call is committed or executed: a big `write` must not look like a stuck
		// agent while its content is still arriving.
		const blocks = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					generation: {
						attempt: 1,
						message: {
							content: [
								{
									type: "toolCall",
									id: "c1",
									name: "write",
									arguments: { path: "src/a.ts", content: "a\nb\nc" },
								},
							],
						},
					},
				},
			},
		});
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "tool",
			pending: true,
			live: true,
			tone: "warning",
			icon: "←",
			text: "write path=src/a.ts",
			tool: "write",
			toolCall: {
				name: "write",
				args: { path: "src/a.ts", content: "a\nb\nc" },
				callId: "c1",
			},
		});
	});

	test("names a streamed tool call whose arguments have not parsed yet", () => {
		// A provider that streams the raw JSON payload: the name is known first,
		// the arguments only once the payload parses.
		const blocks = buildAgentSessionView({
			entries: [],
			docs: {
				"pi.live": {
					generation: {
						attempt: 1,
						message: {
							content: [
								{
									type: "toolCall",
									id: "c1",
									name: "read",
									arguments: '{"path":"src/a.ts"',
								},
							],
						},
					},
				},
			},
		});
		expect(blocks[0]).toMatchObject({
			kind: "tool",
			text: "read",
			pending: true,
			toolCall: { name: "read", args: {}, callId: "c1" },
		});
	});

	test("marks the committed call running instead of adding a second row", () => {
		// Two parallel calls of the same tool: the live slots carry the call id, so
		// each one upgrades the call it started rather than pairing by name.
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							stopReason: "toolUse",
							content: [
								{
									type: "toolCall",
									id: "a",
									name: "read",
									arguments: { path: "a.ts" },
								},
								{
									type: "toolCall",
									id: "b",
									name: "read",
									arguments: { path: "b.ts" },
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
							callId: "b",
							name: "read",
							status: "running",
							output: "contents of b",
						},
						{
							callId: "a",
							name: "read",
							status: "running",
							output: "contents of a",
						},
					],
				},
			},
		});
		expect(blocks).toHaveLength(2);
		expect(
			blocks.map((block) => ({
				callId: block.toolCall?.callId,
				path: block.toolCall?.args.path,
				pending: block.pending,
				detail: block.detail,
			})),
		).toEqual([
			{
				callId: "a",
				path: "a.ts",
				pending: true,
				detail: ["contents of a"],
			},
			{
				callId: "b",
				path: "b.ts",
				pending: true,
				detail: ["contents of b"],
			},
		]);
	});

	test("marks a tool call an aborted generation never ran", () => {
		const blocks = buildAgentSessionView({
			entries: [
				{
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							stopReason: "aborted",
							content: [
								{
									type: "toolCall",
									id: "c1",
									name: "read",
									arguments: { path: "a.ts" },
								},
							],
						},
					],
				},
			],
		});
		expect(blocks[0]).toMatchObject({
			kind: "tool",
			tone: "warning",
			aborted: true,
			text: "read path=a.ts",
		});
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
		expect(
			blocks.map(
				({ id: _id, toolCall: _toolCall, live: _live, ...block }) => block,
			),
		).toEqual([
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
		expect(
			blocks.map(
				({ id: _id, toolCall: _toolCall, live: _live, ...block }) => block,
			),
		).toEqual([
			{ kind: "notice", text: "Retrying: rate limited", tone: "warning" },
		]);
	});

	test("keeps the newest blocks, bounded for the projection", () => {
		// The view renders a window of these and loads older ones on scroll, so
		// the bound is the projection's memory limit, not a screenful.
		const entries = Array.from({ length: 300 }, (_, index) => ({
			kind: "pi.user",
			model: [{ role: "user", content: `message-${index}` }],
		}));
		const blocks = buildAgentSessionView({ entries });
		expect(blocks.length).toBe(240);
		expect(blocks.at(-1)?.text).toBe("message-299");
		expect(blocks.some((block) => block.text === "message-0")).toBe(false);
		expect(blocks.some((block) => block.text === "message-59")).toBe(false);
		expect(blocks.some((block) => block.text === "message-60")).toBe(true);
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
		expect(blocksOf(snapshot)).toEqual([
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
			blocksOf({
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
		expect(blocksOf(null)).toEqual([]);
		expect(blocksOf("not an object")).toEqual([]);
		expect(() =>
			buildAgentSessionView({ docs: { "pi.live": "not an object" } }),
		).not.toThrow();
	});
});

describe("compaction feedback", () => {
	/** One committed assistant entry whose request carried `prompt` tokens. */
	const assistant = (prompt: number) => ({
		kind: "pi.assistant",
		model: [
			{
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: "ok" }],
				usage: { input: prompt, cacheRead: 0, cacheWrite: 0, output: 5 },
			},
		],
	});

	test("a live compaction names its reason, and a retry names the failure", () => {
		expect(
			blocksOf({
				entries: [],
				docs: {
					"pi.live": {
						compactions: [{ taskId: 1, reason: "manual", blocking: false }],
					},
				},
			}).find((block) => block.kind === "compaction")?.text,
		).toBe("Compacting context (manual)…");
		expect(
			blocksOf({
				entries: [],
				docs: {
					"pi.live": {
						compactions: [
							{
								taskId: 2,
								reason: "threshold",
								blocking: true,
								retry: { at: 0, error: "provider unavailable" },
							},
						],
					},
				},
			}).find((block) => block.kind === "compaction")?.text,
		).toBe(
			"Compacting context (automatic, threshold) · retrying: provider unavailable…",
		);
	});

	test("a finished compaction measures the tokens before and after the summary", () => {
		const text = blocksOf({
			entries: [
				assistant(120000),
				{ kind: "pi.compaction", data: { reason: "manual" } },
				assistant(30000),
			],
		}).find((block) => block.kind === "compaction")?.text;
		expect(text).toBe("Compaction (manual) · 120.0K → 30.0K tokens");
	});

	test("the movement is omitted rather than invented when it cannot be measured", () => {
		expect(
			blocksOf({
				entries: [
					{ kind: "pi.compaction", data: { reason: "threshold" } },
					assistant(30000),
				],
			}).find((block) => block.kind === "compaction")?.text,
		).toBe("Compaction (automatic, threshold) · 30.0K tokens after");
		expect(
			blocksOf({
				entries: [{ kind: "pi.compaction", data: { reason: "overflow" } }],
			}).find((block) => block.kind === "compaction")?.text,
		).toBe("Compaction (automatic, overflow)");
	});

	test("a client notice the frame cannot carry is appended to the transcript", () => {
		// The aborted-compaction notice: `/abort` cancels a manual compaction and
		// no summary is placed, which no document records — so the client that
		// requested the abort states it in the transcript.
		const blocks = buildAgentSessionView(
			{ entries: [] },
			{
				notices: [
					{
						id: "local:compaction-aborted",
						kind: "notice",
						tone: "warning",
						text: "Compaction aborted — a compaction in flight was cancelled and places no summary",
					},
				],
			},
		);
		expect(blocks.map((block) => block.id)).toContain(
			"local:compaction-aborted",
		);
		// Without a notice the same frame has no such block.
		expect(
			buildAgentSessionView({ entries: [] }).map((block) => block.id),
		).not.toContain("local:compaction-aborted");
	});

	test("the status carries a reason-carrying compaction indicator", () => {
		const info = readAgentSessionMetadata({
			entries: [],
			docs: {
				"pi.live": {
					run: { taskId: 1, inputs: [1] },
					compactions: [{ taskId: 3, reason: "manual", blocking: false }],
				},
			},
		});
		expect(info.compacting).toEqual({ reason: "manual" });
		expect(info.working).toBe(true);
		expect(
			readAgentSessionMetadata({
				entries: [],
				docs: {
					"pi.live": {
						compactions: [
							{
								taskId: 4,
								reason: "threshold",
								blocking: true,
								retry: { at: 0, error: "no model" },
							},
						],
					},
				},
			}).compacting,
		).toEqual({ reason: "threshold", retrying: "no model" });
		// No compaction in flight: no indicator at all.
		expect(
			readAgentSessionMetadata({ entries: [], docs: {} }).compacting,
		).toBeUndefined();
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

	test("reports accumulated tokens and the measured output-token rate", () => {
		const info = readAgentSessionMetadata({
			entries: [
				{
					kind: "pi.assistant",
					id: "a1",
					model: [
						{
							stopReason: "stop",
							usage: { input: 100, output: 40 },
						},
					],
				},
				{
					kind: "pi.assistant",
					id: "a2",
					model: [
						{
							stopReason: "stop",
							usage: { input: 200, output: 60 },
						},
					],
				},
			],
			timings: { a1: { generationMs: 1000 }, a2: { generationMs: 1500 } },
			docs: {
				"pi.usage": {
					models: {
						"provider/x": {
							input: 300,
							output: 100,
							cost: { total: 0.5 },
						},
					},
					tools: { read: { input: 0, output: 0, cost: { total: 0.001 } } },
				},
			},
		});
		expect(info.inputTokens).toBe(300);
		expect(info.outputTokens).toBe(100);
		expect(info.cost).toBeCloseTo(0.501);
		// 100 output tokens over 2.5s of measured generation time.
		expect(info.tokensPerSecond).toBe(40);
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
		id: text,
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

	test("does not reuse an identical block from a different position", () => {
		// Repeated turns produce identical messages ("OK!" twice): identity keeps
		// the newest one out of the reuse pool, so the view can tell new output
		// from the one it already showed.
		const first = [
			{
				id: "turn1",
				kind: "assistant" as const,
				text: "OK!",
				tone: "base" as const,
			},
		];
		const next = [
			{
				id: "turn2",
				kind: "assistant" as const,
				text: "OK!",
				tone: "base" as const,
			},
		];
		expect(reuseAgentSessionBlocks(first, next)).toEqual(next);
		expect(reuseAgentSessionBlocks(first, next)[0]).toBe(next[0]);
	});

	test("distinguishes blocks by their whole content, not just the text", () => {
		const result = (tone: AgentSessionBlock["tone"]): AgentSessionBlock => ({
			id: "read",
			kind: "result",
			text: "read: done",
			tone,
		});
		const first = [result("success")];
		const reused = reuseAgentSessionBlocks(first, [result("error")]);
		expect(reused[0]).not.toBe(first[0]);
	});

	test("replaces a streaming call's block as its arguments grow", () => {
		// The in-progress block is keyed by its arguments: a `write` names its path
		// once and then streams the content, so the block must not be reused from
		// the previous frame while the content is still arriving (its size line is
		// what the reader watches).
		const frame = (content: string) =>
			buildAgentSessionView({
				entries: [],
				docs: {
					"pi.live": {
						generation: {
							attempt: 1,
							message: {
								content: [
									{
										type: "toolCall",
										id: "c1",
										name: "write",
										arguments: { path: "src/a.ts", content },
									},
								],
							},
						},
					},
				},
			});
		const first = frame("a");
		const next = frame("a\nb");
		expect(reuseAgentSessionBlocks(first, next)[0]).toBe(next[0]);
		// A frame that changed nothing at all still reuses the array.
		expect(reuseAgentSessionBlocks(next, frame("a\nb"))).toBe(next);
	});
});

/** A transcript of the shape a long run leaves behind: an assistant step with a
 * thought and a tool call, then the tool's multi-line output. */
function longTranscript(steps: number): unknown[] {
	const entries: unknown[] = [];
	for (let index = 0; index < steps; index++) {
		entries.push({
			id: `step-${index}`,
			kind: "pi.assistant",
			model: [
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{
							type: "thinking",
							thinking: `weighing step ${index} `.repeat(20),
						},
						{
							type: "toolCall",
							id: `call-${index}`,
							name: "bash",
							arguments: { command: `echo ${index}` },
						},
					],
				},
			],
		});
		entries.push({
			id: `output-${index}`,
			kind: "pi.tool-result",
			model: [
				{
					toolName: "bash",
					toolCallId: `call-${index}`,
					isError: false,
					content: Array.from(
						{ length: 60 },
						(_, line) => `output line ${line} of step ${index}`,
					).join("\n"),
				},
			],
		});
	}
	return entries;
}

/** No-op blocks the newest assistant step still has in flight. */
const liveFrame = (entries: unknown[], steps: number) => ({
	docs: {
		"pi.live": {
			run: "run-1",
			tools: [{ name: "bash", status: "running", callId: `call-${steps - 1}` }],
		},
	},
	entries,
});

/** Best-of-`runs` wall clock of one projection, so a loaded machine cannot make
 * the comparison a coin toss. */
function fastest(runs: number, fn: () => void): number {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 0; index < runs; index++) {
		const started = performance.now();
		fn();
		best = Math.min(best, performance.now() - started);
	}
	return best;
}

describe("createAgentSessionProjection", () => {
	test("paints the newest entries first and converges on the full build", () => {
		const steps = 400;
		const frame = liveFrame(longTranscript(steps), steps);
		const full = buildAgentSessionView(frame);
		const projection = createAgentSessionProjection(frame);

		// The first paint is the tail of the run, not the whole transcript.
		expect(projection.complete).toBe(false);
		expect(projection.blocks.length).toBeGreaterThan(0);
		expect(projection.blocks.length).toBeLessThan(full.length);
		expect(projection.blocks.at(-1)?.id).toBe(full.at(-1)?.id);
		// The running tool slot is in the first paint too: the in-progress row
		// must not wait for the older entries either.
		expect(projection.blocks.some((block) => block.pending)).toBe(true);

		let turns = 0;
		while (!projection.step()) turns++;
		expect(turns).toBeLessThan(20);
		expect(projection.blocks).toEqual(buildAgentSessionView(frame));
	});

	test("first paint does not wait for the full transcript projection", () => {
		const steps = 600;
		const frame = liveFrame(longTranscript(steps), steps);
		// Warm both paths before timing them.
		buildAgentSessionView(frame);
		const full = fastest(3, () => {
			buildAgentSessionView(frame);
		});
		const first = fastest(5, () => {
			createAgentSessionProjection(frame);
		});
		// A screenful of a long transcript is a small share of projecting it.
		expect(first).toBeLessThan(full / 3);
	});

	test("an empty frame completes on the first paint", () => {
		const projection = createAgentSessionProjection({ entries: [] });
		expect(projection.complete).toBe(true);
		expect(projection.blocks).toEqual([]);
	});

	test("degrades to no blocks on an unexpected shape", () => {
		expect(createAgentSessionProjection(undefined).blocks).toEqual([]);
		expect(createAgentSessionProjection("nonsense").blocks).toEqual([]);
	});
});

describe("streamAgentSessionProjection", () => {
	test("publishes the first paint before any scheduled turn runs", () => {
		const steps = 400;
		const frame = liveFrame(longTranscript(steps), steps);
		const published: Array<readonly AgentSessionBlock[]> = [];
		const turns: Array<() => void> = [];
		const stop = streamAgentSessionProjection(
			createAgentSessionProjection(frame),
			(blocks) => published.push(blocks),
			{
				schedule: (run) => {
					turns.push(run);
					return () => {
						const index = turns.indexOf(run);
						if (index >= 0) turns.splice(index, 1);
					};
				},
			},
		);

		// Nothing scheduled has run yet: what the reader has is the tail.
		expect(published.length).toBe(1);
		expect(published[0]?.length).toBeLessThan(
			buildAgentSessionView(frame).length,
		);
		while (turns.length > 0) turns.shift()?.();
		expect(published.at(-1)).toEqual(buildAgentSessionView(frame));
		stop();
	});

	test("stops publishing once the projection is superseded", () => {
		const steps = 400;
		const frame = liveFrame(longTranscript(steps), steps);
		let publishes = 0;
		const turns: Array<() => void> = [];
		const stop = streamAgentSessionProjection(
			createAgentSessionProjection(frame),
			() => publishes++,
			{
				schedule: (run) => {
					turns.push(run);
					return () => {};
				},
			},
		);
		const before = publishes;
		stop();
		while (turns.length > 0) turns.shift()?.();
		expect(publishes).toBe(before);
	});

	test("an already complete projection schedules no turn", () => {
		let scheduled = 0;
		const stop = streamAgentSessionProjection(
			createAgentSessionProjection({ entries: [] }),
			() => {},
			{
				schedule: () => {
					scheduled++;
					return () => {};
				},
			},
		);
		expect(scheduled).toBe(0);
		stop();
	});
});

describe("submissionStateNote", () => {
	test("a normal prompt shows no notice", () => {
		expect(submissionStateNote(undefined)).toBeUndefined();
		expect(submissionStateNote("active")).toBeUndefined();
		expect(submissionStateNote("blocked")).toBeUndefined();
	});

	test("a resumed workflow and a finished run are named", () => {
		expect(submissionStateNote("resumed")).toEqual({
			text: "Workflow resumed after the abort",
			tone: "success",
		});
		expect(submissionStateNote("finished")?.tone).toBe("warning");
		expect(submissionStateNote("stale")?.tone).toBe("warning");
	});
});

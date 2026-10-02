import { describe, expect, test } from "bun:test";
import { renderAgentSessionSummary } from "../../src/tui/dash/agent-session.ts";

describe("renderAgentSessionSummary", () => {
	test("idle with no live document reads as idle, zero entries", () => {
		const text = renderAgentSessionSummary({ entries: [] });
		expect(text).toContain("Status: idle");
		expect(text).toContain("Transcript entries: 0");
	});

	test("a live run with a running tool reports working and the tool name", () => {
		const text = renderAgentSessionSummary({
			entries: [{}, {}, {}],
			docs: {
				"pi.live": {
					run: { taskId: "t1", inputs: ["s1"] },
					tools: [{ name: "bash", status: "running" }],
				},
			},
		});
		expect(text).toContain("Status: working");
		expect(text).toContain("Running tool: bash");
		expect(text).toContain("Transcript entries: 3");
	});

	test("queued inbox items are reported", () => {
		const text = renderAgentSessionSummary({
			entries: [],
			docs: { "pi.inbox": { items: [{ id: "s1" }, { id: "s2" }] } },
		});
		expect(text).toContain("Queued submissions: 2");
	});

	test("renders committed user, assistant, and tool-result entries", () => {
		const text = renderAgentSessionSummary({
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
								{ type: "text", text: "Reading the parser" },
								{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
							],
						},
					],
				},
				{
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolName: "read",
							isError: false,
							content: [{ type: "text", text: "file contents" }],
						},
					],
				},
			],
		});
		expect(text).toContain("you: fix the parser");
		expect(text).toContain("pi: Reading the parser");
		expect(text).toContain("• read(path=a.ts)");
		expect(text).toContain("↳ read done: file contents");
	});

	test("renders the in-flight generation and running tool output", () => {
		const text = renderAgentSessionSummary({
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
		expect(text).toContain("▶ bash running");
		expect(text).toContain("compiling…");
		expect(text).toContain("pi: Writing the fix");
	});

	test("keeps only the newest transcript lines so the modal does not overflow", () => {
		const entries = Array.from({ length: 60 }, (_, index) => ({
			kind: "pi.user",
			model: [{ role: "user", content: `message-${index}` }],
		}));
		const text = renderAgentSessionSummary({ entries });
		expect(text).toContain("you: message-59");
		expect(text).not.toContain("you: message-0");
	});

	test("degrades to a bounded fallback instead of throwing on an unexpected shape", () => {
		expect(renderAgentSessionSummary(null)).toBe("No session data yet.");
		expect(renderAgentSessionSummary("not an object")).toBe(
			"No session data yet.",
		);
		expect(() =>
			renderAgentSessionSummary({ docs: { "pi.live": "not an object" } }),
		).not.toThrow();
	});
});

import { describe, expect, test } from "bun:test";
import type { AgentSessionToolCall } from "../../src/tui/dash/agent-session.ts";
import { toolView } from "../../src/tui/dash/ui/tool-views.ts";

const call = (
	name: string,
	args: Readonly<Record<string, unknown>> = {},
	result?: AgentSessionToolCall["result"],
): AgentSessionToolCall => ({
	name,
	args,
	...(result ? { result } : {}),
});

describe("toolView", () => {
	test("read shows the file, the range it covered, and the text", () => {
		const view = toolView(
			call(
				"read",
				{ path: "src/a.ts", offset: 40, limit: 80 },
				{
					lines: ["first line", "second line"],
					isError: false,
					notes: ["Showing lines 40-120 of 512. Use offset=121 to continue."],
				},
			),
		);
		expect(view?.summary).toBe("src/a.ts");
		expect(view?.hint).toBe("40-120 of 512");
		expect(view?.rows?.map((row) => row.text)).toEqual([
			"first line",
			"second line",
		]);
		// A call without a result yet: the file, nothing more.
		expect(toolView(call("read", { path: "src/a.ts" }))).toEqual({
			icon: "→",
			summary: "src/a.ts",
			rows: [],
		});
	});

	test("edit shows the change count and the diff", () => {
		const view = toolView(
			call(
				"edit",
				{
					path: "src/a.ts",
					edits: [
						{ oldText: "a", newText: "b" },
						{ oldText: "c", newText: "d" },
					],
				},
				{
					lines: ["Successfully replaced 2 block(s) in src/a.ts."],
					isError: false,
					details: {
						diff: "@@ -1,3 +1,3 @@\n context\n-const a = 1;\n+const b = 2;",
					},
					notes: [],
				},
			),
		);
		expect(view?.summary).toBe("src/a.ts");
		expect(view?.hint).toBe("2 edits · +1 −1");
		expect(view?.rows).toEqual([
			{ text: "@@ -1,3 +1,3 @@", tone: "info" },
			{ text: " context", tone: "muted" },
			{ text: "-const a = 1;", tone: "error" },
			{ text: "+const b = 2;", tone: "success" },
		]);
	});

	test("write shows the file and the lines it wrote", () => {
		const view = toolView(
			call("write", { path: "src/b.ts", content: "one\ntwo\nthree" }),
		);
		expect(view?.summary).toBe("src/b.ts");
		expect(view?.hint).toBe("3 lines");
		expect(view?.rows?.map((row) => row.text)).toEqual(["one", "two", "three"]);
	});

	test("bash shows the command and how it ended", () => {
		const failed = toolView(
			call(
				"bash",
				{ command: "npm test" },
				{
					lines: ["PASS", "Command exited with code 1"],
					isError: true,
					notes: [],
				},
			),
		);
		expect(failed?.summary).toBe("npm test");
		expect(failed?.hint).toBe("exit 1");
		expect(failed?.rows?.every((row) => row.tone === "error")).toBe(true);

		const ok = toolView(
			call(
				"bash",
				{ command: "ls" },
				{ lines: ["a.ts", "b.ts"], isError: false, notes: [] },
			),
		);
		expect(ok?.hint).toBe("2 lines");
		expect(ok?.rows?.every((row) => row.tone === "muted")).toBe(true);
	});

	test("ask_jev shows the verdict and what it judged", () => {
		const view = toolView(
			call(
				"ask_jev",
				{
					questions: { leak: { type: "noul", instructions: "does it leak?" } },
					paths: ["src/a.ts", "src/b.ts"],
					command: "npm test",
				},
				{
					lines: [
						"## Jev (provider=laya-local model=laya-system-one)",
						"state s7f3a2 · 1.2k in · 200 out",
						"",
						"leak (noul): 0.12 confidence 0.40",
						'- "leak" came back 0.12 at confidence 0.40, which is a coin flip.',
					],
					isError: false,
					details: {
						provider: "laya-local",
						stateTokens: 12300,
						answers: { leak: { noul: 0.12, confidence: 0.4 } },
					},
					notes: [],
				},
			),
		);
		expect(view?.icon).toBe("◆");
		// The verdict is the headline; the state it judged rides beside it.
		expect(view?.summary).toBe("leak → 0.12");
		expect(view?.hint).toBe("conf 0.40 · files (2) · $ npm test");
		// The result's own header block is dropped; its caution keeps a tone.
		expect(view?.rows).toEqual([
			{ text: "", tone: "muted" },
			{ text: "leak (noul): 0.12 confidence 0.40", tone: "muted" },
			{
				text: '- "leak" came back 0.12 at confidence 0.40, which is a coin flip.',
				tone: "warning",
			},
		]);
	});

	test("ask_jev before its verdict shows the questions it asked", () => {
		const view = toolView(
			call("ask_jev", {
				questions: JSON.stringify({
					scope: { type: "choice", instructions: "which core?" },
					leak: { type: "noul", instructions: "does it leak?" },
				}),
				reuse: "s7f3a2",
			}),
		);
		expect(view?.summary).toBe("scope, leak");
		expect(view?.hint).toBe("reuse s7f3a2");
		expect(view?.rows).toEqual([]);
	});

	test("a failed ask_jev keeps its own message", () => {
		const view = toolView(
			call(
				"ask_jev",
				{ questions: { leak: { type: "noul", instructions: "x" } } },
				{
					lines: ["ask_jev: nothing to judge. Pass state, paths, or command."],
					isError: true,
					notes: [],
				},
			),
		);
		expect(view?.summary).toBe("leak");
		expect(view?.rows?.[0]?.text).toContain("nothing to judge");
	});

	test("codemode lists one line per call, then the script and its output", () => {
		const code = [
			'const hits = await tools.glob({ pattern: "*.ts" });',
			'const files = hits.split("\\n").slice(0, 3);',
			"return files.map((file) => file.trim());",
		].join("\n");
		const view = toolView(
			call(
				"codemode",
				{ code },
				{
					lines: [
						"Script completed",
						'return: ["a.ts","b.ts"]',
						"calls: glob (ok), read (ok), read (error)",
					],
					isError: false,
					notes: [],
				},
			),
		);
		expect(view?.icon).toBe("λ");
		// The call list is the collapsed view, and the first call is the summary.
		expect(view?.summary).toBe("glob (ok)");
		expect(view?.alwaysRows).toEqual([
			{ text: "read (ok)", tone: "muted" },
			{ text: "read (error)", tone: "error" },
		]);
		expect(view?.hint).toBe("3 calls · 1 failed");
		// The script and its output are parts of their own, so either can be
		// folded away while the call list stays in view.
		expect(view?.sections?.map((section) => section.id)).toEqual([
			"script",
			"output",
		]);
		expect(view?.sections?.[0]?.rows[0]).toEqual({
			text: 'const hits = await tools.glob({ pattern: "*.ts" });',
			tone: "base",
		});
		expect(view?.sections?.[1]?.rows).toEqual([
			{ text: "Script completed", tone: "muted" },
			{ text: 'return: ["a.ts","b.ts"]', tone: "muted" },
			{ text: "calls: glob (ok), read (ok), read (error)", tone: "muted" },
		]);
	});

	test("codemode before and after a failure", () => {
		// Before the result: the script's own first line, options line skipped.
		const pending = toolView(
			call("codemode", {
				code: '// @options: {"timeout_ms": 60000}\nconst x = await tools.read({ path: "a.ts" });',
			}),
		);
		expect(pending?.summary).toBe(
			'const x = await tools.read({ path: "a.ts" });',
		);
		expect(pending?.hint).toBeUndefined();
		expect(pending?.alwaysRows).toEqual([]);
		// A script that never got a result still shows its source.
		expect(pending?.sections?.map((section) => section.id)).toEqual(["script"]);

		// A failed script keeps its output and its error in the error tone.
		const failed = toolView(
			call(
				"codemode",
				{ code: 'throw new Error("boom");' },
				{
					lines: ["Script failed", "console output", "Script error: boom"],
					isError: true,
					notes: [],
				},
			),
		);
		expect(failed?.summary).toBe('throw new Error("boom");');
		expect(failed?.hint).toBe("failed");
		expect(
			failed?.sections?.[1]?.rows.every((row) => row.tone === "error"),
		).toBe(true);
	});

	test("codemode bounds a long script and a long call list", () => {
		const view = toolView(
			call("codemode", {
				code: Array.from({ length: 20 }, (_, index) => `line ${index}`).join(
					"\n",
				),
				result: undefined,
			}),
		);
		expect(view?.sections?.[0]?.rows.length).toBe(13);
		expect(view?.sections?.[0]?.rows.at(-1)).toEqual({
			text: "… 8 more lines",
			tone: "muted",
		});

		const many = toolView(
			call(
				"codemode",
				{ code: "return 1;" },
				{
					lines: [
						"Script completed",
						`calls: ${Array.from({ length: 9 }, (_, index) => `tool${index} (ok)`).join(", ")}`,
					],
					isError: false,
					notes: [],
				},
			),
		);
		// Six calls listed under the summary line, the rest counted.
		expect(many?.alwaysRows?.length).toBe(7);
		expect(many?.alwaysRows?.at(-1)).toEqual({
			text: "… 2 more calls",
			tone: "muted",
		});
	});

	test("keeps the generic row for a tool without a view", () => {
		expect(toolView(call("developer_question", {}))).toBeUndefined();
		expect(toolView(call("agent_ask", { role: "planner" }))).toBeUndefined();
	});
});

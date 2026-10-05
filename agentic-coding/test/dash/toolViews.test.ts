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
		// Expanded: the question the agent asked, its verdict with the confidence,
		// the distribution behind it, and the caution it earned.
		expect(view?.rows).toEqual([
			{ text: "does it leak?", tone: "muted" },
			{ text: "leak (noul) · 0.12 · confidence 0.40", tone: "base" },
			{
				text: '- "leak" came back 0.12 at confidence 0.40, which is a coin flip.',
				tone: "warning",
			},
		]);
	});

	test("ask_jev expanded shows the question, the verdict, and the distribution", () => {
		const view = toolView(
			call(
				"ask_jev",
				{
					questions: {
						leak: {
							type: "choice",
							instructions: { question: "which core owns the file?", data: {} },
							criteria: {
								true: "the file is about authentication",
								false: "the file is about something else",
							},
						},
					},
					paths: ["src/auth.ts"],
				},
				{
					lines: [
						"## Jev (provider=laya-local model=laya-system-one)",
						"state s1 · 1.2k in",
						"",
						"leak (choice): auth confidence 0.71",
						'- "leak" picked auth at confidence 0.71: the pick is plausible.',
					],
					isError: false,
					details: {
						answers: {
							leak: {
								choice: "auth",
								confidence: 0.71,
								probabilities: { auth: 0.71, environment: 0.21, other: 0.08 },
							},
						},
					},
					notes: [],
				},
			),
		);
		expect(view?.rows).toEqual([
			{ text: "which core owns the file?", tone: "muted" },
			{ text: "leak (choice) · auth · confidence 0.71", tone: "base" },
			{ text: "auth 0.71 · environment 0.21 · other 0.08", tone: "muted" },
			{ text: "true: the file is about authentication", tone: "muted" },
			{ text: "false: the file is about something else", tone: "muted" },
			{
				text: '- "leak" picked auth at confidence 0.71: the pick is plausible.',
				tone: "warning",
			},
		]);
	});

	test("ask_jev shows a score answer's levels", () => {
		const view = toolView(
			call(
				"ask_jev",
				{
					questions: {
						core: { type: "score", instructions: "how core is it?" },
					},
				},
				{
					lines: ["## Jev", "state s1"],
					isError: false,
					details: {
						answers: {
							core: {
								score: 0.78,
								confidence: 0.9,
								legend: { 0: "auth", 1: "environment", 2: "other" },
								probabilities: { auth: 0.1, environment: 0.2, other: 0.7 },
							},
						},
					},
					notes: [],
				},
			),
		);
		expect(view?.rows).toEqual([
			{ text: "how core is it?", tone: "muted" },
			{ text: "core (score) · 0.78 · confidence 0.90", tone: "base" },
			{ text: "other 0.70 · environment 0.20 · auth 0.10", tone: "muted" },
			{ text: "0 auth · 1 environment · 2 other", tone: "muted" },
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

	test("codemode lists one line per call, with what each call did", () => {
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
						"calls: glob (ok), read (error)",
					],
					isError: false,
					// The host's structured records carry each call's arguments, so
					// the lines name what the call actually did.
					details: {
						calls: [
							{
								name: "read",
								status: "ok",
								args: { path: "src/a.ts" },
								durationMs: 1200,
							},
							{
								name: "edit",
								status: "error",
								args: {
									path: "src/b.ts",
									edits: [{ oldText: "a", newText: "b" }],
								},
								durationMs: 1800,
							},
						],
					},
					notes: [],
				},
			),
		);
		expect(view?.icon).toBe("λ");
		// Collapsed the row is only the call's metadata; expanded it carries one
		// line per call below it, each with its tool's type glyph.
		expect(view?.summary).toBe("2 calls · 1 failed · 3.0s");
		expect(view?.rows).toEqual([
			{ id: "call:0", text: "→ read src/a.ts (ok)", tone: "muted" },
			{
				id: "call:1",
				text: "← edit src/b.ts · 1 edit (error)",
				tone: "error",
			},
		]);
		expect(view?.hint).toBeUndefined();
		// The script and its output are parts of their own, so either can be
		// folded away while the expanded call list stays in view.
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
			{ text: "calls: glob (ok), read (error)", tone: "muted" },
		]);
	});

	test("a script's calls fold into their own tool views", () => {
		const view = toolView(
			call(
				"codemode",
				{ code: "return 1;" },
				{
					lines: ["Script completed"],
					isError: false,
					details: {
						calls: [
							{
								name: "edit",
								status: "ok",
								args: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
								// edit reports its diff through `result.details`, which the host
								// captures per nested call.
								details: { diff: "@@ -1 +1 @@\n-a\n+b" },
							},
							{
								name: "read",
								status: "ok",
								args: { path: "b.ts" },
								output: "line one\nline two",
								isError: false,
							},
						],
					},
					notes: [],
				},
			),
		);
		// Each call is an expanded row with the same detail a standalone row would
		// have: the edit's diff and the read's text.
		expect(view?.rows?.[0]?.detail?.some((row) => row.text === "+b")).toBe(
			true,
		);
		expect(view?.rows?.[1]?.detail?.map((row) => row.text)).toEqual([
			"line one",
			"line two",
		]);
	});

	test("codemode falls back to the result's own call line", () => {
		const view = toolView(
			call(
				"codemode",
				{ code: "return 1;" },
				{
					lines: ["Script completed", "calls: glob (ok), read (error)"],
					isError: false,
					notes: [],
				},
			),
		);
		expect(view?.summary).toBe("2 calls · 1 failed");
		expect(view?.rows).toEqual([
			{ id: "call:0", text: "✱ glob (ok)", tone: "muted" },
			{ id: "call:1", text: "→ read (error)", tone: "error" },
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
		expect(pending?.rows).toEqual([]);
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
		expect(failed?.summary).toBe("script failed");
		expect(failed?.hint).toBeUndefined();
		expect(
			failed?.sections?.[1]?.rows.every((row) => row.tone === "error"),
		).toBe(true);
	});

	test("expanded views keep every line the tool produced", () => {
		// A long script and a long call list are shown whole: the expanded view
		// is where a reader goes to analyze the call.
		const script = Array.from(
			{ length: 20 },
			(_, index) => `line ${index}`,
		).join("\n");
		const calls = Array.from(
			{ length: 9 },
			(_, index) => `tool${index} (ok)`,
		).join(", ");
		const view = toolView(
			call(
				"codemode",
				{ code: script },
				{
					lines: ["Script completed", `calls: ${calls}`],
					isError: false,
					notes: [],
				},
			),
		);
		expect(view?.sections?.[0]?.rows.length).toBe(20);
		expect(view?.rows?.length).toBe(9);
		expect(view?.rows?.at(-1)?.text).toBe("• tool8 (ok)");

		// The same for a write's content and a diff.
		const content = Array.from(
			{ length: 60 },
			(_, index) => `line ${index}`,
		).join("\n");
		expect(
			toolView(call("write", { path: "a.ts", content }))?.rows?.length,
		).toBe(60);
		const diff = Array.from(
			{ length: 50 },
			(_, index) => `+added ${index}`,
		).join("\n");
		expect(
			toolView(
				call(
					"edit",
					{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
					{ lines: ["ok"], isError: false, details: { diff }, notes: [] },
				),
			)?.rows?.length,
		).toBe(50);
	});

	test("keeps the generic row for a tool without a view", () => {
		expect(toolView(call("developer_question", {}))).toBeUndefined();
		expect(toolView(call("agent_ask", { role: "planner" }))).toBeUndefined();
	});
});

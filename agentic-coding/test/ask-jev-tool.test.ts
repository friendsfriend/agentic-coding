import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import askJev, {
	assembleState,
	expandTargets,
	fmtTokens,
	readBinding,
	renderAnswers,
	validateQuestions,
} from "../../agent-definitions/extensions/ask-jev.ts";

const ENDPOINT = "http://127.0.0.1:9/v1/systemone";
const BINDING = JSON.stringify({
	provider: "laya-local",
	model: "laya-system-one",
	endpoint: ENDPOINT,
});
const NOUL = {
	questions: {
		leak: { type: "noul", instructions: "Does `files` leak a credential?" },
	},
};

const originalFetch = globalThis.fetch;
const originalBinding = process.env.AGENTIC_JEV;

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalBinding === undefined) delete process.env.AGENTIC_JEV;
	else process.env.AGENTIC_JEV = originalBinding;
});

interface Request {
	readonly url: string;
	readonly body: { state?: unknown; model?: string; questions?: unknown };
}

function stubEndpoint(payload: unknown): Request[] {
	const requests: Request[] = [];
	globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return requests;
}

interface ToolResult {
	readonly isError?: boolean;
	readonly content: readonly { readonly text?: string }[];
	readonly details?: unknown;
}

function loadTool(): {
	readonly name: string;
	readonly description: string;
	readonly execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<ToolResult>;
} {
	let tool: unknown;
	askJev({
		registerTool: (candidate) => {
			tool = candidate;
		},
	});
	if (!tool) throw new Error("the extension registered no tool");
	return tool as ReturnType<typeof loadTool>;
}

function textOf(result: ToolResult): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("ask_jev question validation", () => {
	test("a full block of all three types is accepted and forwarded as written", async () => {
		const block = {
			failure: {
				type: "noul",
				instructions: "Is `output` a real failure?",
				criteria: { true: "A", false: "B" },
			},
			kind: {
				type: "choice",
				instructions: "What kind?",
				criteria: { bug: "A bug", other: null },
			},
			risk: {
				type: "score",
				instructions: "How risky?",
				criteria: ["low", "medium", "high"],
			},
		};
		const result = validateQuestions(block);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ids).toEqual(["failure", "kind", "risk"]);
		expect(result.questions).toEqual(block);
	});

	test("a JSON string is accepted, an unparseable one is not", async () => {
		expect(validateQuestions(JSON.stringify(NOUL.questions)).ok).toBe(true);
		const broken = validateQuestions("{not json");
		expect(broken.ok).toBe(false);
		if (!broken.ok) expect(broken.error).toContain("not JSON");
	});

	test("each malformed shape is named instead of sent", async () => {
		const cases: Array<[unknown, string]> = [
			[{}, "non-empty object"],
			[{ q: { type: "vibe", instructions: "?" } }, "noul, choice, or score"],
			[{ q: { type: "noul" } }, "needs instructions"],
			[{ q: { type: "choice", instructions: "?" } }, "needs criteria"],
			[
				{ q: { type: "choice", instructions: "?", criteria: {} } },
				"no options",
			],
			[
				{ q: { type: "score", instructions: "?", criteria: ["only one"] } },
				"between 2 and 10",
			],
			[
				{ q: { type: "score", instructions: "?", criteria: ["a", ""] } },
				"non-blank",
			],
			[
				{ q: { type: "noul", instructions: "?", criteria: { maybe: "x" } } },
				"only describe true and false",
			],
		];
		for (const [block, expected] of cases) {
			const result = validateQuestions(block);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain(expected);
		}
	});
});

describe("ask_jev state assembly", () => {
	test("the agent's own JSON fields, files, and the command output become one state", async () => {
		const dir = tempDir("jev-state-");
		try {
			writeFileSync(join(dir, "a.ts"), "export const ok = 1\n");
			const assembled = assembleState(
				{
					own: '{"request":"the tests are red"}',
					paths: ["a.ts"],
					command: {
						command: "npm test",
						exit_code: 1,
						stdout: "1 failing",
						stderr: "",
					},
				},
				dir,
			);
			expect(assembled.ok).toBe(true);
			if (!assembled.ok) return;
			expect(assembled.assembled.state).toEqual({
				request: "the tests are red",
				files: { "a.ts": "export const ok = 1\n" },
				output: {
					command: "npm test",
					exit_code: 1,
					stdout: "1 failing",
					stderr: "",
				},
			});
			expect(assembled.assembled.summary).toContain("files (1)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("plain text is kept as text, and nothing at all is refused", async () => {
		const prose = assembleState(
			{ own: "a ticket about billing" },
			process.cwd(),
		);
		expect(prose.ok).toBe(true);
		if (prose.ok)
			expect(prose.assembled.state).toEqual({ text: "a ticket about billing" });
		const empty = assembleState({}, process.cwd());
		expect(empty.ok).toBe(false);
		if (!empty.ok) expect(empty.error).toContain("nothing to judge");
	});

	test("over the budget the call is refused with a split that fits, never truncated", async () => {
		const assembled = assembleState(
			{
				command: {
					command: "cat big",
					exit_code: 0,
					stdout: "x".repeat(250_000),
					stderr: "",
				},
			},
			process.cwd(),
		);
		expect(assembled.ok).toBe(false);
		if (assembled.ok) return;
		expect(assembled.error).toContain("Nothing was sent");
		expect(assembled.error).toContain("Too large for any single call");
	});

	test("pasting a corpus of files instead of naming them is refused", async () => {
		const assembled = assembleState({ own: "x".repeat(9_000) }, process.cwd());
		expect(assembled.ok).toBe(false);
		if (!assembled.ok)
			expect(assembled.error).toContain("pass paths or command");
	});

	test("globs expand, and binaries and dependency directories are skipped", async () => {
		const dir = tempDir("jev-glob-");
		try {
			writeFileSync(join(dir, "keep.ts"), "keep\n");
			writeFileSync(join(dir, "skip.png"), "binary\n");
			mkdirSync(join(dir, "node_modules"));
			writeFileSync(join(dir, "node_modules", "dep.ts"), "dep\n");
			mkdirSync(join(dir, "sub"));
			writeFileSync(join(dir, "sub", "inner.ts"), "inner\n");
			expect(expandTargets(["*.ts"], dir)).toEqual([
				join(dir, "keep.ts"),
				join(dir, "sub", "inner.ts"),
			]);
			expect(expandTargets(["."], dir)).toEqual([
				join(dir, "keep.ts"),
				join(dir, "sub", "inner.ts"),
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("ask_jev answers", () => {
	test("a count below a thousand never reads as thousands", async () => {
		// The smoke run printed "65k tokens" for one small file.
		expect(fmtTokens(0)).toBe("0");
		expect(fmtTokens(65)).toBe("65");
		expect(fmtTokens(999)).toBe("999");
		expect(fmtTokens(2_000)).toBe("2k");
		expect(fmtTokens(60_000)).toBe("60k");
		expect(fmtTokens(62_500)).toBe("62.5k");
	});

	test("each type is rendered with its confidence and its distribution", async () => {
		const rendered = renderAnswers(
			{
				failure: { type: "noul", noul: 0.92, confidence: 0.84 },
				kind: {
					type: "choice",
					choice: "bug_in_code",
					confidence: 0.91,
					probabilities: { bug_in_code: 0.91, wrong_test: 0.09 },
				},
				risk: {
					type: "score",
					score: 0.5,
					confidence: 0.8,
					legend: { 0: "low", 1: "high" },
				},
			},
			["failure", "kind", "risk"],
		);
		expect(rendered.text).toContain("failure (noul): 0.92 confidence 0.84");
		expect(rendered.text).toContain(
			"kind (choice): bug_in_code confidence 0.91 [*bug_in_code 0.91, wrong_test 0.09]",
		);
		expect(rendered.text).toContain('risk (score): 0.50 of 1 (nearest "high")');
		expect(rendered.warnings).toEqual([]);
	});

	test("a score is read on its own scale, not as a fraction of one", async () => {
		// Live: three levels scored 1.69, and reading it as a fraction named the
		// wrong level. The position is 1.69 of 2, nearest level 2.
		const rendered = renderAnswers(
			{
				risk: {
					type: "score",
					score: 1.69,
					confidence: 0.38,
					legend: {
						0: "Isolated, tested",
						1: "Some callers",
						2: "Money sensitive, no tests",
					},
					probabilities: { 0: 0.02, 1: 0.27, 2: 0.71 },
				},
			},
			["risk"],
		);
		expect(rendered.text).toContain(
			'risk (score): 1.69 of 2 (nearest "Money sensitive, no tests")',
		);
	});

	test("a guess is reported as a guess for every type, and a missing answer is named", async () => {
		const rendered = renderAnswers(
			{
				failure: { type: "noul", noul: 0.52, confidence: 0.04 },
				kind: {
					type: "choice",
					choice: "other",
					confidence: 0.31,
					probabilities: { other: 0.4 },
				},
				risk: {
					type: "score",
					score: 0.4,
					confidence: 0.18,
					legend: { 0: "low" },
				},
			},
			["failure", "kind", "risk", "absent"],
		);
		expect(rendered.warnings.length).toBe(4);
		expect(rendered.warnings.join(" ")).toContain("coin flip");
		expect(rendered.warnings.join(" ")).toContain(
			"options may not cover the state",
		);
		expect(rendered.warnings.join(" ")).toContain("Treat it as a range");
		expect(rendered.text).toContain("absent: no answer came back.");
	});
});

describe("ask_jev binding", () => {
	test("a complete binding is read, an unusable one is not", async () => {
		expect(readBinding({ AGENTIC_JEV: BINDING })).toEqual({
			provider: "laya-local",
			model: "laya-system-one",
			endpoint: ENDPOINT,
		});
		expect(readBinding({ AGENTIC_JEV: "{}" })).toBeUndefined();
		expect(readBinding({ AGENTIC_JEV: "not json" })).toBeUndefined();
		expect(readBinding({})).toBeUndefined();
	});
});

describe("ask_jev tool", () => {
	test("the tool the profiles advertise is the tool the extension registers", async () => {
		const tool = loadTool();
		expect(tool.name).toBe("ask_jev");
		expect(tool.description).toContain("noul");
		expect(tool.description).toContain("choice");
		expect(tool.description).toContain("score");
	});

	test("with no binding it reports unavailability and never calls an endpoint", async () => {
		delete process.env.AGENTIC_JEV;
		const requests = stubEndpoint({});
		const result = await loadTool().execute("1", NOUL);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("unavailable");
		expect(requests).toEqual([]);
	});

	test("a malformed question block is refused before any transport", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const requests = stubEndpoint({});
		const result = await loadTool().execute("1", {
			questions: { q: { type: "vibe" } },
		});
		expect(result.isError).toBe(true);
		expect(requests).toEqual([]);
	});

	test("files and command output reach the classifier and never reach the agent", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const dir = tempDir("jev-tool-");
		try {
			writeFileSync(join(dir, "secret.ts"), "const SECRET_MARKER = 1\n");
			const requests = stubEndpoint({
				answers: { leak: { type: "noul", noul: 0.97, confidence: 0.94 } },
				usage: { input_tokens: 120, output_tokens: 2, cost: 0.00004 },
			});
			const executed: Array<{ name: string; args: unknown }> = [];
			const tool = loadTool();
			const result = await tool.execute(
				"1",
				{ ...NOUL, paths: ["secret.ts"], command: "npm test" },
				undefined,
				undefined,
				{
					cwd: dir,
					tools: [{ name: "bash" }],
					executeTool: async (name: string, args: unknown) => {
						executed.push({ name, args });
						return {
							content: [{ type: "text", text: "COMMAND_MARKER 1 failing" }],
						};
					},
				},
			);
			expect(executed).toEqual([
				{ name: "bash", args: { command: "npm test" } },
			]);
			const state = requests[0]?.body.state as Record<string, unknown>;
			expect(state.files).toEqual({ "secret.ts": "const SECRET_MARKER = 1\n" });
			expect((state.output as Record<string, unknown>).stdout).toContain(
				"COMMAND_MARKER",
			);
			const text = textOf(result);
			expect(text).toContain("leak (noul): 0.97");
			expect(text).toContain("jev 120 in / 2 out / $0.000040");
			expect(text).not.toContain("SECRET_MARKER");
			expect(text).not.toContain("COMMAND_MARKER");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("with no bash tool the command is refused instead of run behind pi", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const requests = stubEndpoint({});
		const result = await loadTool().execute(
			"1",
			{ ...NOUL, command: "rm -rf /" },
			undefined,
			undefined,
			{ cwd: process.cwd(), tools: [] },
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("bash tool is not available");
		expect(requests).toEqual([]);
	});

	test("a state handle comes back on every result", async () => {
		process.env.AGENTIC_JEV = BINDING;
		stubEndpoint({
			answers: { leak: { type: "noul", noul: 0.2, confidence: 0.9 } },
		});
		const result = await loadTool().execute("1", {
			...NOUL,
			state: "a ticket",
		});
		const handle = /state (s[0-9a-f]{6})/.exec(textOf(result))?.[1] ?? "";
		expect(handle).not.toBe("");
		expect(textOf(result)).toContain(
			`state ${handle} · judged your state (text)`,
		);
	});

	test("a reuse asks new questions without re-running the command, on an unchanged state", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const dir = tempDir("jev-reuse-");
		try {
			writeFileSync(join(dir, "billing.ts"), "export const rate = 1\n");
			const requests = stubEndpoint({
				answers: {
					leak: { type: "noul", noul: 0.2, confidence: 0.9 },
					risk: {
						type: "score",
						score: 1.2,
						confidence: 0.8,
						legend: { 0: "low", 1: "high" },
					},
				},
			});
			const executed: string[] = [];
			const tool = loadTool();
			const ctx = {
				cwd: dir,
				tools: [{ name: "bash" }],
				executeTool: async (_name: string, args: unknown) => {
					executed.push(String((args as { command: string }).command));
					return { content: [{ type: "text", text: "1 failing" }] };
				},
			};
			const first = await tool.execute(
				"1",
				{ ...NOUL, paths: ["billing.ts"], command: "npm test" },
				undefined,
				undefined,
				ctx,
			);
			expect(executed).toEqual(["npm test"]);
			const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
			const risk = {
				type: "score",
				instructions: "How risky?",
				criteria: ["low", "high"],
			};
			const second = await tool.execute(
				"2",
				{ questions: { risk }, reuse: handle },
				undefined,
				undefined,
				ctx,
			);
			// The expensive part is not repeated, and the situation is identical.
			expect(executed).toEqual(["npm test"]);
			expect(requests[1]?.body.state).toEqual(requests[0]?.body.state);
			expect(requests[1]?.body.questions).toEqual({ risk });
			const text = textOf(second);
			expect(text).toContain(`reused ${handle}`);
			expect(text).toContain("its files are unchanged");
			expect(text).toContain("the output of `npm test` is the one from");
			expect(text).toContain("was not re-run");
			expect(text).toContain("risk (score)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reuse drops a file that has since been removed, and says so", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const dir = tempDir("jev-removed-");
		try {
			writeFileSync(join(dir, "billing.ts"), "export const rate = 1\n");
			const requests = stubEndpoint({
				answers: { leak: { type: "noul", noul: 0.2 } },
			});
			const tool = loadTool();
			const ctx = { cwd: dir, tools: [] };
			const first = await tool.execute(
				"1",
				{ ...NOUL, paths: ["billing.ts"] },
				undefined,
				undefined,
				ctx,
			);
			const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
			rmSync(join(dir, "billing.ts"));
			const second = await tool.execute(
				"2",
				{ ...NOUL, reuse: handle },
				undefined,
				undefined,
				ctx,
			);
			// The state held only that file, so the reuse is left with nothing to judge.
			// It is refused, and the refusal says what happened to the file.
			expect(second.isError).toBe(true);
			expect(textOf(second)).toContain("nothing to judge");
			expect(textOf(second)).toContain(
				"dropped 1 removed file(s) (billing.ts)",
			);
			expect(requests.length).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a reuse re-reads only the files that changed", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const dir = tempDir("jev-refresh-");
		try {
			writeFileSync(join(dir, "a.ts"), "a one\n");
			writeFileSync(join(dir, "b.ts"), "b one\n");
			const requests = stubEndpoint({
				answers: { leak: { type: "noul", noul: 0.2 } },
			});
			const tool = loadTool();
			const ctx = { cwd: dir, tools: [] };
			const first = await tool.execute(
				"1",
				{ ...NOUL, paths: ["*.ts"] },
				undefined,
				undefined,
				ctx,
			);
			const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
			// Written with a distinct mtime so the stat check sees the change.
			writeFileSync(join(dir, "a.ts"), "a two, longer\n");
			const second = await tool.execute(
				"2",
				{ ...NOUL, reuse: handle },
				undefined,
				undefined,
				ctx,
			);
			const state = requests[1]?.body.state as {
				files: Record<string, string>;
			};
			expect(state.files["a.ts"]).toBe("a two, longer\n");
			expect(state.files["b.ts"]).toBe("b one\n");
			expect(textOf(second)).toContain("re-read 1 changed file(s) (a.ts)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reuse is refused alongside new inputs, and an unknown handle names what is retained", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const requests = stubEndpoint({
			answers: { leak: { type: "noul", noul: 0.2 } },
		});
		const tool = loadTool();
		const ctx = { cwd: process.cwd(), tools: [] };
		const first = await tool.execute(
			"1",
			{ ...NOUL, state: "a ticket" },
			undefined,
			undefined,
			ctx,
		);
		const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
		const both = await tool.execute(
			"2",
			{ ...NOUL, reuse: handle, state: "something else" },
			undefined,
			undefined,
			ctx,
		);
		expect(both.isError).toBe(true);
		expect(textOf(both)).toContain("pass reuse on its own");
		const unknown = await tool.execute(
			"3",
			{ ...NOUL, reuse: "s99" },
			undefined,
			undefined,
			ctx,
		);
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain('unknown state "s99"');
		expect(textOf(unknown)).toContain(
			`Retained here: ${handle} (your state (text)`,
		);
		expect(requests.length).toBe(1);
	});

	test("a call with no inputs names the state it could have reused", async () => {
		process.env.AGENTIC_JEV = BINDING;
		stubEndpoint({ answers: { leak: { type: "noul", noul: 0.2 } } });
		const tool = loadTool();
		const ctx = { cwd: process.cwd(), tools: [] };
		await tool.execute(
			"1",
			{ ...NOUL, state: "a ticket" },
			undefined,
			undefined,
			ctx,
		);
		const result = await tool.execute("2", NOUL, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("nothing to judge");
	});

	test("each tool registration keeps its own retained states", async () => {
		process.env.AGENTIC_JEV = BINDING;
		stubEndpoint({ answers: { leak: { type: "noul", noul: 0.2 } } });
		const ctx = { cwd: process.cwd(), tools: [] };
		const first = await loadTool().execute(
			"1",
			{ ...NOUL, state: "a ticket" },
			undefined,
			undefined,
			ctx,
		);
		const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
		expect(handle).not.toBe("");
		// A handle from another session resolves to nothing rather than aliasing
		// whatever this session happens to call by the same name.
		const isolated = await loadTool().execute(
			"2",
			{ ...NOUL, reuse: handle },
			undefined,
			undefined,
			ctx,
		);
		expect(isolated.isError).toBe(true);
		expect(textOf(isolated)).toContain(`unknown state "${handle}"`);
	});

	test("every state gets its own generated handle, never a counter", async () => {
		process.env.AGENTIC_JEV = BINDING;
		stubEndpoint({ answers: { leak: { type: "noul", noul: 0.2 } } });
		const ctx = { cwd: process.cwd(), tools: [] };
		const tool = loadTool();
		const handles: string[] = [];
		for (const index of [1, 2, 3]) {
			const result = await tool.execute(
				String(index),
				{ ...NOUL, state: `a ticket ${index}` },
				undefined,
				undefined,
				ctx,
			);
			handles.push(/state (s[0-9a-f]{6})/.exec(textOf(result))?.[1] ?? "");
		}
		expect(handles.filter((entry) => entry !== "").length).toBe(3);
		expect(new Set(handles).size).toBe(3);
	});

	test("an over-budget call sends nothing and says how to split it", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const requests = stubEndpoint({});
		const result = await loadTool().execute(
			"1",
			{ ...NOUL, state: "x".repeat(9_000) },
			undefined,
			undefined,
			{ cwd: process.cwd(), tools: [] },
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Nothing was sent");
		expect(requests).toEqual([]);
	});

	test("too many files is refused with the cap that was exceeded", async () => {
		process.env.AGENTIC_JEV = BINDING;
		const dir = tempDir("jev-cap-");
		try {
			for (let index = 0; index < 21; index += 1)
				writeFileSync(join(dir, `f${index}.ts`), "x\n");
			const requests = stubEndpoint({});
			const result = await loadTool().execute(
				"1",
				{ ...NOUL, paths: ["*.ts"] },
				undefined,
				undefined,
				{ cwd: dir, tools: [] },
			);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("one call holds 20");
			expect(requests).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unreachable classifier is reported, not swallowed", async () => {
		process.env.AGENTIC_JEV = BINDING;
		globalThis.fetch = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		const result = await loadTool().execute(
			"1",
			{ ...NOUL, state: "a ticket" },
			undefined,
			undefined,
			{
				cwd: process.cwd(),
				tools: [],
			},
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("could not be reached");
		expect(textOf(result)).toContain("Nothing was decided");
	});
});

// durable-agent-tools: "In-session judgment tool" (`ask_jev`). Exercises the
// real tool `execute()` directly: no binding -> honest unavailable answer and
// no network call; with a binding -> state assembly from own/paths/command
// (through a fake `ExecutionEnv`) and the classifier response surfaced.
import { afterEach, describe, expect, test } from "bun:test";
import {
	createAskJevExtension,
	type DurableRunContext,
} from "../src/agent-host/tools.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function fakeEnv(
	files: Record<string, string>,
	commandOutput?: { exitCode: number; output?: string },
) {
	return {
		readTextFile: async (filePath: string) => {
			const match = Object.entries(files).find(([name]) =>
				filePath.endsWith(name),
			);
			return match
				? { ok: true, value: match[1] }
				: { ok: false, error: new Error("not found") };
		},
		// The real environment streams combined stdout/stderr through
		// `onOutput`; the resolved value carries only the exit code.
		exec: async (
			_command: string,
			options?: { onOutput?: (text: string) => void },
		) => {
			if (!commandOutput) return { ok: false, error: new Error("failed") };
			if (commandOutput.output) options?.onOutput?.(commandOutput.output);
			return { ok: true, value: { exitCode: commandOutput.exitCode } };
		},
	} as never;
}

function runContext(
	overrides: Partial<DurableRunContext> = {},
): DurableRunContext {
	return { runId: "run-1", cwd: "/work", env: {}, ...overrides };
}

interface ToolResult {
	readonly isError?: boolean;
	readonly content?: readonly { readonly text?: string }[];
	readonly details?: unknown;
}

function textOf(result: ToolResult): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** One bound `ask_jev` call: the extension registers the tool once, and every
 * test drives that tool's real `execute()`. */
function toolWith(
	context: DurableRunContext,
	env: unknown,
): { execute: (args: Record<string, unknown>) => Promise<ToolResult> } {
	const extension = createAskJevExtension(() => context);
	const tool = extension.tools?.find((item) => item.name === "ask_jev");
	if (!tool) throw new Error("ask_jev tool not found");
	return {
		execute: (args) =>
			tool.execute(
				args as never,
				{ conversationId: 1, env } as never,
				undefined as never,
			) as Promise<ToolResult>,
	};
}

const BINDING = {
	provider: "laya-local",
	model: "laya-system-one",
	endpoint: "http://127.0.0.1:9/v1/systemone",
};

const LEAK_QUESTION = {
	leak: { type: "noul", instructions: "Does `files` leak a credential?" },
};

/** Capture the request bodies the tool sends, so a test can assert what the
 * classifier was actually asked. */
function stubClassifier(payload: unknown): Array<Record<string, unknown>> {
	const requests: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return requests;
}

describe("ask_jev", () => {
	test("without a binding, reports unavailable and makes no network call", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			throw new Error("must not be called");
		}) as unknown as typeof fetch;
		const extension = createAskJevExtension(() => runContext());
		const tool = extension.tools?.find((item) => item.name === "ask_jev");
		if (!tool) throw new Error("ask_jev tool not found");
		const result = await tool.execute(
			{ questions: { leak: { type: "noul", instructions: "x" } } },
			{ conversationId: 1, env: fakeEnv({}) } as never,
			undefined as never,
		);
		expect(called).toBe(false);
		expect(
			(result.content?.[0] as { text: string } | undefined)?.text,
		).toContain("unavailable");
		expect(result.isError).not.toBe(true);
	});

	test("with a binding, assembles state from own note, a named file, and a command, and returns the answers", async () => {
		let capturedBody: unknown;
		let capturedUrl: unknown;
		globalThis.fetch = (async (url: string, init: RequestInit) => {
			capturedUrl = url;
			capturedBody = JSON.parse(String(init.body));
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					answers: { leak: { noul: 0.2, confidence: 0.9 } },
				}),
			} as Response;
		}) as typeof fetch;
		const context = runContext({
			jev: {
				provider: "typesafe",
				model: "jev-latest",
				endpoint: "http://127.0.0.1:9/classify",
			},
		});
		const extension = createAskJevExtension(() => context);
		const tool = extension.tools?.find((item) => item.name === "ask_jev");
		if (!tool) throw new Error("ask_jev tool not found");
		const result = await tool.execute(
			{
				state: "the change looks fine",
				paths: ["notes.md"],
				command: "bun test",
				questions: {
					leak: { type: "noul", instructions: "Does this leak a secret?" },
				},
			},
			{
				conversationId: 1,
				env: fakeEnv({ "notes.md": "no secrets here" }, { exitCode: 0 }),
			} as never,
			undefined as never,
		);
		expect(capturedUrl).toBe("http://127.0.0.1:9/classify");
		expect(capturedBody).toMatchObject({ model: "jev-latest" });
		const state = (capturedBody as { state: Record<string, unknown> }).state;
		// The agent's own prose stays text, under its own key: no JSON parse
		// turns a sentence into a field name.
		expect(state.text).toBe("the change looks fine");
		expect(state.files).toMatchObject({ "notes.md": "no secrets here" });
		expect(state.output).toMatchObject({ command: "bun test", exit_code: 0 });
		expect(result.details).toMatchObject({
			answers: { leak: { noul: 0.2, confidence: 0.9 } },
		});
		expect(result.isError).not.toBe(true);
	});

	test("rejects a malformed questions block before any network call", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			throw new Error("must not be called");
		}) as unknown as typeof fetch;
		const context = runContext({
			jev: { provider: "p", model: "m", endpoint: "http://x" },
		});
		const extension = createAskJevExtension(() => context);
		const tool = extension.tools?.find((item) => item.name === "ask_jev");
		if (!tool) throw new Error("ask_jev tool not found");
		const result = await tool.execute(
			{ questions: {} },
			{ conversationId: 1, env: fakeEnv({}) } as never,
			undefined as never,
		);
		expect(called).toBe(false);
		expect(result.isError).toBe(true);
	});

	test("a non-ok classifier response is surfaced as an error result", async () => {
		globalThis.fetch = (async () =>
			({
				ok: false,
				status: 503,
				statusText: "Service Unavailable",
			}) as Response) as unknown as typeof fetch;
		const context = runContext({
			jev: { provider: "p", model: "m", endpoint: "http://x" },
		});
		const extension = createAskJevExtension(() => context);
		const tool = extension.tools?.find((item) => item.name === "ask_jev");
		if (!tool) throw new Error("ask_jev tool not found");
		const result = await tool.execute(
			{
				// A state is named so the request reaches the classifier: an empty
				// state is refused before any transport.
				state: "a ticket",
				questions: { a: { type: "noul", instructions: "x" } },
			},
			{ conversationId: 1, env: fakeEnv({}) } as never,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(
			(result.content?.[0] as { text: string } | undefined)?.text,
		).toContain("503");
	});
});

// The durable port must apply the pi extension's wire contract, not just
// forward whatever the model wrote: a malformed question block is what makes
// the classifier answer `score: 0, confidence: 1` or an empty `choice`.
describe("ask_jev contract", () => {
	test("the tool carries the question schema and the reuse parameter", () => {
		const extension = createAskJevExtension(() => runContext());
		const tool = extension.tools?.find((item) => item.name === "ask_jev");
		// The schema is what the model writes against: without the three types in
		// the description, a malformed block is the model's only option, and the
		// classifier answers it with a confident-looking number.
		expect(tool?.description).toContain("noul");
		expect(tool?.description).toContain("choice");
		expect(tool?.description).toContain("score");
		expect(tool?.description).toContain("criteria");
		expect(tool?.description).toContain("reuse");
		expect(JSON.stringify(tool?.parameters)).toContain("reuse");
	});

	test("every malformed question shape is refused before any network call", async () => {
		const cases: Array<[Record<string, unknown>, string]> = [
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
				{ q: { type: "noul", instructions: "?", criteria: { maybe: "x" } } },
				"only describe true and false",
			],
		];
		for (const [questions, expected] of cases) {
			let called = false;
			globalThis.fetch = (() => {
				called = true;
				throw new Error("must not be called");
			}) as unknown as typeof fetch;
			const tool = toolWith(runContext({ jev: BINDING }), fakeEnv({}));
			const result = await tool.execute({ questions });
			expect(called, JSON.stringify(questions)).toBe(false);
			expect(result.isError, JSON.stringify(questions)).toBe(true);
			expect(textOf(result)).toContain(expected);
		}
	});

	test("the command's output reaches the classifier and never the agent", async () => {
		const requests = stubClassifier({
			answers: { failure: { noul: 0.92, confidence: 0.84 } },
			usage: { input_tokens: 120, output_tokens: 2, cost: 0.00004 },
		});
		const tool = toolWith(
			runContext({ jev: BINDING }),
			fakeEnv({}, { exitCode: 1, output: "COMMAND_MARKER: 1 failing\n" }),
		);
		const result = await tool.execute({
			questions: {
				failure: { type: "noul", instructions: "Is `output` a real failure?" },
			},
			command: "bun test",
		});
		const output = ((requests[0]?.state as Record<string, unknown> | undefined)
			?.output ?? {}) as Record<string, unknown>;
		expect(output).toMatchObject({ command: "bun test", exit_code: 1 });
		expect(String(output.stdout)).toContain("COMMAND_MARKER");
		const text = textOf(result);
		expect(text).toContain("failure (noul): 0.92");
		expect(text).toContain("jev 120 in / 2 out / $0.000040");
		expect(text).not.toContain("COMMAND_MARKER");
	});

	test("a low-confidence answer is reported as a guess, and a missing one is named", async () => {
		stubClassifier({
			answers: {
				risk: { score: 1, confidence: 0.2, legend: { 0: "low", 1: "high" } },
			},
		});
		const tool = toolWith(runContext({ jev: BINDING }), fakeEnv({}));
		const result = await tool.execute({
			questions: {
				risk: {
					type: "score",
					instructions: "How risky?",
					criteria: ["low", "high"],
				},
				absent: { type: "noul", instructions: "Is it real?" },
			},
			state: "a ticket about billing",
		});
		const text = textOf(result);
		expect(text).toContain(
			'risk (score): 1.00 of 1 (nearest "high") confidence 0.20',
		);
		expect(text).toContain("Treat it as a range, not a level");
		expect(text).toContain("absent: no answer came back.");
		expect(text).toContain("nothing was decided for it");
	});

	test("an over-budget state is refused and nothing is sent", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			throw new Error("must not be called");
		}) as unknown as typeof fetch;
		const big = "x".repeat(90 * 1024);
		const files: Record<string, string> = {
			"a.txt": big,
			"b.txt": big,
			"c.txt": big,
		};
		const tool = toolWith(runContext({ jev: BINDING }), fakeEnv(files));
		const result = await tool.execute({
			questions: LEAK_QUESTION,
			paths: ["a.txt", "b.txt", "c.txt"],
		});
		expect(called).toBe(false);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Nothing was sent");
		expect(textOf(result)).toContain("one call holds");
	});

	test("a file over the per-file limit is skipped and reported, never truncated", async () => {
		const requests = stubClassifier({
			answers: { leak: { noul: 0.2, confidence: 0.9 } },
		});
		const tool = toolWith(
			runContext({ jev: BINDING }),
			fakeEnv({ "ok.txt": "fine\n", "big.txt": "x".repeat(97 * 1024) }),
		);
		const result = await tool.execute({
			questions: LEAK_QUESTION,
			paths: ["ok.txt", "big.txt"],
		});
		const files = ((requests[0]?.state as Record<string, unknown> | undefined)
			?.files ?? {}) as Record<string, string>;
		expect(Object.keys(files)).toEqual(["ok.txt"]);
		expect(textOf(result)).toContain("skipped big.txt (over 96 KiB)");
	});

	test("reuse asks new questions without re-running the command, and names what it kept", async () => {
		const requests = stubClassifier({
			answers: { leak: { noul: 0.2, confidence: 0.9 } },
		});
		const files: Record<string, string> = { "notes.md": "no secrets here" };
		let reads = 0;
		let execs = 0;
		const env = {
			readTextFile: async () => {
				reads += 1;
				return { ok: true, value: files["notes.md"] };
			},
			exec: async (
				_command: string,
				options?: { onOutput?: (text: string) => void },
			) => {
				execs += 1;
				options?.onOutput?.("1 failing");
				return { ok: true, value: { exitCode: 1 } };
			},
		} as never;
		const tool = toolWith(runContext({ jev: BINDING }), env);
		const first = await tool.execute({
			questions: LEAK_QUESTION,
			paths: ["notes.md"],
			command: "bun test",
		});
		const handle = /state (s[0-9a-f]{6})/.exec(textOf(first))?.[1] ?? "";
		expect(handle).not.toBe("");

		const second = await tool.execute({
			questions: {
				risk: {
					type: "score",
					instructions: "How risky?",
					criteria: ["low", "high"],
				},
			},
			reuse: handle,
		});
		expect(execs).toBe(1);
		// The named files are re-read for the new round; the command is not re-run.
		expect(reads).toBe(2);
		expect(textOf(second)).toContain(`reused ${handle}`);
		expect(textOf(second)).toContain("the output of `bun test` was not re-run");
		expect(
			(requests[1]?.state as Record<string, unknown> | undefined)?.files,
		).toMatchObject({ "notes.md": "no secrets here" });

		const unknown = await tool.execute({
			questions: LEAK_QUESTION,
			reuse: "s99",
		});
		expect(unknown.isError).toBe(true);
		expect(textOf(unknown)).toContain('unknown state "s99"');
		expect(textOf(unknown)).toContain(`${handle} (`);

		const mixed = await tool.execute({
			questions: LEAK_QUESTION,
			reuse: handle,
			state: "something else",
		});
		expect(mixed.isError).toBe(true);
		expect(textOf(mixed)).toContain("pass reuse on its own");
	});
});

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
	commandOutput?: { exitCode: number },
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
		exec: async () =>
			commandOutput
				? { ok: true, value: commandOutput }
				: { ok: false, error: new Error("failed") },
	} as never;
}

function runContext(
	overrides: Partial<DurableRunContext> = {},
): DurableRunContext {
	return { runId: "run-1", cwd: "/work", env: {}, ...overrides };
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
		expect(state.state).toBe("the change looks fine");
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
			{ questions: { a: { type: "noul", instructions: "x" } } },
			{ conversationId: 1, env: fakeEnv({}) } as never,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(
			(result.content?.[0] as { text: string } | undefined)?.text,
		).toContain("503");
	});
});

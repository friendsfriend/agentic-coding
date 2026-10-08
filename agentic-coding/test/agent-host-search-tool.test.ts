// durable-agent-tools: "Search tool" (`grep`). A durable run's coding tools
// carry no search of their own, so a verifier's review would otherwise be one
// `bash` grep/sed call — and one model turn — per file. This exercises the real
// tool `execute()` against a fake execution environment: the command it builds,
// the scoping it refuses, and the result it hands back.
import { describe, expect, test } from "bun:test";
import { createSearchExtension } from "../src/agent-host/tools.ts";

interface ToolResult {
	readonly isError?: boolean;
	readonly content?: readonly { readonly text?: string }[];
}

interface ExecCall {
	readonly command: string;
	readonly cwd: string;
}

/** A fake environment that records the commands the tool runs and answers with
 * canned output, so the assertions are about the tool's own behaviour. */
function fakeEnv(options: {
	readonly output?: string;
	readonly failCommand?: string;
	readonly exitCode?: number;
}) {
	const calls: ExecCall[] = [];
	return {
		calls,
		env: {
			cwd: "/work",
			exec: async (
				command: string,
				execOptions?: { cwd?: string; onOutput?: (text: string) => void },
			) => {
				calls.push({ command, cwd: execOptions?.cwd ?? "" });
				if (options.failCommand && command.startsWith(options.failCommand))
					return { ok: false, error: { code: "enoent" } };
				execOptions?.onOutput?.(options.output ?? "");
				return { ok: true, value: { exitCode: options.exitCode ?? 0 } };
			},
		} as never,
	};
}

function grepTool() {
	const extension = createSearchExtension();
	const tool = extension.tools?.find((item) => item.name === "grep");
	if (!tool) throw new Error("grep tool not found");
	return (args: Record<string, unknown>, env: unknown) =>
		tool.execute(
			args as never,
			{ conversationId: 1, env } as never,
			undefined as never,
		) as Promise<ToolResult>;
}

function textOf(result: ToolResult): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

describe("durable grep tool", () => {
	test("searches the scoped path and returns capped path:line hits", async () => {
		const { env, calls } = fakeEnv({
			output: Array.from(
				{ length: 120 },
				(_, index) => `src/file.ts:${index + 1}: hit ${index}`,
			).join("\n"),
		});
		const run = grepTool();
		const result = await run(
			{ pattern: "hit", path: "agentic-coding/src" },
			env,
		);
		expect(result.isError).not.toBe(true);
		expect(calls[0]?.command).toContain("rg --line-number");
		expect(calls[0]?.command).toContain("'agentic-coding/src'");
		expect(calls[0]?.cwd).toBe("/work");
		const lines = textOf(result).split("\n");
		// The default cap holds the result to a readable turn.
		expect(lines.filter((line) => line.includes("hit "))).toHaveLength(80);
		expect(textOf(result)).toContain("40 more matching line(s)");
		expect(textOf(result)).toContain("src/file.ts:1: hit 0");
	});

	test("a pattern with a quote stays a pattern, and a glob is passed through", async () => {
		const { env, calls } = fakeEnv({ output: "src/a.ts:2: x" });
		const run = grepTool();
		await run({ pattern: "it's", path: ".", glob: "*.ts" }, env);
		expect(calls[0]?.command).toContain(`'it'\\''s'`);
		expect(calls[0]?.command).toContain("--glob '*.ts'");
	});

	test("refuses a path outside the run's repository", async () => {
		const { env, calls } = fakeEnv({ output: "" });
		const run = grepTool();
		const absolute = await run({ pattern: "x", path: "/etc" }, env);
		expect(absolute.isError).toBe(true);
		expect(textOf(absolute)).toContain("absolute path");
		const escaping = await run({ pattern: "x", path: "../../secrets" }, env);
		expect(escaping.isError).toBe(true);
		expect(textOf(escaping)).toContain("escapes the repository");
		// Nothing was executed for either.
		expect(calls).toHaveLength(0);
	});

	test("falls back to the platform grep when ripgrep is unavailable", async () => {
		const { env, calls } = fakeEnv({
			output: "src/a.ts:3: match",
			failCommand: "rg",
		});
		const run = grepTool();
		const result = await run({ pattern: "match", ignoreCase: true }, env);
		expect(result.isError).not.toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.command).toContain("grep -rnI -i");
		expect(textOf(result)).toContain("src/a.ts:3: match");
	});

	test("reports no match without failing the turn", async () => {
		const { env } = fakeEnv({ output: "", exitCode: 1 });
		const run = grepTool();
		const result = await run({ pattern: "nothing" }, env);
		expect(result.isError).not.toBe(true);
		expect(textOf(result)).toContain("no match for /nothing/");
	});

	test("stops reading a huge result and says so", async () => {
		// A pattern that matches half the repository must not be buffered in the
		// host only to be cut back to the requested lines.
		const { env } = fakeEnv({
			output: Array.from(
				{ length: 4000 },
				(_, index) => `src/big.ts:${index + 1}: ${"x".repeat(120)}`,
			).join("\n"),
		});
		const run = grepTool();
		const result = await run({ pattern: "x" }, env);
		expect(textOf(result)).toContain("the search stopped early");
		expect(Buffer.byteLength(textOf(result))).toBeLessThan(64 * 1024);
	});

	test("refuses a maxMatches above the hard cap instead of returning it", async () => {
		const { env } = fakeEnv({
			output: Array.from(
				{ length: 500 },
				(_, index) => `src/a.ts:${index + 1}: hit`,
			).join("\n"),
		});
		const run = grepTool();
		const result = await run({ pattern: "hit", maxMatches: 5000 }, env);
		expect(
			textOf(result)
				.split("\n")
				.filter((line) => line.includes(": hit")).length,
		).toBe(400);
	});
});

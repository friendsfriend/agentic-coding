// The `bash` tool's wall-clock bound (efficiency review step 3, item 2): the
// default a call gets when it passes no `timeout`, the caller's own override and
// its ceiling, the line a stopped call returns, the failure kind it is
// classified as, and the process group a stopped command leaves behind.
//
// Two kinds of check: a fake environment for the arguments and the text, and
// the real `NodeExecutionEnv` for the one claim a fake cannot make — that a
// command stopped by the bound takes its child processes with it. The real one
// uses a one-second bound, so the suite never sleeps for a real timeout.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	type BashTool,
	bashTimeoutSeconds,
	boundedCodingTools,
	createBoundedBashTool,
} from "../src/agent-host/bash-tool.ts";
import { classifyToolFailure } from "../src/agent-host/tool-telemetry.ts";

/** The bounded registration the host installs, for a test that drives it. */
function boundedBash(options: Parameters<typeof boundedCodingTools>[0] = {}) {
	const tool = (boundedCodingTools(options).tools ?? []).find(
		(item) => item.name === "bash",
	);
	if (!tool) throw new Error("bounded bash tool not found");
	return tool;
}

/** A fake environment that records the options each command ran with and
 * answers either a successful exit or the environment's own `timeout`. */
function fakeEnv(options: {
	readonly output?: string;
	readonly exitCode?: number;
	readonly timeoutSeconds?: number;
	readonly delayMs?: number;
}) {
	const calls: Array<Record<string, unknown>> = [];
	const env = {
		cwd: "/work",
		exec: async (
			_command: string,
			execOptions?: {
				readonly onOutput?: (text: string) => void;
			},
		) => {
			calls.push((execOptions ?? {}) as Record<string, unknown>);
			if (options.delayMs) await Bun.sleep(options.delayMs);
			execOptions?.onOutput?.(options.output ?? "");
			if (options.timeoutSeconds !== undefined)
				return { ok: false, error: { code: "timeout" } };
			return { ok: true, value: { exitCode: options.exitCode ?? 0 } };
		},
	};
	return { calls, env };
}

/** Run the tool the way the harness does, collecting what the model would see
 * as the result content and what the call failed with. */
async function callBash(
	// The registration as this package installs it: `boundedCodingTools` returns
	// extensions whose tools are typed by their schema parameter, and the harness
	// only needs the executable surface here.
	tool: ToolRegistration,
	args: Record<string, unknown>,
	env: unknown,
	context: unknown = undefined,
): Promise<{ text: string; error?: Error }> {
	const chunks: string[] = [];
	const api = {
		conversationId: 1,
		callId: "call-1",
		env,
		output: (chunk: string | Uint8Array) => {
			chunks.push(
				typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
			);
		},
		diagnostic: () => {},
		details: async () => {},
	};
	try {
		await tool.execute(args as never, api as never, context as never);
		return { text: chunks.join("") };
	} catch (error) {
		return { text: chunks.join(""), error: error as Error };
	}
}

describe("bash timeout bound", () => {
	test("no timeout means the default, a caller's timeout wins, and the ceiling caps it", () => {
		expect(bashTimeoutSeconds(undefined)).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(bashTimeoutSeconds(30)).toBe(30);
		expect(bashTimeoutSeconds(BASH_MAX_TIMEOUT_SECONDS * 2)).toBe(
			BASH_MAX_TIMEOUT_SECONDS,
		);
		// An invalid value is handed to pi-durable's own validation unchanged, so
		// its message — not a second one invented here — reaches the model.
		expect(bashTimeoutSeconds(0)).toBe(0);
		expect(Number.isNaN(bashTimeoutSeconds(Number.NaN))).toBe(true);
	});

	test("a call without a timeout runs under the default and reports the bound", async () => {
		const { env, calls } = fakeEnv({ timeoutSeconds: 1, output: "50 bytes\n" });
		const result = await callBash(
			boundedBash(),
			{ command: "find / -name '*.ts'" },
			env,
		);
		expect(calls[0]?.timeout).toBe(BASH_DEFAULT_TIMEOUT_SECONDS);
		expect(result.error?.message).toContain("timed out after 120 s");
		expect(result.text).toContain("50 bytes");
		expect(result.text).toContain("timed out after 120 s");
		expect(result.text).toContain("env_build/env_test");
		expect(result.text).toContain("-maxdepth");
	});

	test("an explicit timeout overrides the default and a larger one is capped", async () => {
		const overridden = fakeEnv({ timeoutSeconds: 1 });
		await callBash(
			boundedBash(),
			{ command: "sleep 30", timeout: 7 },
			overridden.env,
		);
		expect(overridden.calls[0]?.timeout).toBe(7);

		const capped = fakeEnv({ timeoutSeconds: 1 });
		await callBash(
			boundedBash(),
			{ command: "docker build .", timeout: 86_400 },
			capped.env,
		);
		expect(capped.calls[0]?.timeout).toBe(BASH_MAX_TIMEOUT_SECONDS);
	});

	test("a stopped call reads as a timeout failure to the tool-result vocabulary", async () => {
		const { env } = fakeEnv({ timeoutSeconds: 1 });
		const result = await callBash(
			boundedBash(),
			{ command: "grep -rl x /" },
			env,
		);
		const kind = classifyToolFailure({
			model: [
				{
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: result.text }],
				},
			],
			data: {
				diagnostics: [
					{ code: "tool_error", message: result.error?.message ?? "" },
				],
			},
		});
		expect(kind).toBe("timeout");
	});

	test("a call that ran past the note ends with the elapsed time it ran", async () => {
		const { env } = fakeEnv({ output: "done\n", delayMs: 150 });
		const result = await callBash(
			boundedBash({ elapsedNoteSeconds: 0.05 }),
			{ command: "bun run type-check" },
			env,
		);
		expect(result.error).toBeUndefined();
		expect(result.text).toContain("done");
		expect(result.text).toContain("this call ran");
	});

	test("a short call carries no note", async () => {
		const { env } = fakeEnv({ output: "done\n" });
		const result = await callBash(
			boundedBash({ elapsedNoteSeconds: 0.05 }),
			{ command: "git status --short" },
			env,
		);
		expect(result.text).toBe("done\n");
	});
});

describe("bounded coding tools", () => {
	test("replaces pi-durable's bash and keeps the other coding tools", () => {
		const extension = boundedCodingTools();
		expect((extension.tools ?? []).map((tool) => tool.name)).toEqual([
			"read",
			"write",
			"edit",
			"bash",
		]);
		const description = (extension.tools ?? []).find(
			(tool) => tool.name === "bash",
		)?.description;
		expect(description).toContain("stopped after 120 s");
		expect(description).toContain("timeout");
		const upstream = (CodingTools.tools ?? []).find(
			(tool) => tool.name === "bash",
		)?.description;
		expect(upstream).not.toContain("stopped after 120 s");
	});

	test("keeps pi-durable's normal result and exit-code handling", async () => {
		const ok = await callBash(
			boundedBash(),
			{ command: "git status --short" },
			fakeEnv({ output: " M src/a.ts\n" }).env,
		);
		expect(ok.error).toBeUndefined();
		expect(ok.text).toBe(" M src/a.ts\n");

		const failed = await callBash(
			boundedBash(),
			{ command: "false" },
			fakeEnv({ exitCode: 2 }).env,
		);
		expect(failed.error?.message).toContain("exited with code 2");
	});
});

describe("a stopped command takes its children with it", () => {
	test("the shell and the process it started are gone after the bound fires", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-bound-"));
		const pidFile = path.join(dir, "child.pid");
		try {
			const env = new NodeExecutionEnv({
				cwd: dir,
				shellEnv: { ...process.env },
			});
			// Test-only bound: the command below sleeps far longer than the suite
			// would ever wait, so the assertion is about the kill, not the sleep.
			const tool = createBoundedBashTool(
				(CodingTools.tools ?? []).find(
					(item) => item.name === "bash",
				) as BashTool,
				{ defaultTimeoutSeconds: 1 },
			);
			const result = await callBash(
				tool,
				{ command: `sleep 30 & echo $! > ${pidFile}; wait` },
				env,
				BACKGROUND_CONTEXT,
			);
			expect(result.error?.message).toContain("timed out after 1 s");
			expect(result.text).toContain("stopped");
			const child = Number(fs.readFileSync(pidFile, "utf8").trim());
			expect(child).toBeGreaterThan(0);
			expect(() => process.kill(child, 0)).toThrow();
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

import { expect, test } from "bun:test";
import { readActionProgress } from "../src/agent-host/action-progress.ts";
import {
	boundedToolLog,
	toolViewDetails,
} from "../src/agent-host/tool-view-details.ts";
import { actionProgressResponse } from "../src/server/environment/action-progress-stream.ts";
import { redact, redactProgress } from "../src/server/environment/secrets.ts";

test("action output is observable before completion and final output is not duplicated", async () => {
	let complete: ((value: unknown) => void) | undefined;
	const response = actionProgressResponse(
		async (publish) => {
			publish({ output: "first" });
			return new Promise((resolve) => {
				complete = resolve;
			});
		},
		(value) => value,
		(error) => ({ code: "failed", message: String(error) }),
	);
	const progress: unknown[] = [];
	let sawProgress: (() => void) | undefined;
	const observed = new Promise<void>((resolve) => {
		sawProgress = resolve;
	});
	const result = readActionProgress(response, async (value) => {
		progress.push(value);
		sawProgress?.();
	});
	await observed;
	expect(progress).toEqual([{ output: "first" }]);
	complete?.({ output: "first\nlast", exitCode: 0 });
	await expect(result).resolves.toEqual({ output: "first\nlast", exitCode: 0 });
});

test("slow progress consumers retain the latest snapshot and terminal result", async () => {
	const response = actionProgressResponse(
		async (publish) => {
			for (let i = 0; i < 10_000; i++) publish({ output: String(i) });
			return { output: "complete", truncated: false };
		},
		(value) => value,
		() => ({ code: "failed", message: "failed" }),
	);
	await Promise.resolve();
	const text = await response.text();
	const frames = text.trim().split("\n");
	expect(frames.length).toBeLessThanOrEqual(3);
	expect(JSON.parse(frames.at(-1) ?? "null")).toEqual({
		type: "result",
		value: { output: "complete", truncated: false },
	});
});

test("cancelling the response aborts the action", async () => {
	let signal: AbortSignal | undefined;
	const response = actionProgressResponse(
		async (_publish, actionSignal) => {
			signal = actionSignal;
			await new Promise<void>((resolve) =>
				actionSignal.addEventListener("abort", () => resolve(), { once: true }),
			);
		},
		(value) => value,
		() => ({ code: "failed", message: "failed" }),
	);
	await response.body?.cancel();
	expect(signal?.aborted).toBe(true);
});

test("stream parsing preserves split UTF-8 and rejects early disconnects and malformed frames", async () => {
	const bytes = new TextEncoder().encode(
		'{"type":"progress","value":{"output":"héllo"}}\n{"type":"result","value":{"status":"passed"}}\n',
	);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	});
	const progress: unknown[] = [];
	await expect(
		readActionProgress(new Response(stream), async (value) => {
			progress.push(value);
		}),
	).resolves.toEqual({ status: "passed" });
	expect(progress).toEqual([{ output: "héllo" }]);
	await expect(
		readActionProgress(
			new Response('{"type":"progress","value":{}}\n'),
			async () => {},
		),
	).rejects.toThrow("before its result");
	await expect(
		readActionProgress(new Response('{"type":"mystery"}\n'), async () => {}),
	).rejects.toThrow("Invalid action stream");
	await expect(
		readActionProgress(
			new Response(
				'{"type":"error","error":{"code":"conflict","message":"busy"}}\n',
			),
			async () => {},
		),
	).rejects.toThrow("conflict: busy");
});

test("stream redaction never publishes a partial secret across chunks or overlapping values", () => {
	const secrets = [{ name: "PASSWORD", value: "private-password" }];
	expect(redactProgress("output private-pass", secrets)).toBe("output ");
	expect(redactProgress("output private-password\nnext", secrets)).toBe(
		"output «redacted:PASSWORD»\nnext",
	);
	expect(
		redactProgress("ABCD", [
			{ name: "ONE", value: "ABCD" },
			{ name: "TWO", value: "CDXYZ" },
		]),
	).toBe("");
	expect(redact("private-password", secrets)).toBe("«redacted:PASSWORD»");
});

test("structured UI details respect the model result's bound", () => {
	expect(toolViewDetails({ answer: 42 }, 100)).toEqual({
		view: { answer: 42 },
	});
	expect(toolViewDetails({ output: "x".repeat(200) }, 100)).toBeUndefined();
	expect(toolViewDetails("plain output", 100)).toBeUndefined();
});

test("large action logs stay valid JSON with their metadata and truncation diagnostic", () => {
	const value = boundedToolLog(
		{
			output: '\n"界'.repeat(100),
			exitCode: 1,
			status: "failed",
			targetId: "unit",
		},
		200,
	);
	expect(JSON.stringify(value).length).toBeLessThanOrEqual(200);
	expect(value).toMatchObject({
		exitCode: 1,
		status: "failed",
		targetId: "unit",
		truncated: true,
	});
	expect(toolViewDetails(value, 200)).toBeDefined();
});

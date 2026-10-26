// pi-durable-codemode-parity: the durable `codemode` tool. It is offered only
// when the user's global pi settings enable it, it is an additional tool (the
// run keeps its direct tools), and a script can reach only the tools the run
// was offered — so a read-only run cannot reach `write` through a script.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import {
	CodemodeSandbox,
	CodemodeSandboxBase,
} from "@earendil-works/pi-codemode";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { captureSystem } from "../scripts/prompt-inventory-system.ts";
import {
	CODEMODE_DEFAULT_TIMEOUT_MS,
	CODEMODE_TOOL_NAME,
	createDurableCodemode,
	valueToText,
} from "../src/agent-host/codemode.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { buildAgentSessionView } from "../src/tui/dash/agent-session.ts";
import { CODEMODE_SECTION_BUDGET } from "../src/workflow/prompt-inventory.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});

function tempWorkflowDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-host-codemode-"));
	roots.push(dir);
	return dir;
}

function writeRunEnv(dir: string, vars: Record<string, string>): string {
	const file = path.join(dir, "run.env");
	fs.writeFileSync(
		file,
		Object.entries(vars)
			.map(([k, v]) => `${k}='${v}'`)
			.join("\n"),
	);
	return file;
}

/** A settings file that enables codemode the way a user's global pi settings do. */
function enableCodemode(dir: string): void {
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		// pi's `+name` adds to the default selection; a plain name would replace it.
		JSON.stringify({ defaultTools: ["+codemode"] }),
	);
}

interface ToolResultRecord {
	readonly kind: string;
	readonly model?: ReadonlyArray<{
		readonly toolName?: string;
		readonly isError?: boolean;
		readonly details?: unknown;
		readonly content?: ReadonlyArray<{
			readonly type?: string;
			readonly text?: string;
		}>;
	}>;
}

function toolResultText(entries: readonly unknown[], toolName: string): string {
	const record = entries.find((entry) => {
		const item = entry as ToolResultRecord;
		return (
			item.kind === "pi.tool-result" && item.model?.[0]?.toolName === toolName
		);
	}) as ToolResultRecord | undefined;
	return (
		record?.model?.[0]?.content
			?.flatMap((part) =>
				part.type === "text" && typeof part.text === "string"
					? [part.text]
					: [],
			)
			.join("\n") ?? ""
	);
}

function lastToolResultText(
	entries: readonly unknown[],
	toolName: string,
): string {
	const record = [...entries].reverse().find((entry) => {
		const item = entry as ToolResultRecord;
		return (
			item.kind === "pi.tool-result" && item.model?.[0]?.toolName === toolName
		);
	}) as ToolResultRecord | undefined;
	return (
		record?.model?.[0]?.content
			?.flatMap((part) =>
				part.type === "text" && typeof part.text === "string"
					? [part.text]
					: [],
			)
			.join("\n") ?? ""
	);
}

function toolResultFailed(
	entries: readonly unknown[],
	toolName: string,
): boolean {
	const record = entries.find((entry) => {
		const item = entry as ToolResultRecord;
		return (
			item.kind === "pi.tool-result" && item.model?.[0]?.toolName === toolName
		);
	}) as ToolResultRecord | undefined;
	return record?.model?.[0]?.isError === true;
}

async function openHost(dir: string, storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage,
		models,
	});
	return { host, faux };
}

async function settle(host: DurableHost, runId: string): Promise<void> {
	let status = await host.status(runId);
	for (let i = 0; i < 100 && status.status !== "idle"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		status = await host.status(runId);
	}
}

test("structured nested output conversion stops at its size and work budgets", () => {
	const large = "x".repeat(20_000);
	let itemsRead = 0;
	const items = new Proxy(Array(100_000).fill({ payload: large }), {
		get(target, property, receiver) {
			if (typeof property === "string" && Number.isInteger(Number(property)))
				itemsRead += 1;
			return Reflect.get(target, property, receiver);
		},
	});
	const text = valueToText({ items });
	expect(text.length).toBeLessThanOrEqual(4_000);
	expect(text).toContain("truncated");
	expect(itemsRead).toBeLessThan(40);
});

test("a durable run runs a codemode script that calls its own tools", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	fs.writeFileSync(path.join(dir, "note.txt"), "hello codemode");
	const { host, faux } = await openHost(dir);
	const runEnvPath = writeRunEnv(dir, {});
	await host.ensureRun({
		runId: "run-1",
		name: "worker-1",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: '// @options: {"max_output_tokens": 64}\nstore("codemode-test", "saved across calls"); const content = await tools.read({ path: "note.txt" }); text(content); text("x".repeat(100_000)); return load("codemode-test");',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-1", "use codemode", "req-1");
	faux.appendResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'return load("codemode-test");',
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'store("codemode-rollback", "uncommitted"); throw new Error("intentional store failure");',
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'return load("codemode-rollback") === undefined ? "rollback absent" : "rollback leaked";',
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await settle(host, "run-1");

	await host.ensureRun({
		runId: "run-isolated",
		name: "worker-isolated",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'return load("codemode-test") === undefined ? "isolated" : "leaked";',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit(
		"run-isolated",
		"read isolated codemode state",
		"req-isolated",
	);
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-isolated");
	const isolatedEntries = await host.entriesForTest("run-isolated");
	expect(toolResultText(isolatedEntries, CODEMODE_TOOL_NAME)).toContain(
		"isolated",
	);

	const entries = await host.entriesForTest("run-1");
	const transcript = JSON.stringify(entries);
	const result = toolResultText(entries, CODEMODE_TOOL_NAME);
	expect(result).toContain("Script completed");
	expect(result).toContain("hello codemode");
	expect(result.match(/hello codemode/g)).toHaveLength(1);
	expect(result).toContain("saved across calls");
	expect(result.length).toBeLessThan(2_000);
	expect(transcript).toContain("fullOutputPath");
	expect(transcript).toContain("intentional store failure");
	expect(transcript).toContain("rollback absent");
	expect(toolResultFailed(entries, "codemode")).toBe(false);
	// The result also carries the calls as structured details, arguments
	// included: the sandbox records only names, so the host adds what each call
	// asked for (the dashboard's codemode view reads these).
	const details = (
		entries.find((entry) => {
			const item = entry as ToolResultRecord;
			return (
				item.kind === "pi.tool-result" &&
				item.model?.[0]?.toolName === "codemode"
			);
		}) as ToolResultRecord | undefined
	)?.model?.[0]?.details as { calls?: unknown } | undefined;
	expect(details?.calls).toEqual([
		{
			id: 1,
			name: "read",
			status: "ok",
			durationMs: expect.any(Number),
			args: { path: "note.txt" },
			// What the call returned travels with it, so the dashboard can show a
			// script's calls as the tool rows they are.
			output: "hello codemode",
			isError: false,
		},
	]);
	await host.shutdown();
});

test("nested codemode failures are captured as failed calls", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "run-nested-failure",
			name: "worker-nested-failure",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: 'return await tools.read({ path: "missing-codemode-input.txt" });',
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await host.submit("run-nested-failure", "try a missing file", "req-fail");
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await settle(host, "run-nested-failure");

		const result = (await host.entriesForTest("run-nested-failure")).find(
			(entry) => {
				const item = entry as ToolResultRecord;
				return (
					item.kind === "pi.tool-result" &&
					item.model?.[0]?.toolName === CODEMODE_TOOL_NAME
				);
			},
		) as ToolResultRecord | undefined;
		const details = result?.model?.[0]?.details as
			| { calls?: Array<Record<string, unknown>> }
			| undefined;
		expect(details?.calls?.[0]).toMatchObject({
			name: "read",
			status: "error",
			isError: true,
		});
		expect(result?.model?.[0]?.isError).toBe(true);
		const output = toolResultText(
			await host.entriesForTest("run-nested-failure"),
			CODEMODE_TOOL_NAME,
		);
		expect(output).toContain("Script failed");
		expect(output).not.toContain("Script completed");
	} finally {
		await host.shutdown();
	}
});

test("nested codemode detail history is bounded and reports omitted calls", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	fs.writeFileSync(path.join(dir, "small.txt"), "ok");
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "run-call-limit",
			name: "worker-call-limit",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: 'for (let i = 0; i < 55; i++) await tools.read({ path: "small.txt" }); return "done";',
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		await host.submit("run-call-limit", "make many reads", "req-many");
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await settle(host, "run-call-limit");

		const result = (await host.entriesForTest("run-call-limit")).find(
			(entry) => {
				const item = entry as ToolResultRecord;
				return (
					item.kind === "pi.tool-result" &&
					item.model?.[0]?.toolName === CODEMODE_TOOL_NAME
				);
			},
		) as ToolResultRecord | undefined;
		const details = result?.model?.[0]?.details as
			| { calls?: unknown[]; omittedCalls?: number }
			| undefined;
		expect(details?.calls).toHaveLength(50);
		expect(details?.omittedCalls).toBe(5);
	} finally {
		await host.shutdown();
	}
});

test("nested codemode arguments, output, and details are bounded", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	fs.writeFileSync(path.join(dir, "note.txt"), "old line\n");
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "run-large-calls",
			name: "worker-large-calls",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		const large = "x".repeat(12_000);
		const code = `await tools.write({ path: "large.txt", content: ${JSON.stringify(large)} }); await tools.read({ path: "large.txt" }); await tools.edit({ path: "note.txt", edits: [{ oldText: "old line", newText: ${JSON.stringify(large)} }] }); return "done";`;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(CODEMODE_TOOL_NAME, { code })], {
				stopReason: "toolUse",
			}),
		]);
		await host.submit(
			"run-large-calls",
			"record large nested calls",
			"req-large",
		);
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await settle(host, "run-large-calls");

		const entries = await host.entriesForTest("run-large-calls");
		const result = entries.find((entry) => {
			const item = entry as ToolResultRecord;
			return (
				item.kind === "pi.tool-result" &&
				item.model?.[0]?.toolName === CODEMODE_TOOL_NAME
			);
		}) as ToolResultRecord | undefined;
		const details = result?.model?.[0]?.details as
			| { calls?: Array<Record<string, unknown>> }
			| undefined;
		const calls = details?.calls ?? [];
		expect(calls).toHaveLength(3);
		const writeArgs = calls[0]?.args as Record<string, unknown> | undefined;
		expect(typeof writeArgs?.content).toBe("string");
		expect(String(writeArgs?.content).length).toBeLessThanOrEqual(4_000);
		expect(String(writeArgs?.content)).toContain("…[truncated]");
		expect(typeof calls[1]?.output).toBe("string");
		expect(String(calls[1]?.output).length).toBeLessThanOrEqual(4_000);
		expect(String(calls[1]?.output)).toContain("output omitted");
		expect(String(calls[2]?.output).length).toBeLessThanOrEqual(4_000);
		const editDetails = calls[2]?.details as { diff?: unknown } | undefined;
		expect(typeof editDetails?.diff).toBe("string");
		expect(String(editDetails?.diff).length).toBeLessThanOrEqual(4_000);
		expect(String(editDetails?.diff)).toContain("…[truncated]");
	} finally {
		await host.shutdown();
	}
});

test("native codemode uses its default timeout and preserves an explicit override", async () => {
	const originalStart = CodemodeSandbox.prototype.start;
	const timeouts: number[] = [];
	CodemodeSandbox.prototype.start = function (code, options) {
		if (typeof options?.timeoutMs === "number")
			timeouts.push(options.timeoutMs);
		return originalStart.call(this, code, options);
	};
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	let host: DurableHost | undefined;
	try {
		const opened = await openHost(dir);
		host = opened.host;
		const { faux } = opened;
		await host.ensureRun({
			runId: "run-timeout",
			name: "worker-timeout",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		for (const [index, code] of [
			'return "default timeout";',
			'// @options: {"timeout_ms": 3000}\nreturn "override";',
		].entries()) {
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall(CODEMODE_TOOL_NAME, { code })], {
					stopReason: "toolUse",
				}),
			]);
			await host.submit("run-timeout", `timeout case ${index}`, `req-${index}`);
			faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
			await settle(host, "run-timeout");
		}
		expect(timeouts[0]).toBe(CODEMODE_DEFAULT_TIMEOUT_MS);
		const override = timeouts[1];
		if (override === undefined) throw new Error("Missing override start");
		expect(override).toBeGreaterThan(0);
		expect(override).toBeLessThanOrEqual(3_000);
	} finally {
		CodemodeSandbox.prototype.start = originalStart;
		await host?.shutdown();
	}
});

test("native codemode store survives reopening durable file storage", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const runEnvPath = writeRunEnv(dir, {});
	const run = {
		runId: "run-restart",
		name: "worker-restart",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default" as const,
	};
	const storagePath = hostLayout(dir).storagePath;
	fs.writeFileSync(
		path.join(dir, "restart.txt"),
		"nested result survives restart",
	);
	const first = await openHost(dir, await openNodeSqliteStorage(storagePath));
	const firstRun = await first.host.ensureRun({
		...run,
		model: `${first.faux.getModel().provider}/${first.faux.getModel().id}`,
	});
	first.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'const output = await tools.read({ path: "restart.txt" }); store("restart-state", "stored across restart"); return output;',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await first.host.submit(
		run.runId,
		"store restart state",
		"req-restart-store",
	);
	first.faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(first.host, run.runId);
	await first.host.shutdown();

	const reopened = await openHost(
		dir,
		await openNodeSqliteStorage(storagePath),
	);
	const reopenedRun = await reopened.host.ensureRun({
		...run,
		model: `${reopened.faux.getModel().provider}/${reopened.faux.getModel().id}`,
	});
	expect(reopenedRun.conversationId).toBe(firstRun.conversationId);
	const recoveredEntries = await reopened.host.entriesForTest(run.runId);
	const firstCodemode = recoveredEntries.find((entry) => {
		const item = entry as ToolResultRecord;
		return (
			item.kind === "pi.tool-result" &&
			item.model?.[0]?.toolName === CODEMODE_TOOL_NAME
		);
	}) as ToolResultRecord | undefined;
	const recoveredDetails = firstCodemode?.model?.[0]?.details as
		| { calls?: Array<{ name?: string; output?: string }> }
		| undefined;
	expect(recoveredDetails?.calls?.[0]?.name).toBe("read");
	expect(recoveredDetails?.calls?.[0]?.output).toContain(
		"nested result survives restart",
	);
	reopened.faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall(CODEMODE_TOOL_NAME, {
					code: 'return load("restart-state");',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await reopened.host.submit(
		run.runId,
		"load restart state",
		"req-restart-load",
	);
	reopened.faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(reopened.host, run.runId);
	expect(
		lastToolResultText(
			await reopened.host.entriesForTest(run.runId),
			CODEMODE_TOOL_NAME,
		),
	).toContain("stored across restart");
	await reopened.host.shutdown();
});

test("host recovery reports an interrupted nested call without replaying it", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const markerPath = path.join(dir, "nested-call-marker.txt");
	const runEnvPath = writeRunEnv(dir, {});
	const run = {
		runId: "run-interrupted-call",
		name: "worker-interrupted-call",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default" as const,
	};
	const storagePath = hostLayout(dir).storagePath;
	const first = await openHost(dir, await openNodeSqliteStorage(storagePath));
	const firstRun = await first.host.ensureRun({
		...run,
		model: `${first.faux.getModel().provider}/${first.faux.getModel().id}`,
	});
	const code = `await tools.bash({ command: ${JSON.stringify(
		`printf x >> "${markerPath}"; sleep 5; printf y >> "${markerPath}"`,
	)} }); return "after nested call";`;
	let nestedCallRunning = false;
	const stop = await first.host.watchRun(run.runId, (value) => {
		const block = buildAgentSessionView(value).find(
			(entry) => entry.pending && entry.toolCall?.name === CODEMODE_TOOL_NAME,
		);
		const calls = block?.toolCall?.progress?.calls;
		if (
			Array.isArray(calls) &&
			calls.some(
				(call) =>
					call !== null &&
					typeof call === "object" &&
					"name" in call &&
					call.name === "bash" &&
					"status" in call &&
					call.status === "running",
			)
		)
			nestedCallRunning = true;
	});
	try {
		first.faux.setResponses([
			fauxAssistantMessage([fauxToolCall(CODEMODE_TOOL_NAME, { code })], {
				stopReason: "toolUse",
			}),
		]);
		await first.host.submit(
			run.runId,
			"interrupt nested call",
			"req-interrupt",
		);
		for (let attempt = 0; attempt < 200 && !nestedCallRunning; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(nestedCallRunning).toBe(true);
		for (
			let attempt = 0;
			attempt < 500 && !fs.existsSync(markerPath);
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
	} finally {
		stop();
	}
	await first.host.shutdown();

	const recovered = await openHost(
		dir,
		await openNodeSqliteStorage(storagePath),
	);
	try {
		recovered.faux.setResponses([
			fauxAssistantMessage([fauxText("recovered")]),
		]);
		const recoveredRun = await recovered.host.ensureRun({
			...run,
			model: `${recovered.faux.getModel().provider}/${recovered.faux.getModel().id}`,
		});
		expect(recoveredRun.conversationId).toBe(firstRun.conversationId);
		await settle(recovered.host, run.runId);
		expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
		const entries = await recovered.host.entriesForTest(run.runId);
		const recoveredResult = entries.find((entry) => {
			const item = entry as ToolResultRecord;
			return (
				item.kind === "pi.tool-result" &&
				item.model?.[0]?.toolName === CODEMODE_TOOL_NAME
			);
		}) as ToolResultRecord | undefined;
		const recoveredDetails = recoveredResult?.model?.[0]?.details as
			| { calls?: Array<Record<string, unknown>> }
			| undefined;
		// Recovery reuses the committed native abort result. The nested call's
		// structured row is its last progress snapshot (still running); the outer
		// result is the authoritative terminal state and is visibly interrupted.
		expect(recoveredDetails?.calls?.[0]).toMatchObject({
			name: "bash",
			status: "running",
			isError: false,
		});
		expect(recoveredResult?.model?.[0]?.isError).toBe(true);
		const recoveredText = toolResultText(entries, CODEMODE_TOOL_NAME);
		expect(recoveredText).toContain("Tool codemode was aborted");
		expect(recoveredText).not.toContain("Script completed");
	} finally {
		await recovered.host.shutdown();
	}
});

test("codemode exposes live nested progress and propagates cancellation", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const { host, faux } = await openHost(dir);
	try {
		await host.ensureRun({
			runId: "stream",
			name: "stream",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		const live: Array<{ output: readonly string[]; calls: unknown }> = [];
		const stop = await host.watchRun("stream", (value) => {
			const block = buildAgentSessionView(value).find(
				(block) => block.pending && block.toolCall?.name === "codemode",
			);
			if (block)
				live.push({
					output: block.detail ?? [],
					calls: block.toolCall?.progress?.calls,
				});
		});
		try {
			faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("codemode", {
							code: 'text("script before"); await tools.bash({ command: "printf nested-progress; sleep 5" }); text("script after"); return "done";',
						}),
					],
					{ stopReason: "toolUse" },
				),
			]);
			await host.submit("stream", "stream codemode", "stream-request");
			faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
			for (let attempt = 0; attempt < 100; attempt++) {
				if (
					live.some(
						(frame) =>
							Array.isArray(frame.calls) &&
							frame.calls.some(
								(call) => call.name === "bash" && call.status === "running",
							),
					)
				)
					break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await host.abort("stream");
			await settle(host, "stream");
			// Native start-based execution publishes script output after completion,
			// while the host adapter keeps nested-call status live.
			expect(
				live.some(
					(frame) =>
						Array.isArray(frame.calls) &&
						frame.calls.some(
							(call) => call.name === "bash" && call.status === "running",
						),
				),
			).toBe(true);
			const entries = await host.entriesForTest("stream");
			const result = toolResultText(entries, "codemode");
			expect(result).toContain("Tool codemode was aborted");
			expect(result).not.toContain("script after");
		} finally {
			stop();
		}
	} finally {
		await host.shutdown();
	}
});

test("host shutdown interrupts and drains an active nested call", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const markerPath = path.join(dir, "shutdown-marker.txt");
	const { host, faux } = await openHost(dir);
	let stop: (() => void) | undefined;
	let shutdown = false;
	try {
		await host.ensureRun({
			runId: "run-shutdown-interrupt",
			name: "worker-shutdown-interrupt",
			cwd: dir,
			runEnvPath: writeRunEnv(dir, {}),
			toolPolicy: "default",
			model: `${faux.getModel().provider}/${faux.getModel().id}`,
		});
		let nestedCallRunning = false;
		stop = await host.watchRun("run-shutdown-interrupt", (value) => {
			const blocks = buildAgentSessionView(value);
			nestedCallRunning ||= blocks.some(
				(block) =>
					block.pending &&
					block.toolCall?.name === "codemode" &&
					Array.isArray(block.toolCall.progress?.calls) &&
					block.toolCall.progress.calls.some(
						(call) => call.name === "bash" && call.status === "running",
					),
			);
		});
		const command = `printf x >> "${markerPath}"; sleep 0.5; printf y >> "${markerPath}"`;
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(CODEMODE_TOOL_NAME, {
						code: `await tools.bash({ command: ${JSON.stringify(command)} }); return "post-call";`,
					}),
				],
				{ stopReason: "toolUse" },
			),
		]);
		faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
		await host.submit(
			"run-shutdown-interrupt",
			"start shutdown probe",
			"req-shutdown",
		);
		for (let attempt = 0; attempt < 500 && !nestedCallRunning; attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(nestedCallRunning).toBe(true);
		for (
			let attempt = 0;
			attempt < 500 && !fs.existsSync(markerPath);
			attempt++
		)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
		stop();
		stop = undefined;
		await host.shutdown();
		shutdown = true;
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(fs.readFileSync(markerPath, "utf8")).toBe("x");
	} finally {
		stop?.();
		if (!shutdown) await host.shutdown();
	}
}, 15_000);

test("a nested edit keeps its diff in the call's structured details", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	fs.writeFileSync(path.join(dir, "note.txt"), "old line\n");
	const { host, faux } = await openHost(dir);
	const runEnvPath = writeRunEnv(dir, {});
	await host.ensureRun({
		runId: "run-edit",
		name: "worker-edit",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: 'return await tools.edit({ path: "note.txt", edits: [{ oldText: "old line", newText: "new line" }] });',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-edit", "edit via codemode", "req-edit");
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-edit");

	const entries = await host.entriesForTest("run-edit");
	const details = (
		entries.find((entry) => {
			const item = entry as ToolResultRecord;
			return (
				item.kind === "pi.tool-result" &&
				item.model?.[0]?.toolName === "codemode"
			);
		}) as ToolResultRecord | undefined
	)?.model?.[0]?.details as
		| { calls?: Array<{ name?: string; details?: { diff?: string } }> }
		| undefined;
	// edit reports its diff through the tool result's own `details`, not the
	// nested `api.details` hook, so the host must capture both for the
	// dashboard's codemode view to fold the call open.
	expect(details?.calls?.[0]?.name).toBe("edit");
	expect(details?.calls?.[0]?.details?.diff).toContain("+1 new line");
	await host.shutdown();
});

test("a durable run's codemode sandbox offers the stage and browser tools", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const { host, faux } = await openHost(dir);
	const runEnvPath = writeRunEnv(dir, {});
	// A read-only run: the stage read and the browser tools act on the app slot, so
	// a verifier has them too — and the sandbox has to say so.
	await host.ensureRun({
		runId: "run-tools",
		name: "verifier-tools",
		cwd: dir,
		runEnvPath,
		toolPolicy: "read-only",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: "return ALL_TOOLS;",
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-tools", "what can you call", "req-tools");
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-tools");

	const result = toolResultText(
		await host.entriesForTest("run-tools"),
		CODEMODE_TOOL_NAME,
	);
	// The native catalog reflects the tools the read-only run was offered.
	expect(result).toContain("stage_info");
	expect(result).toContain("browser_open");
	expect(result).not.toContain('"write"');
	expect(result).not.toContain('"edit"');
	await host.shutdown();
});

test("a read-only run cannot reach write through a codemode script", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const { host, faux } = await openHost(dir);
	const runEnvPath = writeRunEnv(dir, {});
	await host.ensureRun({
		runId: "run-ro",
		name: "verifier-1",
		cwd: dir,
		runEnvPath,
		toolPolicy: "read-only",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("codemode", {
					code: 'return await tools.write({ path: "escaped.txt", content: "no" });',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-ro", "try to write", "req-ro");
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-ro");

	const entries = await host.entriesForTest("run-ro");
	expect(toolResultFailed(entries, "codemode")).toBe(true);
	expect(toolResultText(entries, "codemode")).toContain("Script failed");
	expect(fs.existsSync(path.join(dir, "escaped.txt"))).toBe(false);
	await host.shutdown();
});

test("codemode is not offered when the global pi settings do not enable it", async () => {
	const dir = tempWorkflowDir();
	// No settings.json: nothing is enabled globally.
	const { host, faux } = await openHost(dir);
	const runEnvPath = writeRunEnv(dir, {});
	await host.ensureRun({
		runId: "run-off",
		name: "worker-off",
		cwd: dir,
		runEnvPath,
		toolPolicy: "default",
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	});
	faux.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("codemode", { code: 'return "never";' })],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-off", "use codemode", "req-off");
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-off");

	const entries = await host.entriesForTest("run-off");
	expect(toolResultFailed(entries, "codemode")).toBe(true);
	expect(toolResultText(entries, "codemode").toLowerCase()).toContain(
		"not available",
	);
	await host.shutdown();
});

// slim-agent-prompts: the system-prompt section lists each tool with only the
// first sentence of its description; the full text stays in the tool definition.
test("shutdown fences new runs and drains an ensureRun already in flight", async () => {
	const dir = tempWorkflowDir();
	const { host, faux } = await openHost(dir);
	const internals = host as unknown as {
		harness: {
			snapshot: (...args: unknown[]) => Promise<unknown>;
		};
	};
	const originalSnapshot = internals.harness.snapshot.bind(internals.harness);
	let releaseSnapshot: () => void = () => {};
	let markEntered: () => void = () => {};
	const snapshotGate = new Promise<void>((resolve) => {
		releaseSnapshot = resolve;
	});
	const snapshotEntered = new Promise<void>((resolve) => {
		markEntered = resolve;
	});
	let blocked = false;
	internals.harness.snapshot = async (...args: unknown[]) => {
		if (!blocked) {
			blocked = true;
			markEntered();
			await snapshotGate;
		}
		return originalSnapshot(...args);
	};
	const input = {
		runId: "run-shutdown-fence",
		name: "worker-shutdown-fence",
		cwd: dir,
		runEnvPath: writeRunEnv(dir, {}),
		toolPolicy: "default" as const,
		model: `${faux.getModel().provider}/${faux.getModel().id}`,
	};
	try {
		const ensuring = host.ensureRun(input);
		await snapshotEntered;
		let shutdownComplete = false;
		const shuttingDown = host.shutdown().then(() => {
			shutdownComplete = true;
		});
		await expect(
			host.ensureRun({ ...input, runId: "late-run" }),
		).rejects.toThrow("shutting down");
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(shutdownComplete).toBe(false);
		releaseSnapshot();
		await ensuring;
		await shuttingDown;
		expect(shutdownComplete).toBe(true);
	} finally {
		releaseSnapshot();
		await host.shutdown();
	}
});

test("shutdown closes the codemode sandbox and cleans files after harness close fails", async () => {
	const dir = tempWorkflowDir();
	enableCodemode(dir);
	const layout = hostLayout(dir);
	const { host } = await openHost(dir);
	await host.listen();
	const internals = host as unknown as {
		harness: {
			close: (context: typeof BACKGROUND_CONTEXT) => Promise<void>;
		};
	};
	const originalHarnessClose = internals.harness.close.bind(internals.harness);
	const originalSandboxClose = CodemodeSandboxBase.prototype.close;
	let sandboxClosed = false;
	CodemodeSandboxBase.prototype.close = async function () {
		sandboxClosed = true;
		return originalSandboxClose.call(this);
	};
	internals.harness.close = async (context) => {
		await originalHarnessClose(context);
		throw new Error("injected harness shutdown failure");
	};
	try {
		await expect(host.shutdown()).rejects.toThrow(
			"injected harness shutdown failure",
		);
		expect(sandboxClosed).toBe(true);
		expect(fs.existsSync(layout.socketPath)).toBe(false);
		expect(fs.existsSync(layout.lockPath)).toBe(false);
	} finally {
		CodemodeSandboxBase.prototype.close = originalSandboxClose;
		await host.shutdown().catch(() => {});
	}
});

describe("native codemode prompt section", () => {
	test("the native extension is constructed with bounded prompt declarations", () => {
		expect(createDurableCodemode().tool.description).toContain(
			"await searchTools",
		);
	});

	test("the native workflow tool catalog stays within the section budget", async () => {
		const scratch = tempWorkflowDir();
		const { sections } = await captureSystem(scratch);
		const section = String(sections.codemode ?? "");
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(
			CODEMODE_SECTION_BUDGET,
		);
		// The calling convention and the keep-direct rule survive, once.
		expect(section).toContain("Tools scripts can call");
		expect(String(createDurableCodemode().tool.description)).toContain(
			"Emit every independent call",
		);
	});

	test("a read-only run lists neither edit nor write", async () => {
		const dir = tempWorkflowDir();
		enableCodemode(dir);
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		try {
			let system: { sections?: Record<string, unknown> } | undefined;
			faux.setResponses([
				(context: {
					messages: Array<{ role: string; sections?: Record<string, unknown> }>;
				}) => {
					system = context.messages.find((m) => m.role === "system");
					return fauxAssistantMessage([fauxText("ok")]);
				},
			]);
			await host.ensureRun({
				runId: "read-only",
				name: "read-only",
				cwd: dir,
				runEnvPath: writeRunEnv(dir, { HERDR_RUN_ID: "read-only" }),
				toolPolicy: "read-only",
				model: `${faux.getModel().provider}/${faux.getModel().id}`,
			});
			await host.submit("read-only", "hello", "req-1");
			for (let i = 0; i < 100; i++) {
				if ((await host.status("read-only")).status === "idle") break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const section = String(system?.sections?.codemode ?? "");
			expect(section).toContain("### `env_status`");
			expect(section).not.toContain("- tools.edit:");
			expect(section).not.toContain("- tools.write:");
		} finally {
			await host.shutdown();
		}
	});
});

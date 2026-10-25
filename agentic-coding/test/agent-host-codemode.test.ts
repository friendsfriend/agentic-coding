// pi-durable-codemode-parity: the durable `codemode` tool. It is offered only
// when the user's global pi settings enable it, it is an additional tool (the
// run keeps its direct tools), and a script can reach only the tools the run
// was offered — so a read-only run cannot reach `write` through a script.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { captureSystem } from "../scripts/prompt-inventory-system.ts";
import {
	CODEMODE_SECTION_DESCRIPTION_LIMIT,
	firstSentence,
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

async function openHost(dir: string) {
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
	return { host, faux };
}

async function settle(host: DurableHost, runId: string): Promise<void> {
	let status = await host.status(runId);
	for (let i = 0; i < 100 && status.status !== "idle"; i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
		status = await host.status(runId);
	}
}

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
					code: 'const content = await tools.read({ path: "note.txt" }); text(content); return "ok";',
				}),
			],
			{ stopReason: "toolUse" },
		),
	]);
	await host.submit("run-1", "use codemode", "req-1");
	faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
	await settle(host, "run-1");

	const entries = await host.entriesForTest("run-1");
	const result = toolResultText(entries, "codemode");
	expect(result).toContain("Script completed");
	expect(result).toContain("hello codemode");
	expect(result).toContain('return: "ok"');
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

test("codemode publishes script output and nested tool progress before completion", async () => {
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
							code: 'text("script before"); await tools.bash({ command: "printf nested-progress; sleep 0.4" }); text("script after"); return "done";',
						}),
					],
					{ stopReason: "toolUse" },
				),
			]);
			await host.submit("stream", "stream codemode", "stream-request");
			faux.appendResponses([fauxAssistantMessage([fauxText("done")])]);
			await settle(host, "stream");
			expect(
				live.some(
					(frame) =>
						frame.output.includes("script before") &&
						!frame.output.includes("script after"),
				),
			).toBe(true);
			expect(
				live.some(
					(frame) =>
						Array.isArray(frame.calls) &&
						frame.calls.some(
							(call) =>
								call.name === "bash" &&
								call.status === "running" &&
								call.output.includes("nested-progress"),
						),
				),
			).toBe(true);
			const result = toolResultText(
				await host.entriesForTest("stream"),
				"codemode",
			);
			expect(result).toContain("script before");
			expect(result).toContain("script after");
			expect(result.match(/script before/g)).toHaveLength(1);
		} finally {
			stop();
		}
	} finally {
		await host.shutdown();
	}
});

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
		"codemode",
	);
	// The script sees the tools the run was offered, stage read included.
	expect(result).toContain("stage_info");
	expect(result).toContain("browser_open");
	// And never what the run does not have.
	expect(result).not.toContain('"write"');
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
describe("compact codemode prompt section", () => {
	test("firstSentence cuts at the first sentence and at the character bound", () => {
		expect(firstSentence("Read a file. Output is truncated.")).toBe(
			"Read a file.",
		);
		expect(firstSentence("No full stop here")).toBe("No full stop here");
		expect(firstSentence("Line one\nstill one. Second.")).toBe(
			"Line one still one.",
		);
		const long = `${"word ".repeat(80)}end. More.`;
		const cut = firstSentence(long);
		expect(cut.length).toBeLessThanOrEqual(
			CODEMODE_SECTION_DESCRIPTION_LIMIT + 1,
		);
		expect(cut.endsWith("…")).toBe(true);
	});

	test("the full workflow tool set stays within the section budget, first sentences only", async () => {
		const scratch = tempWorkflowDir();
		const { sections, tools } = await captureSystem(scratch);
		const section = String(sections.codemode ?? "");
		expect(Buffer.byteLength(section)).toBeLessThanOrEqual(
			CODEMODE_SECTION_BUDGET,
		);
		// The calling convention and the keep-direct rule survive, once.
		expect(section).toContain(
			"codemode runs JavaScript that calls this run's tools as `tools.<name>(args)`.",
		);
		expect(section).toContain(
			"keep a single call, every edit, and the handoff direct",
		);
		for (const tool of tools) {
			const name = String(tool.name);
			if (name === "codemode") continue;
			const line = section
				.split("\n")
				.find((entry) => entry.startsWith(`- tools.${name}:`));
			expect(line).toBeDefined();
			// Exactly the first sentence of the description, nothing after it.
			expect(line).toBe(
				`- tools.${name}: ${firstSentence(String(tool.description ?? name))}`,
			);
		}
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
			expect(section).toContain("- tools.read:");
			expect(section).not.toContain("- tools.edit:");
			expect(section).not.toContain("- tools.write:");
		} finally {
			await host.shutdown();
		}
	});
});

// pi-durable-codemode-parity: the durable `codemode` tool. It is offered only
// when the user's global pi settings enable it, it is an additional tool (the
// run keeps its direct tools), and a script can reach only the tools the run
// was offered — so a read-only run cannot reach `write` through a script.
import { afterEach, expect, test } from "bun:test";
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
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";

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

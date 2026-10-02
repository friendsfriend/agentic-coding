// durable-agent-tools: "Workflow dialogue tools" (`developer_question`,
// `agent_ask`). Exercises the actual tool `execute()` functions directly
// (bypassing the full Harness/registry) against a stub `agentic-coding`
// binary placed first on PATH, mirroring the git-shim pattern used elsewhere
// in this suite (`installGitPushShim` in workflow-effects.test.ts) for a
// child-process boundary that must not reach the real CLI.
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	createWorkflowDialogueExtension,
	type DurableRunContext,
} from "../src/agent-host/tools.ts";

function installAgenticCodingShim(script: string): {
	log: string;
	restore: () => void;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-coding-shim-"));
	const log = path.join(dir, "calls.log");
	fs.writeFileSync(
		path.join(dir, "agentic-coding"),
		script.replace("__LOG__", log),
		{ mode: 0o700 },
	);
	const previous = process.env.PATH;
	process.env.PATH = `${dir}${path.delimiter}${previous ?? ""}`;
	return {
		log,
		restore: () => {
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		},
	};
}

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

function runContext(
	overrides: Partial<DurableRunContext> = {},
): DurableRunContext {
	return { runId: "run-1", cwd: process.cwd(), env: {}, ...overrides };
}

describe("developer_question", () => {
	test("invokes the workflow CLI with the single-question shape and returns its stdout", async () => {
		const shim = installAgenticCodingShim(
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$*" >> "__LOG__"',
				"printf 'developer answered: proceed\\n'",
			].join("\n"),
		);
		restore = shim.restore;
		const context = runContext();
		const extension = createWorkflowDialogueExtension(() => context);
		const tool = extension.tools?.find(
			(item) => item.name === "developer_question",
		);
		if (!tool) throw new Error("developer_question tool not found");
		const result = await tool.execute(
			{
				description: "Which approach?",
				context: "background",
				options: [{ title: "A" }],
			},
			{ conversationId: 1 } as never,
			undefined as never,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content?.[0]).toMatchObject({
			type: "text",
			text: "developer answered: proceed",
		});
		const invoked = fs.readFileSync(shim.log, "utf8").trim();
		expect(invoked).toContain("workflow question");
		expect(invoked).toContain("--description Which approach?");
		expect(invoked).toContain("--options");
	});

	test("a non-zero exit is surfaced as an error result", async () => {
		const shim = installAgenticCodingShim(
			["#!/bin/sh", "printf 'question timed out\\n' 1>&2", "exit 1"].join("\n"),
		);
		restore = shim.restore;
		const extension = createWorkflowDialogueExtension(() => runContext());
		const tool = extension.tools?.find(
			(item) => item.name === "developer_question",
		);
		if (!tool) throw new Error("developer_question tool not found");
		const result = await tool.execute(
			{ description: "x" },
			{ conversationId: 1 } as never,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]).toMatchObject({ type: "text" });
		expect(
			(result.content?.[0] as { text: string } | undefined)?.text,
		).toContain("question timed out");
	});

	test("an unknown conversation reports run context unavailable without spawning anything", async () => {
		let spawned = false;
		const shim = installAgenticCodingShim(["#!/bin/sh", "exit 0"].join("\n"));
		restore = shim.restore;
		const extension = createWorkflowDialogueExtension(() => undefined);
		const tool = extension.tools?.find(
			(item) => item.name === "developer_question",
		);
		if (!tool) throw new Error("developer_question tool not found");
		const result = await tool.execute(
			{ description: "x" },
			{ conversationId: 1 } as never,
			undefined as never,
		);
		expect(result.isError).toBe(true);
		expect(fs.existsSync(shim.log)).toBe(false);
		spawned = fs.existsSync(shim.log);
		expect(spawned).toBe(false);
	});
});

describe("agent_ask", () => {
	test("invokes the workflow CLI with role/description and returns its stdout", async () => {
		const shim = installAgenticCodingShim(
			[
				"#!/bin/sh",
				'printf \'%s\\n\' "$*" >> "__LOG__"',
				"printf 'peer answered: use approach B\\n'",
			].join("\n"),
		);
		restore = shim.restore;
		const extension = createWorkflowDialogueExtension(() => runContext());
		const tool = extension.tools?.find((item) => item.name === "agent_ask");
		if (!tool) throw new Error("agent_ask tool not found");
		const result = await tool.execute(
			{ role: "planner", description: "What did you intend?" },
			{ conversationId: 1 } as never,
			undefined as never,
		);
		expect(result.isError).not.toBe(true);
		expect(result.content?.[0]).toMatchObject({
			type: "text",
			text: "peer answered: use approach B",
		});
		const invoked = fs.readFileSync(shim.log, "utf8").trim();
		expect(invoked).toContain("workflow ask");
		expect(invoked).toContain("--role planner");
	});
});

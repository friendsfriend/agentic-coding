// The tool surface (efficiency backlog item 14): the inspection split and the
// batching rule where a tool is chosen, not only in the protocol document. Every
// durable run reads `read`/`grep`/`bash`, and only a run whose global pi settings
// register `codemode` reads about it — a description never names a tool the run
// does not have. The wording is owned by `src/agent-host/tool-surface.ts`, and
// the assignment repeats it (`src/workflow/assignment.ts`).
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { boundedCodingTools } from "../src/agent-host/bash-tool.ts";
import { createDurableCodemode } from "../src/agent-host/codemode.ts";
import { DurableHost } from "../src/agent-host/host.ts";
import { hostLayout } from "../src/agent-host/layout.ts";
import { suggestingCodingTools } from "../src/agent-host/tool-suggestions.ts";
import {
	ASSIGNMENT_TOOL_SURFACE,
	BATCHING_RULE,
	CODEMODE_ASSIGNMENT_CLAUSE,
	CODEMODE_PIPELINE,
	INSPECTION_SPLIT,
	INSPECTION_SPLIT_WITHOUT_SEARCH,
	resolveCodemodeRegistered,
	toolSurfaceNote,
} from "../src/agent-host/tool-surface.ts";
import { createSearchExtension } from "../src/agent-host/tools.ts";

function description(extension: Extension, name: string): string {
	const tool = (extension.tools ?? []).find((entry) => entry.name === name);
	if (!tool) throw new Error(`missing ${name} tool`);
	return String(tool.description ?? "");
}

function tempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A global agent directory whose pi settings register `codemode`, as the user's
 * own settings do when they enabled it. */
function settingsDir(defaultTools: readonly string[]): string {
	const dir = tempDir("tool-surface-settings-");
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({ defaultTools }),
	);
	return dir;
}

test("read, grep and bash state the inspection split and the batching rule", () => {
	const bash = boundedCodingTools({ codemodeRegistered: true });
	const read = suggestingCodingTools({ codemodeRegistered: true });
	const grep = createSearchExtension({ codemodeRegistered: true });
	for (const [extension, name] of [
		[bash, "bash"],
		[read, "read"],
		[grep, "grep"],
	] as const) {
		const text = description(extension, name);
		expect(text).toContain(INSPECTION_SPLIT);
		expect(text).toContain(CODEMODE_PIPELINE);
		expect(text).toContain(BATCHING_RULE);
	}
	// `edit` keeps pi-durable's own description: only the tools a run inspects
	// with carry the rule.
	expect(description(read, "edit")).not.toContain(INSPECTION_SPLIT);
});

test("a run without codemode is told about the tools it has", () => {
	const bash = boundedCodingTools();
	const read = suggestingCodingTools();
	const grep = createSearchExtension();
	for (const [extension, name] of [
		[bash, "bash"],
		[read, "read"],
		[grep, "grep"],
	] as const) {
		const text = description(extension, name);
		expect(text).toContain(INSPECTION_SPLIT);
		expect(text).toContain(BATCHING_RULE);
		expect(text).not.toContain("codemode");
	}
});

test("codemode's own description states the pipeline and the batching rule", () => {
	const text = String(createDurableCodemode().tool.description ?? "");
	expect(text).toContain(CODEMODE_PIPELINE);
	expect(text).toContain(BATCHING_RULE);
	// The existing contract is untouched: the rule is added to it, not instead
	// of it.
	expect(text).toContain("`ALL_TOOLS`");
	expect(text).toContain("await searchTools");
	expect(text).toContain(
		"Calls still running when the script ends are cancelled",
	);
});

test("the bounded bash description keeps its own bound and its note", () => {
	const text = description(boundedCodingTools(), "bash");
	expect(text).toContain("stopped after 120 s");
	expect(text).toContain("timeout");
	expect(text).toContain("when no `timeout` is given");
	expect(text).toContain(INSPECTION_SPLIT);
});

test("the inspection split names no editing tool", () => {
	// A read-only run has `read`/`grep`/`bash` and no `edit`/`write`: the shared
	// sentence must stay true for it.
	for (const word of ["edit", "write"])
		expect(INSPECTION_SPLIT).not.toContain(word);
});

test("the split says bash is for git and handoff, and for focused builds", () => {
	// The shell clause must not contradict the adjacent `env_build`/`env_test`
	// guidance (bash-tool.ts) and must not read as a ban on the shell work every
	// role does: committing and handing off.
	expect(INSPECTION_SPLIT).toContain(
		"`bash` is for focused builds, tests, `openspec` and the repository's git and handoff commands",
	);
	expect(INSPECTION_SPLIT).not.toContain("`bash` is for builds, tests");
});

test("a run without the search tool is not told to grep", () => {
	const text = toolSurfaceNote({ searchRegistered: false });
	expect(text).toContain(INSPECTION_SPLIT_WITHOUT_SEARCH);
	expect(text).not.toContain("grep");
	// The gone tool's sentence is not the only thing that changes: the split a
	// run without `grep` reads still names the tools it has.
	expect(text).toContain("`read` (with `offset`/`limit`)");
	expect(text).toContain("`bash` is for focused builds");
	expect(toolSurfaceNote({ searchRegistered: true })).toContain(
		INSPECTION_SPLIT,
	);
	// The no-search variant is the only difference between the two notes.
	expect(toolSurfaceNote({ searchRegistered: false })).not.toBe(
		toolSurfaceNote({ searchRegistered: true }),
	);
});

test("the assignment section is the shared sentences, not a restatement", () => {
	expect(ASSIGNMENT_TOOL_SURFACE).toBe(
		[
			"## Tool surface",
			"",
			`${[INSPECTION_SPLIT, CODEMODE_ASSIGNMENT_CLAUSE, BATCHING_RULE].join(". ")}.`,
		].join("\n"),
	);
	// Exactly one wording: the assignment clause is the pipeline sentence with
	// the workflow renderer's own condition, so the two cannot drift.
	expect(CODEMODE_ASSIGNMENT_CLAUSE).toBe(
		"`codemode`, when this run offers it, chains a search → filter → summarise pipeline into one turn",
	);
	expect(CODEMODE_ASSIGNMENT_CLAUSE).toContain(
		CODEMODE_PIPELINE.replace("`codemode` ", ""),
	);
});

test("the shared sentences keep their exact text", () => {
	// Pinned literally: a reworded sentence is a new efficiency measurement, and
	// these figures are recorded in the change's design.
	expect(INSPECTION_SPLIT).toBe(
		"`read` (with `offset`/`limit`) and `grep` (with a `path` filter) are the default way to inspect code; `bash` is for focused builds, tests, `openspec` and the repository's git and handoff commands",
	);
	expect(INSPECTION_SPLIT_WITHOUT_SEARCH).toBe(
		"`read` (with `offset`/`limit`) is the default way to inspect code; `bash` is for focused builds, tests, `openspec` and the repository's git and handoff commands",
	);
	expect(CODEMODE_PIPELINE).toBe(
		"`codemode` chains a search → filter → summarise pipeline into one turn",
	);
	expect(BATCHING_RULE).toBe(
		"Emit every independent call a step needs in one message rather than one call per turn: every turn re-sends the whole conversation",
	);
	expect(toolSurfaceNote({ codemodeRegistered: true })).toBe(
		`${[INSPECTION_SPLIT, CODEMODE_PIPELINE, BATCHING_RULE].join(". ")}.`,
	);
});

test("codemode is registered from the run's own pi settings, never for the orchestrator", () => {
	// The flag every mention of `codemode` is gated on: the run's global pi
	// settings, and never the orchestrator, whose tool surface is exactly its
	// own.
	expect(resolveCodemodeRegistered(settingsDir(["+codemode"]), false)).toBe(
		true,
	);
	expect(resolveCodemodeRegistered(settingsDir(["read"]), false)).toBe(false);
	// No settings file at all is the default: no `codemode`, and never the
	// developer's own `~/.pi` settings, which the host is always given a
	// directory for.
	expect(resolveCodemodeRegistered(tempDir("tool-surface-bare-"), false)).toBe(
		false,
	);
	expect(resolveCodemodeRegistered(settingsDir(["+codemode"]), true)).toBe(
		false,
	);
});

test("the host offers descriptions for exactly the tools a run has", async () => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	for (const enabled of [true, false]) {
		const dir = settingsDir(enabled ? ["+codemode"] : ["read"]);
		const host = await DurableHost.open({
			layout: hostLayout(dir),
			settings: {},
			globalAgentDir: dir,
			storage: new MemoryStorage(),
			models,
		});
		try {
			const descriptions = host.toolDescriptionsForTest();
			for (const name of ["bash", "read", "grep"]) {
				const text = descriptions[name] ?? "";
				expect(text).toContain(INSPECTION_SPLIT);
				expect(text).toContain(BATCHING_RULE);
				if (enabled) expect(text).toContain(CODEMODE_PIPELINE);
				else expect(text).not.toContain("codemode");
			}
			expect(descriptions.codemode === undefined).toBe(!enabled);
		} finally {
			await host.shutdown();
		}
	}
});

test("the orchestrator host is told about the tools it has, and no others", async () => {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	// `codemode` is in the settings, and the orchestrator host still must not
	// mention it: codemode is not part of the orchestrator surface.
	const dir = settingsDir(["+codemode"]);
	const host = await DurableHost.open({
		layout: hostLayout(dir),
		settings: {},
		globalAgentDir: dir,
		storage: new MemoryStorage(),
		models,
		orchestrator: true,
	});
	try {
		const descriptions = host.toolDescriptionsForTest();
		for (const name of ["bash", "read"]) {
			const text = descriptions[name] ?? "";
			expect(text).toContain(INSPECTION_SPLIT);
			expect(text).toContain("grep");
			expect(text).not.toContain("codemode");
		}
		expect(descriptions.codemode).toBeUndefined();
	} finally {
		await host.shutdown();
	}
});

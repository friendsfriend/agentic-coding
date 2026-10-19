// The tool surface (efficiency backlog item 14): the inspection split and the
// batching rule where a tool is chosen, not only in the protocol document. Every
// durable run reads `read`/`grep`/`bash`, and only a run whose global pi settings
// register `codemode` reads about it — a description never names a tool the run
// does not have. The wording is owned by `src/agent-host/tool-surface.ts`, and
// the assignment repeats it (`src/workflow/assignment.ts`).
import { expect, test } from "bun:test";
import type { Extension } from "@earendil-works/pi-durable";
import { boundedCodingTools } from "../src/agent-host/bash-tool.ts";
import { createDurableCodemode } from "../src/agent-host/codemode.ts";
import { suggestingCodingTools } from "../src/agent-host/tool-suggestions.ts";
import {
	BATCHING_RULE,
	CODEMODE_PIPELINE,
	INSPECTION_SPLIT,
} from "../src/agent-host/tool-surface.ts";
import { createSearchExtension } from "../src/agent-host/tools.ts";

function description(extension: Extension, name: string): string {
	const tool = (extension.tools ?? []).find((entry) => entry.name === name);
	if (!tool) throw new Error(`missing ${name} tool`);
	return String(tool.description ?? "");
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
	expect(text).toContain("`ALL_TOOLS` lists the tools this script can call.");
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

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workflowRoots } from "../src/server/operations/observations.ts";
import {
	recordWorkflowTarget,
	researchWorkflowTarget,
	wikiWorkflowDataRoot,
	wikiWorkflowTarget,
	workflowTargets,
} from "../src/workflow/runtime.ts";

/** The registry lives in the shared workflow data root, so every case isolates
 * HERDR_WIKI_DIR the way the runtime tests do. */
function withTempWikiRoot(run: () => void): void {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "target-registry-"));
	const previous = process.env.HERDR_WIKI_DIR;
	process.env.HERDR_WIKI_DIR = path.join(tmp, "wiki");
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env.HERDR_WIKI_DIR;
		else process.env.HERDR_WIKI_DIR = previous;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

describe("workflow target registry", () => {
	test("records a target once and lists it back", () => {
		withTempWikiRoot(() => {
			expect(workflowTargets()).toEqual([]);
			recordWorkflowTarget("/work/custom-path");
			recordWorkflowTarget("/work/custom-path");
			recordWorkflowTarget("/work/another");
			expect(workflowTargets()).toEqual(["/work/another", "/work/custom-path"]);
		});
	});

	test("ignores the repository-independent targets the sidebar always reads", () => {
		withTempWikiRoot(() => {
			recordWorkflowTarget(wikiWorkflowTarget());
			recordWorkflowTarget(researchWorkflowTarget());
			recordWorkflowTarget("");
			expect(workflowTargets()).toEqual([]);
		});
	});

	test("survives an unreadable or foreign marker", () => {
		withTempWikiRoot(() => {
			recordWorkflowTarget("/work/kept");
			const directory = path.join(wikiWorkflowDataRoot(), "targets");
			fs.writeFileSync(path.join(directory, "broken.json"), "{ not json");
			fs.writeFileSync(path.join(directory, "foreign.txt"), "ignored");
			expect(workflowTargets()).toEqual(["/work/kept"]);
		});
	});

	test("a listing never fails without a registry directory", () => {
		withTempWikiRoot(() => {
			expect(workflowTargets()).toEqual([]);
		});
	});

	test("the sidebar roots merge catalog projects with recorded targets", () => {
		withTempWikiRoot(() => {
			recordWorkflowTarget("/work/custom-path");
			expect(workflowRoots(["/work/project", "/work/custom-path"])).toEqual([
				"/work/custom-path",
				"/work/project",
			]);
		});
	});
});

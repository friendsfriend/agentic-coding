import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { workflowRoots } from "../src/server/operations/observations.ts";
import {
	recordWorkflowTarget,
	researchWorkflowTarget,
	targetMarkerReads,
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

	test("re-lists without re-reading markers that did not change", () => {
		// The sidebar re-reads the target registry whenever it reads the workflow
		// catalog. Reading and parsing every marker cost 441 ms on a machine with
		// 4.2 k recorded targets; the scan must pay that once, not per read.
		withTempWikiRoot(() => {
			recordWorkflowTarget("/work/one");
			recordWorkflowTarget("/work/two");
			const first = targetMarkerReads();
			expect(workflowTargets()).toEqual(["/work/one", "/work/two"]);
			expect(targetMarkerReads()).toBe(first + 2);

			expect(workflowTargets()).toEqual(["/work/one", "/work/two"]);
			expect(targetMarkerReads()).toBe(first + 2);

			// A target recorded since is still seen: the new marker is re-read.
			recordWorkflowTarget("/work/three");
			expect(workflowTargets()).toEqual([
				"/work/one",
				"/work/three",
				"/work/two",
			]);
			expect(targetMarkerReads()).toBe(first + 3);
		});
	});

	test("drops a marker the registry no longer holds", () => {
		withTempWikiRoot(() => {
			recordWorkflowTarget("/work/kept");
			const directory = path.join(wikiWorkflowDataRoot(), "targets");
			expect(workflowTargets()).toEqual(["/work/kept"]);
			fs.writeFileSync(
				path.join(directory, "extra.json"),
				'{"target":"/work/extra"}',
			);
			expect(workflowTargets()).toEqual(["/work/extra", "/work/kept"]);
			fs.rmSync(path.join(directory, "extra.json"));
			expect(workflowTargets()).toEqual(["/work/kept"]);
		});
	});

	test("re-reads a marker whose file was rewritten", () => {
		withTempWikiRoot(() => {
			recordWorkflowTarget("/work/original");
			const directory = path.join(wikiWorkflowDataRoot(), "targets");
			expect(workflowTargets()).toEqual(["/work/original"]);
			// The metadata is the cache key: a rewritten marker is read again.
			const file = fs
				.readdirSync(directory)
				.map((name) => path.join(directory, name))[0];
			if (!file) throw new Error("expected a marker file");
			fs.writeFileSync(file, '{"target":"/work/rewritten"}\n');
			expect(workflowTargets()).toEqual(["/work/rewritten"]);
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

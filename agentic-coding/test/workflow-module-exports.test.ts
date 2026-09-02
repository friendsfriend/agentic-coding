// Barrel-completeness oracle for split-workflow-god-modules (design D1): the
// sorted export surface of runtime.ts, definitions.ts, and cli.ts must equal
// this committed baseline both before and after the split — a barrel that
// silently drops or adds a name fails here even if no current importer
// happens to use that name.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { listExportedNames } from "../scripts/workflow-module-graph.ts";
import fixture from "./fixtures/workflow-god-module-export-surface.json" with {
	type: "json",
};

const WORKFLOW_ROOT = path.join(import.meta.dir, "..", "src", "workflow");

describe("workflow god-module export surface (split-workflow-god-modules)", () => {
	for (const [file, expected] of Object.entries(fixture)) {
		test(`${file} exports match the captured baseline`, () => {
			const names = listExportedNames(path.join(WORKFLOW_ROOT, file));
			expect(names).toEqual(expected);
		});
	}
});

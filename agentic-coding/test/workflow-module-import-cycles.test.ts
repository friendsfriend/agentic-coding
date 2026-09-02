// Import-cycle guard for split-workflow-god-modules (design D5): no module
// under runtime/, definitions/, or cli/ may import its own parent barrel
// (runtime.ts, definitions.ts, cli.ts) — that shape is the specific cycle
// `barrel -> submodule -> barrel`, which Bun's ESM loader surfaces as
// undefined-at-module-init rather than a clear error. Passes trivially
// before the split, since those directories do not exist yet.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
	buildImportGraph,
	findImportCycle,
} from "../scripts/workflow-module-graph.ts";

const WORKFLOW_ROOT = path.join(import.meta.dir, "..", "src", "workflow");
// Each split family's own barrel — a submodule may freely import a
// *different* family's barrel (e.g. cli/* importing runtime.ts), which is
// not a cycle; only importing your own parent barrel closes the loop
// `barrel -> submodule -> barrel` that design D5 forbids.
const FAMILY_BARRELS: ReadonlyArray<{ prefix: string; barrel: string }> = [
	"runtime",
	"definitions",
	"cli",
].map((name) => ({
	prefix: path.join(WORKFLOW_ROOT, name) + path.sep,
	barrel: path.join(WORKFLOW_ROOT, `${name}.ts`),
}));

describe("workflow module import cycles (split-workflow-god-modules)", () => {
	test("src/workflow has no import cycle", () => {
		const graph = buildImportGraph(WORKFLOW_ROOT);
		const cycle = findImportCycle(graph);
		expect(cycle).toBeNull();
	});

	test("no split submodule imports its parent barrel", () => {
		const graph = buildImportGraph(WORKFLOW_ROOT);
		const offenders: string[] = [];
		for (const [file, targets] of graph.entries()) {
			const family = FAMILY_BARRELS.find(({ prefix }) =>
				file.startsWith(prefix),
			);
			if (!family) continue;
			for (const target of targets)
				if (target === family.barrel)
					offenders.push(
						`${path.relative(WORKFLOW_ROOT, file)} -> ${path.relative(WORKFLOW_ROOT, target)}`,
					);
		}
		expect(offenders).toEqual([]);
	});
});

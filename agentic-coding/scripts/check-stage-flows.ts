// Checked-in compiled-flow gate (`add-stage-flow-replay`, task 2.2). It validates
// every `stage-flows/*/flow.json` against the current block registry and verifies
// the sidecar spec hash. It never needs a browser or an approved run plan. It also
// validates every checked-in `stage-flows/*.suite.json` against the same flow
// registry (task 9.1/9.2's referential and input-schema checks).
//
// A flow may name a data block (`author-stage-blocks-as-data`). Such a block is
// not a module, so this gate compiles it from the flow's own
// `blocks/<id>.json` sidecar rather than from the developer's approved store: the
// gate stays hermetic and still checks the digest the manifest pinned.

import fs from "node:fs";
import path from "node:path";
import {
	compileDataBlock,
	validateDataBlock,
} from "../src/stage-blocks/data-block.ts";
import type { BlockDefinition } from "../src/stage-blocks/define-block.ts";
import {
	flowDocumentIssues,
	flowManifestIssues,
	readFlowRegistry,
} from "../src/stage-blocks/flow-registry.ts";
import {
	createStageBlockRegistry,
	stageBlockRegistry,
} from "../src/stage-blocks/registry.ts";
import {
	readSuiteRegistry,
	suiteRegistryIssues,
} from "../src/stage-blocks/suite.ts";

const root = path.resolve(import.meta.dir, "..");
const registry = readFlowRegistry(root);
const issues = [...registry.issues];
for (const entry of registry.entries) {
	const documents: BlockDefinition[] = [];
	const blocksDirectory = path.join(entry.directory, "blocks");
	if (fs.existsSync(blocksDirectory)) {
		for (const name of fs.readdirSync(blocksDirectory).sort()) {
			if (!name.endsWith(".json")) continue;
			const file = path.join(blocksDirectory, name);
			let stored: unknown;
			try {
				stored = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
			} catch (error) {
				issues.push({
					code: "flow-block-digest",
					message: `${path.relative(root, file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			const validation = validateDataBlock(stored);
			if (!validation.ok || validation.document === undefined) {
				issues.push({
					code: "flow-block-digest",
					message: `${path.relative(root, file)} is not a valid block document: ${validation.issues[0]?.message ?? "unknown issue"}`,
				});
				continue;
			}
			documents.push(compileDataBlock(validation.document));
		}
	}
	const local = createStageBlockRegistry([
		...stageBlockRegistry.all,
		...documents,
	]);
	issues.push(...flowManifestIssues(entry.manifest, local));
	issues.push(
		...flowDocumentIssues({
			manifest: entry.manifest,
			directory: entry.directory,
			root,
			registry: local,
		}),
	);
}
const suites = readSuiteRegistry(root);
for (const issue of suites.issues) issues.push(issue);
for (const entry of suites.entries)
	for (const issue of suiteRegistryIssues(entry.manifest, registry.entries))
		issues.push(issue);
if (issues.length > 0) {
	for (const issue of issues)
		console.error(
			`${issue.code}${issue.field === undefined ? "" : ` ${issue.field}`}: ${issue.message}`,
		);
	process.exit(1);
}
console.log(
	`stage flows are current (${registry.entries.length} checked-in flow${
		registry.entries.length === 1 ? "" : "s"
	}, ${suites.entries.length} checked-in suite${
		suites.entries.length === 1 ? "" : "s"
	})`,
);

// Regenerate the stage-block catalog manifest. `--check` is the CI/build gate:
// it compares the checked-in artifact byte-for-byte and fails on an incomplete
// block instead of writing. Both modes also refuse a breaking change at an
// id+version the checked-in catalog already published without a major version
// bump (`add-stage-flow-blocks` task 3.4): once a version ships, its contract
// is frozen; a real change needs a new version, not a silent rewrite.

import fs from "node:fs";
import path from "node:path";
import type { StageBlockCatalog } from "../src/stage-blocks/catalog.ts";
import {
	catalogArtifact,
	catalogBreakingChangeIssues,
	catalogForRegistry,
	catalogGateIssues,
} from "../src/stage-blocks/catalog-gate.ts";
import { stageBlockRegistry } from "../src/stage-blocks/registry.ts";

const root = path.resolve(import.meta.dir, "..");
const artifactPath = path.join(
	root,
	"src",
	"stage-blocks",
	"catalog.generated.ts",
);
const catalog = catalogForRegistry(stageBlockRegistry);
const issues = catalogGateIssues(catalog, root, stageBlockRegistry);
if (issues.length > 0) {
	for (const issue of issues)
		console.error(
			`${issue.block ?? "catalog"} ${issue.field}: ${issue.message}`,
		);
	process.exit(1);
}

if (fs.existsSync(artifactPath)) {
	const module = (await import(artifactPath)) as {
		STAGE_BLOCK_CATALOG?: StageBlockCatalog;
	};
	if (module.STAGE_BLOCK_CATALOG !== undefined) {
		const breakingIssues = catalogBreakingChangeIssues(
			module.STAGE_BLOCK_CATALOG,
			catalog,
		);
		if (breakingIssues.length > 0) {
			for (const issue of breakingIssues) console.error(issue.message);
			process.exit(1);
		}
	}
}

const expected = catalogArtifact(catalog);
const check = process.argv.includes("--check");
if (check) {
	let actual = "";
	try {
		actual = fs.readFileSync(artifactPath, "utf8");
	} catch {
		console.error(
			`missing ${path.relative(root, artifactPath)}; run bun run stage-blocks:generate`,
		);
		process.exit(1);
	}
	if (actual !== expected) {
		console.error(
			`${path.relative(root, artifactPath)} is stale; run bun run stage-blocks:generate`,
		);
		process.exit(1);
	}
	console.log(
		`stage-block catalog is current (${catalog.blocks.length} public blocks)`,
	);
} else {
	fs.writeFileSync(artifactPath, expected, "utf8");
	console.log(
		`wrote ${path.relative(root, artifactPath)} (${catalog.blocks.length} public blocks)`,
	);
}

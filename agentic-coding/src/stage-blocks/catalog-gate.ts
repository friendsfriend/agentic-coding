// The catalog build gate. A generated manifest is reviewable only when every
// public block has enough metadata to call it safely; an empty description or a
// missing contract test is a build failure, not a documentation warning.

import fs from "node:fs";
import path from "node:path";
import { buildStageBlockCatalog, type StageBlockCatalog } from "./catalog.ts";
import {
	type BlockDefinition,
	type BlockMetadata,
	breakingContractChanges,
	hasMajorBump,
} from "./define-block.ts";
import type { StageBlockRegistry } from "./registry.ts";
import { validateSchemaDefinition, validateSchemaValue } from "./schema.ts";

export interface CatalogGateIssue {
	readonly block?: string;
	readonly field: string;
	readonly message: string;
}

function issue(
	block: string | undefined,
	field: string,
	message: string,
): CatalogGateIssue {
	return { ...(block === undefined ? {} : { block }), field, message };
}

function checkEntry(entry: BlockMetadata, root: string): CatalogGateIssue[] {
	const issues: CatalogGateIssue[] = [];
	if (entry.title.trim() === "")
		issues.push(issue(entry.id, "title", "title is missing"));
	if (entry.description.trim() === "")
		issues.push(issue(entry.id, "description", "description is missing"));
	if (entry.app.trim() === "")
		issues.push(issue(entry.id, "app", "application scope is missing"));
	if (entry.effects.length === 0)
		issues.push(issue(entry.id, "effects", "at least one effect is required"));
	if (entry.examples.length === 0)
		issues.push(
			issue(entry.id, "examples", "at least one example is required"),
		);
	issues.push(
		...validateSchemaDefinition(entry.params, "params").map((problem) =>
			issue(entry.id, problem.path, problem.message),
		),
	);
	issues.push(
		...validateSchemaDefinition(entry.returns, "returns").map((problem) =>
			issue(entry.id, problem.path, problem.message),
		),
	);
	entry.examples.forEach((example, index) => {
		issues.push(
			...validateSchemaValue(entry.params, example, `examples[${index}]`).map(
				(problem) => issue(entry.id, problem.path, problem.message),
			),
		);
	});
	if (entry.contractTest !== undefined) {
		if (entry.contractTest.trim() === "")
			issues.push(issue(entry.id, "contractTest", "contract test is missing"));
		else if (!fs.existsSync(path.join(root, entry.contractTest)))
			issues.push(
				issue(
					entry.id,
					"contractTest",
					`contract test ${entry.contractTest} does not exist`,
				),
			);
	} else if (entry.kind !== "data")
		issues.push(issue(entry.id, "contractTest", "contract test is missing"));
	if (entry.digest.trim() === "")
		issues.push(issue(entry.id, "digest", "digest is missing"));
	if (
		"anyOf" in entry.params ||
		"anyOf" in entry.returns ||
		entry.params.type !== "object" ||
		entry.returns.type !== "object"
	)
		issues.push(
			issue(entry.id, "schema", "parameter and return schemas must be objects"),
		);
	return issues;
}

export function catalogGateIssues(
	catalog: StageBlockCatalog,
	root: string,
	registry?: StageBlockRegistry,
): CatalogGateIssue[] {
	const issues: CatalogGateIssue[] = [];
	const seen = new Set<string>();
	for (const entry of catalog.blocks) {
		if (seen.has(entry.id))
			issues.push(issue(entry.id, "id", "duplicate catalog id"));
		seen.add(entry.id);
		issues.push(...checkEntry(entry, root));
		if (
			entry.deprecated?.replacementId !== undefined &&
			!catalog.blocks.some(
				(candidate) => candidate.id === entry.deprecated?.replacementId,
			)
		)
			issues.push(
				issue(
					entry.id,
					"deprecated.replacementId",
					`replacement ${entry.deprecated.replacementId} is not in the catalog`,
				),
			);
	}
	if (registry !== undefined) {
		const registryIds = new Set(registry.public.map((block) => block.id));
		for (const entry of catalog.blocks)
			if (!registryIds.has(entry.id))
				issues.push(
					issue(
						entry.id,
						"registry",
						"catalog entry has no registered executable block",
					),
				);
		for (const id of registryIds)
			if (!catalog.blocks.some((entry) => entry.id === id))
				issues.push(
					issue(id, "registry", "registered block is missing from the catalog"),
				);
	}
	return issues;
}

export function catalogForRegistry(
	registry: StageBlockRegistry,
): StageBlockCatalog {
	return buildStageBlockCatalog(registry);
}

/** A block id the checked-in catalog already published at version V must keep
 * that exact contract — a different params/returns/app/roles/effects/
 * requires/provides at the same V is a breaking change with no major version
 * bump (`add-stage-flow-blocks` task 3.4). Compares only ids present in both
 * catalogs at an unchanged version; a new id, a removed id, or a version that
 * already bumped is not this check's concern. */
export function catalogBreakingChangeIssues(
	previous: StageBlockCatalog,
	next: StageBlockCatalog,
): CatalogGateIssue[] {
	const previousById = new Map(
		previous.blocks.map((block) => [block.id, block]),
	);
	const issues: CatalogGateIssue[] = [];
	for (const block of next.blocks) {
		const before = previousById.get(block.id);
		if (before === undefined || before.version !== block.version) continue;
		const changed = breakingContractChanges(
			before as unknown as BlockDefinition,
			block as unknown as BlockDefinition,
		);
		if (changed.length > 0 && !hasMajorBump(before.version, block.version))
			issues.push(
				issue(
					block.id,
					"version",
					`${block.id}@${block.version} changed ${changed.join(", ")} without a major version bump`,
				),
			);
	}
	return issues;
}

/** The generated TypeScript artifact. One function owns its exact bytes so the
 * check and the generator cannot disagree. */
export function catalogArtifact(catalog: StageBlockCatalog): string {
	return [
		"// Generated by `bun run stage-blocks:generate`. Do not edit by hand.",
		'import type { StageBlockCatalog } from "./catalog.ts";',
		"",
		`export const STAGE_BLOCK_CATALOG = ${JSON.stringify(
			catalog,
			null,
			"\t",
		)} as const satisfies StageBlockCatalog;`,
		"",
	].join("\n");
}

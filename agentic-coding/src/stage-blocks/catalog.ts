// The planner sees a generated manifest, never the block registry itself. The
// manifest is sorted, plain JSON and contains no function source and no secret.
// Compact entries are the default; only a lookup by id pays for the schemas and
// examples.

import type { BlockMetadata } from "./define-block.ts";
import type { StageBlockRegistry } from "./registry.ts";

export const STAGE_BLOCK_CATALOG_VERSION = 1 as const;

export interface StageBlockCatalog {
	readonly version: typeof STAGE_BLOCK_CATALOG_VERSION;
	readonly blocks: readonly BlockMetadata[];
}

export interface StageBlockCatalogFilter {
	readonly id?: string;
	readonly query?: string;
	readonly app?: string;
	readonly effect?: "read" | "write" | "destructive";
	readonly limit?: number;
}

export interface CompactBlockEntry {
	readonly id: string;
	readonly version: string;
	readonly app: string;
	readonly roles: readonly string[];
	readonly title: string;
	readonly description: string;
	readonly effects: readonly string[];
	readonly idempotent: boolean;
	readonly requires: readonly string[];
	readonly provides: readonly string[];
	readonly deprecated?: BlockMetadata["deprecated"];
}

export interface FullBlockEntry extends CompactBlockEntry {
	readonly params: BlockMetadata["params"];
	readonly returns: BlockMetadata["returns"];
	readonly examples: BlockMetadata["examples"];
	readonly contractTest: string;
	readonly digest: string;
}

export const MAX_CATALOG_ENTRIES = 100;

export function buildStageBlockCatalog(
	registry: StageBlockRegistry,
): StageBlockCatalog {
	return Object.freeze({
		version: STAGE_BLOCK_CATALOG_VERSION,
		blocks: Object.freeze(
			registry.entries
				.filter((entry) => !entry.internal)
				.sort((left, right) => left.id.localeCompare(right.id)),
		),
	});
}

export function compactEntry(entry: BlockMetadata): CompactBlockEntry {
	return {
		id: entry.id,
		version: entry.version,
		app: entry.app,
		roles: entry.roles,
		title: entry.title,
		description: entry.description,
		effects: entry.effects,
		idempotent: entry.idempotent,
		requires: entry.requires,
		provides: entry.provides,
		...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
	};
}

export function fullEntry(entry: BlockMetadata): FullBlockEntry {
	return {
		...compactEntry(entry),
		params: entry.params,
		returns: entry.returns,
		examples: entry.examples,
		contractTest: entry.contractTest,
		digest: entry.digest,
	};
}

function matches(
	entry: BlockMetadata,
	filter: StageBlockCatalogFilter,
): boolean {
	if (filter.id !== undefined && entry.id !== filter.id) return false;
	if (filter.app !== undefined && entry.app !== filter.app && entry.app !== "*")
		return false;
	if (filter.effect !== undefined && !entry.effects.includes(filter.effect))
		return false;
	if (filter.query !== undefined) {
		const query = filter.query.trim().toLowerCase();
		if (query !== "") {
			const haystack =
				`${entry.id} ${entry.title} ${entry.description} ${entry.app} ${entry.requires.join(" ")} ${entry.provides.join(" ")}`.toLowerCase();
			if (!haystack.includes(query)) return false;
		}
	}
	return true;
}

/** Compact projection with a stable order and a hard bound. */
export function filterCompactCatalog(
	catalog: StageBlockCatalog,
	filter: StageBlockCatalogFilter = {},
): CompactBlockEntry[] {
	const limit = Math.max(1, Math.min(filter.limit ?? 20, MAX_CATALOG_ENTRIES));
	return catalog.blocks
		.filter((entry) => matches(entry, filter))
		.slice(0, limit)
		.map(compactEntry);
}

/** Full projection for one id, or for a filtered set when no id is given. */
export function filterFullCatalog(
	catalog: StageBlockCatalog,
	filter: StageBlockCatalogFilter = {},
): FullBlockEntry[] {
	const limit = Math.max(1, Math.min(filter.limit ?? 20, MAX_CATALOG_ENTRIES));
	return catalog.blocks
		.filter((entry) => matches(entry, filter))
		.slice(0, limit)
		.map(fullEntry);
}

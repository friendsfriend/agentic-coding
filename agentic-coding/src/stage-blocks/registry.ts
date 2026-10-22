// The block registry is built once, at module load, from the checked-in block
// modules. Keeping it static is deliberate: a reviewed spec imports a block
// function directly, and a plan can only name a block this process has already
// loaded. There is no runtime code loading and no per-block tool surface.

import { pilotBlocks } from "./blocks/pilot.ts";
import {
	type BlockDefinition,
	type BlockMetadata,
	blockDigest,
	blockMetadata,
} from "./define-block.ts";

export class StageBlockRegistryError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageBlockRegistryError";
	}
}

export interface StageBlockRegistry {
	readonly all: readonly BlockDefinition[];
	readonly public: readonly BlockDefinition[];
	readonly internal: readonly BlockDefinition[];
	readonly entries: readonly BlockMetadata[];
	get(id: string): BlockDefinition | undefined;
	getVersion(id: string, version: string): BlockDefinition | undefined;
	/** The digest `blockMetadata` publishes for a block id. The registry hashes
	 * each block once, so a caller that only needs the identity — the flow
	 * manifest gate compares a pinned digest, it never executes the block — does
	 * not re-hash a function source or a whole data-block document on every
	 * check (`PERF-102`). */
	digest(id: string): string | undefined;
}

function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function buildRegistry(blocks: readonly BlockDefinition[]): StageBlockRegistry {
	const byId = new Map<string, BlockDefinition>();
	const byVersion = new Map<string, BlockDefinition>();
	// One hash per block, computed once: `blockMetadata` publishes this digest and
	// every gate that compares a pinned digest reads it back from here.
	const digests = new Map<string, string>();
	for (const block of blocks) {
		if (byId.has(block.id))
			throw new StageBlockRegistryError(
				"block-duplicate",
				`block ${block.id} is registered more than once; a block has one checked-in version`,
			);
		byId.set(block.id, block);
		byVersion.set(`${block.id}@${block.version}`, block);
		digests.set(block.id, blockDigest(block));
	}
	for (const block of blocks) {
		const replacement = block.deprecated?.replacementId;
		if (replacement !== undefined && !byId.has(replacement))
			throw new StageBlockRegistryError(
				"block-replacement-missing",
				`block ${block.id} names replacement ${replacement}, which is not registered`,
			);
	}
	const sorted = [...blocks].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
	return Object.freeze({
		all: Object.freeze(sorted),
		public: Object.freeze(sorted.filter((block) => block.internal !== true)),
		internal: Object.freeze(sorted.filter((block) => block.internal === true)),
		// One hash per block, shared by the digest accessor and the published
		// projection (`PERF-201`).
		entries: Object.freeze(
			sorted.map((block) =>
				blockMetadata(block, digests.get(block.id) ?? blockDigest(block)),
			),
		),
		get: (id: string) => byId.get(id),
		digest: (id: string) => digests.get(id),
		getVersion: (id: string, version: string) => {
			const exact = byVersion.get(`${id}@${version}`);
			if (exact !== undefined) return exact;
			const latest = byId.get(id);
			// A plan may name a version it was approved against. An old version is
			// not silently replaced by the current one; only an exact match is
			// executable.
			if (latest === undefined) return undefined;
			return compareVersions(latest.version, version) === 0
				? latest
				: undefined;
		},
	});
}

export const stageBlockRegistry = buildRegistry([
	...pilotBlocks,
] as unknown as readonly BlockDefinition[]);

/** Test seam: build an isolated registry without importing extra modules. */
export function createStageBlockRegistry(
	blocks: readonly BlockDefinition[],
): StageBlockRegistry {
	return buildRegistry(blocks);
}

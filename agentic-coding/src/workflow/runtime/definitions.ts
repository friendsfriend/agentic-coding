// The definition resolver (persist-custom-workflow-definitions): a pinned
// workflow's definition comes from the in-memory built-in registry first and,
// for the reserved `custom.` namespace, from the target store's
// `workflow_definitions` table. The stored row is the source of truth on every
// resolution — it is read before any cache is consulted, so a target that
// never stored the identity fails closed instead of inheriting another
// target's definition — and its manifest is recompiled against the current
// step catalog (including the newest-tier invariants). Compilation is cached
// per process and re-validated against the requesting registry, so an
// unchanged definition is compiled once and a definition the catalog no longer
// satisfies fails closed every time.
import type { Database } from "bun:sqlite";
import { WorkflowRuntimeError } from "../contracts.ts";
import {
	CUSTOM_DEFINITION_VERSION,
	customDefinitionDigest,
	customDefinitionId,
	isCustomDefinitionId,
	withCustomIdentity,
} from "../definitions/custom.ts";
import type {
	CompiledWorkflowDefinition,
	WorkflowManifest,
	WorkflowRegistry,
} from "../registry.ts";
import {
	type DefinitionRow,
	insertDefinition,
	openReadStore,
	storedDefinition,
} from "./store.ts";

/** The pinned definition digest, the content address the store keys on, and
 * the id derived from it. The engine pins `definitionDigest` (the compiled
 * manifest digest, exactly as for a built-in); `digest` is the content address
 * the row's primary key and the `id` suffix are derived from. */
export interface StoredDefinitionIdentity {
	id: string;
	digest: string;
	definitionDigest: string;
}

/** Compiled stored definitions, keyed by content-addressed identity and
 * tagged with the row digest they were compiled from. A hit is served only
 * after the caller's own row was read and matched, and only after the
 * compilation was re-validated against the requesting registry, so the cache
 * saves the compile without ever skipping the store or the catalog. */
const compiled = new Map<
	string,
	{ digest: string; definition: Readonly<CompiledWorkflowDefinition> }
>();

function cacheKey(id: string, version: number): string {
	return `${id}@${version}`;
}

function pinMismatch(id: string, version: number, reason: string): never {
	throw new WorkflowRuntimeError(
		"pin-mismatch",
		`workflow definition pin mismatch: ${id}@${version} (${reason})`,
	);
}

/** The actionable tail for an identity this target store does not hold. The
 * pin-mismatch prefix is kept so the view and the effect claim path recognize
 * the workflow as blocked (exactly like a removed built-in version). */
function notStored(id: string, version: number, repo: string): never {
	pinMismatch(
		id,
		version,
		`no stored custom definition in ${repo}; define it with: workflow define --repo ${repo} --file MANIFEST.json`,
	);
}

/** Re-validate a cached compilation against the requesting registry: every
 * pinned step reference must still resolve with its behavior compatibility.
 * Content addressing makes this a formality for one catalog, but a process
 * holding two catalogs must not serve a definition the requester cannot
 * resolve. */
function assertResolvable(
	registry: WorkflowRegistry,
	definition: Readonly<CompiledWorkflowDefinition>,
): void {
	for (const ref of definition.stepRefs ?? []) {
		const behaviorVersion =
			registry.step(ref.id, ref.version).behaviorVersion ?? 1;
		if (behaviorVersion !== ref.behaviorVersion)
			throw new Error(
				`step behavior compatibility mismatch: ${ref.id}@${ref.version}`,
			);
	}
}

/** Parse one stored row and prove it still describes its own identity: the
 * manifest must be an object, carry the row's identity, hash to the row's
 * digest, and derive the row's identifier. Both resolution paths run this —
 * the compile path and the cache-hit path — so a tampered row is rejected the
 * same way warm or cold. */
function rowManifest(row: DefinitionRow): WorkflowManifest {
	let value: unknown;
	try {
		value = JSON.parse(row.manifest_json);
	} catch (error) {
		pinMismatch(row.id, row.version, (error as Error).message);
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		pinMismatch(row.id, row.version, "stored manifest is not an object");
	const manifest = value as WorkflowManifest;
	if (manifest.id !== row.id || manifest.version !== row.version)
		pinMismatch(
			row.id,
			row.version,
			"stored identity does not match its manifest",
		);
	if (customDefinitionDigest(manifest) !== row.digest)
		pinMismatch(
			row.id,
			row.version,
			"stored digest does not match its manifest",
		);
	if (customDefinitionId(row.digest) !== row.id)
		pinMismatch(
			row.id,
			row.version,
			"stored identifier is not derived from its digest",
		);
	return manifest;
}

/** Compile one stored row. A manifest the current catalog cannot satisfy (an
 * undecodable row, a removed step version, a changed behavior pin, a broken
 * invariant) is a pin mismatch naming the offending step — the same contract a
 * built-in pin mismatch has — so the workflow blocks instead of running
 * against a definition nobody validated. */
function compileStored(
	registry: WorkflowRegistry,
	row: DefinitionRow,
): Readonly<CompiledWorkflowDefinition> {
	if (row.version !== CUSTOM_DEFINITION_VERSION)
		pinMismatch(
			row.id,
			row.version,
			`stored custom definitions are version ${CUSTOM_DEFINITION_VERSION}`,
		);
	const manifest = rowManifest(row);
	try {
		return registry.compileWorkflow(manifest);
	} catch (error) {
		pinMismatch(row.id, row.version, (error as Error).message);
	}
}

function pinned(
	definition: Readonly<CompiledWorkflowDefinition>,
	id: string,
	version: number,
	expectedDigest?: string,
): Readonly<CompiledWorkflowDefinition> {
	if (expectedDigest !== undefined && definition.digest !== expectedDigest)
		pinMismatch(id, version, "the pinned digest no longer resolves");
	return definition;
}

/** Resolve a pinned definition against an already-open store handle. Built-in
 * identities never read the store, so a built-in pin resolves identically to
 * `registry.definition`. */
export function resolveDefinition(
	registry: WorkflowRegistry,
	db: Database,
	id: string,
	version: number,
	expectedDigest?: string,
): Readonly<CompiledWorkflowDefinition> {
	if (!isCustomDefinitionId(id))
		return registry.definition(id, version, expectedDigest);
	const row = storedDefinition(db, id, version);
	if (!row)
		pinMismatch(
			id,
			version,
			"no stored custom definition in this target store",
		);
	const key = cacheKey(id, version);
	const cached = compiled.get(key);
	if (cached && cached.digest === row.digest) {
		// The row is the source of truth even on a hit: a row tampered with under
		// an unchanged digest must fail exactly as it would cold.
		rowManifest(row);
		try {
			assertResolvable(registry, cached.definition);
		} catch (error) {
			pinMismatch(id, version, (error as Error).message);
		}
		return pinned(cached.definition, id, version, expectedDigest);
	}
	const definition = compileStored(registry, row);
	compiled.set(key, { digest: row.digest, definition });
	return pinned(definition, id, version, expectedDigest);
}

/** Resolve a pinned definition for a caller that holds no store handle. Only a
 * custom identity opens the target store. */
export function resolveDefinitionAt(
	registry: WorkflowRegistry,
	repo: string,
	id: string,
	version: number,
	expectedDigest?: string,
): Readonly<CompiledWorkflowDefinition> {
	if (!isCustomDefinitionId(id))
		return registry.definition(id, version, expectedDigest);
	let db: Database;
	try {
		db = openReadStore(repo);
	} catch (error) {
		pinMismatch(
			id,
			version,
			`cannot read the target store (${(error as Error).message}); define it with: workflow define --repo ${repo} --file MANIFEST.json`,
		);
	}
	try {
		// The operator's most likely mistake is an identity this repository never
		// stored (a typo, or a definition from another checkout); name the
		// repository and the command that fixes it.
		if (!storedDefinition(db, id, version)) notStored(id, version, repo);
		return resolveDefinition(registry, db, id, version, expectedDigest);
	} finally {
		db.close();
	}
}

/** Compile and identify an authored manifest without touching any store, so a
 * rejected definition can be reported before a store is migrated or written. */
export function validateDefinition(
	registry: WorkflowRegistry,
	authored: WorkflowManifest,
): StoredDefinitionIdentity & { manifest: WorkflowManifest } {
	const manifest = withCustomIdentity(authored);
	const definition = registry.compileWorkflow(manifest);
	const digest = customDefinitionDigest(manifest);
	const id = customDefinitionId(digest);
	if (definition.id !== id)
		throw new WorkflowRuntimeError(
			"invalid-state",
			`custom definition identity mismatch: ${definition.id} is not ${id}`,
		);
	return { id, digest, definitionDigest: definition.digest, manifest };
}

/** Store a validated custom definition, returning its derived identity. The
 * manifest is compiled — including the newest-tier invariants — before
 * anything is written, so a rejected definition is never stored. */
export function storeDefinition(
	registry: WorkflowRegistry,
	db: Database,
	authored: WorkflowManifest,
	origin: Record<string, unknown>,
	createdAt: string,
): StoredDefinitionIdentity {
	const { id, digest, definitionDigest, manifest } = validateDefinition(
		registry,
		authored,
	);
	insertDefinition(db, {
		digest,
		id,
		version: CUSTOM_DEFINITION_VERSION,
		manifest_json: JSON.stringify(manifest),
		origin_json: JSON.stringify(origin),
		created_at: createdAt,
	});
	return { id, digest, definitionDigest };
}

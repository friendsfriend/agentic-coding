// Where data blocks live. Two stores, one shape:
//
// - approved blocks are shared and reviewed: `<configDir>/stages/blocks/
//   <system>/<id>.json`, written only by the promotion effect on report
//   approval;
// - drafts belong to one workflow run: `<dataRoot>/stage-block-drafts/
//   <workflowId>/<id>.json`, written by `stage_block_save` and removed when the
//   workspace closes.
//
// The registry is composed per call from the checked-in modules plus both
// stores, so a saved draft is executable on the next tool call without a
// restart, a rebuild or a code load.

import fs from "node:fs";
import path from "node:path";
import {
	proofBelongsTo,
	proofProvesBlock,
	type RecordedStageBlockProof,
	type StageBlockProof,
} from "../contracts/stage-block-proof.ts";
import type { StageDataBlockDocument } from "./data-block.ts";
import {
	compileDataBlock,
	compileValidatedDataBlock,
	DATA_BLOCK_MAX_BYTES,
	validateDataBlock,
} from "./data-block.ts";
import {
	type BlockDefinition,
	blockDigest,
	breakingContractChanges,
	hasMajorBump,
} from "./define-block.ts";
import {
	createStageBlockRegistry,
	type StageBlockRegistry,
	stageBlockRegistry,
} from "./registry.ts";

export const STAGE_BLOCK_DRAFT_VERSION = 1 as const;
export const MAX_STORED_BLOCKS = 200;
/** The spec keeps the newest five execution proofs of a draft. */
export const MAX_STORED_PROOFS = 5;
const FILE_MAX_BYTES = DATA_BLOCK_MAX_BYTES * 2;

export interface StageBlockStoreDiagnostic {
	readonly code: string;
	readonly file: string;
	readonly id?: string;
	readonly message: string;
}

export type {
	RecordedStageBlockProof,
	StageBlockProof,
	StageBlockProofFacts,
} from "../contracts/stage-block-proof.ts";
export {
	proofBelongsTo,
	proofProvesBlock,
} from "../contracts/stage-block-proof.ts";

export interface StageBlockDraftRecord {
	readonly version: typeof STAGE_BLOCK_DRAFT_VERSION;
	readonly workflowId: string;
	/** The immutable identity of the run that authored this draft: the
	 * workflow's own creation stamp. A workflow id is reusable, so the id alone
	 * cannot tell this run's work from a deleted predecessor's (`CONC-103`). */
	readonly runId?: string;
	readonly stage: string;
	readonly planId?: string;
	readonly revision?: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly proofs: readonly StageBlockProof[];
}

export interface StoredDataBlock {
	readonly document: StageDataBlockDocument;
	readonly file: string;
}

export interface StoredDataBlockDraft extends StoredDataBlock {
	readonly draft: StageBlockDraftRecord;
}

export interface StageBlockStoreRead {
	readonly blocks: readonly StoredDataBlock[];
	readonly diagnostics: readonly StageBlockStoreDiagnostic[];
}

export interface LoadedStageBlockRegistry {
	readonly registry: StageBlockRegistry;
	readonly diagnostics: readonly StageBlockStoreDiagnostic[];
	readonly approved: readonly StoredDataBlock[];
	readonly drafts: readonly StoredDataBlockDraft[];
}

export class StageBlockStoreError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageBlockStoreError";
	}
}

/** The directory name one stage system owns. A stage system is free text; the
 * store needs a stable, filesystem-safe slug for it. */
export function systemSlug(system: string): string {
	return system
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

export function approvedBlockRoot(configDir: string): string {
	return path.join(configDir, "stages", "blocks");
}

export function approvedBlockPath(
	configDir: string,
	system: string,
	id: string,
): string {
	return path.join(
		approvedBlockRoot(configDir),
		systemSlug(system),
		`${id}.json`,
	);
}

export function draftBlockRoot(dataRoot: string, workflowId: string): string {
	return path.join(dataRoot, "stage-block-drafts", workflowId);
}

export function draftBlockPath(
	dataRoot: string,
	workflowId: string,
	id: string,
): string {
	return path.join(draftBlockRoot(dataRoot, workflowId), `${id}.json`);
}

function readBounded(file: string): unknown {
	const stat = fs.statSync(file);
	if (!stat.isFile())
		throw new StageBlockStoreError("block-file-unreadable", "not a file");
	if (stat.size > FILE_MAX_BYTES)
		throw new StageBlockStoreError(
			"block-file-unreadable",
			`file is larger than ${FILE_MAX_BYTES} bytes`,
		);
	return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
}

function jsonFiles(directory: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(directory, entry.name))
		.sort();
}

function documentOf(value: unknown): StageDataBlockDocument | undefined {
	const validation = validateDataBlock(value);
	return validation.ok ? validation.document : undefined;
}

function invalidDiagnostic(
	file: string,
	value: unknown,
): StageBlockStoreDiagnostic {
	const issues = validateDataBlock(value).issues;
	const id =
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>).id
			: undefined;
	// A document this build cannot read because it is *newer* is not corrupt: it
	// was written by a later format and must be kept, not repaired. The draft
	// path already separates that case (`block-store-version`); the approved path
	// has to as well, or the operator reads "invalid" for a file that is simply
	// ahead of this build (`MIG-010`).
	const forwardFormat = issues.some(
		(issue) => issue.code === "data-block-format",
	);
	return {
		code: forwardFormat ? "block-store-version" : "block-document-invalid",
		file,
		...(typeof id === "string" ? { id } : {}),
		message: issues
			.slice(0, 3)
			.map((issue) => `${issue.path || "document"} ${issue.message}`)
			.join("; "),
	};
}

/** Read every approved data block, bounded and diagnostic instead of fatal: one
 * malformed file must not take the registry down. */
export function readApprovedBlocks(configDir: string): StageBlockStoreRead {
	const root = approvedBlockRoot(configDir);
	const blocks: StoredDataBlock[] = [];
	const byId = new Map<string, StoredDataBlock>();
	const diagnostics: StageBlockStoreDiagnostic[] = [];
	let systems: string[];
	try {
		systems = fs
			.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return { blocks, diagnostics };
	}
	for (const system of systems)
		for (const file of jsonFiles(path.join(root, system))) {
			if (blocks.length >= MAX_STORED_BLOCKS) {
				diagnostics.push({
					code: "block-store-full",
					file,
					message: `the approved block store holds at most ${MAX_STORED_BLOCKS} blocks`,
				});
				continue;
			}
			let value: unknown;
			try {
				value = readBounded(file);
			} catch (error) {
				diagnostics.push({
					code: "block-file-unreadable",
					file,
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			const document = documentOf(value);
			if (!document) {
				diagnostics.push(invalidDiagnostic(file, value));
				continue;
			}
			// The directory only groups blocks by stage system; the document's own
			// `app` is the application key and is validated at save/promotion time
			// against the stage that owns it. Comparing the two here would hide every
			// block of a stage whose `system` differs from its app key
			// (`author-stage-blocks-as-data`, OSV-001).
			const duplicate = byId.get(document.id);
			if (duplicate !== undefined) {
				// One id, two files: picking either one silently would make the block
				// that runs depend on directory order (`MIG-005`).
				diagnostics.push({
					code: "block-duplicate",
					file,
					id: document.id,
					message: `block ${document.id} is also stored at ${path.relative(root, duplicate.file)}; keep one approved file per block id`,
				});
				continue;
			}
			const stored = { document, file };
			blocks.push(stored);
			byId.set(document.id, stored);
		}
	return { blocks, diagnostics };
}

function readDraftRecord(
	value: unknown,
	workflowId: string,
	runId?: string,
): StageBlockDraftRecord | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	const record = value as Record<string, unknown>;
	if (record.version !== STAGE_BLOCK_DRAFT_VERSION) return undefined;
	if (record.workflowId !== workflowId) return undefined;
	// A draft of a *previous* run under the same workflow id is not this run's
	// work: ids are reusable, and adopting a deleted predecessor's draft would
	// make its document and its passed proof look like this run's own
	// (`CONC-103`). The caller that knows the run's identity filters; the plain
	// two-argument read (a test, a maintenance script) sees the directory as it
	// is.
	if (
		runId !== undefined &&
		typeof record.runId === "string" &&
		record.runId !== runId
	)
		return undefined;
	if (typeof record.stage !== "string" || record.stage.trim() === "")
		return undefined;
	if (
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string"
	)
		return undefined;
	// A proof recorded before it carried its document identity cannot prove
	// anything, so it is dropped on read rather than migrated: the tester re-runs
	// the block instead of a promotion resting on an unidentified execution.
	const proofs = Array.isArray(record.proofs)
		? record.proofs.filter(
				(proof): proof is StageBlockProof =>
					proof !== null &&
					typeof proof === "object" &&
					!Array.isArray(proof) &&
					typeof (proof as Record<string, unknown>).stage === "string" &&
					typeof (proof as Record<string, unknown>).version === "string" &&
					typeof (proof as Record<string, unknown>).digest === "string" &&
					((proof as Record<string, unknown>).status === "passed" ||
						(proof as Record<string, unknown>).status === "failed"),
			)
		: [];
	return {
		...(record as unknown as StageBlockDraftRecord),
		proofs,
	};
}

/** Whether a draft file belongs to another run than the caller's: the same
 * record shape, a matching workflow id and a different run identity. Used only
 * to keep a reused workflow id quiet about a predecessor's leftovers. */
function isForeignDraft(
	wrapper: Record<string, unknown> | undefined,
	workflowId: string,
	runId: string,
): boolean {
	const record = wrapper?.draft;
	if (record === null || typeof record !== "object" || Array.isArray(record))
		return false;
	const written = record as Record<string, unknown>;
	return (
		written.workflowId === workflowId &&
		typeof written.runId === "string" &&
		written.runId !== runId
	);
}

/** Read one draft of a workflow by id. One file read, so appending a proof does
 * not re-read the whole store (`PERF-001`). */
export function readStageBlockDraft(
	dataRoot: string,
	workflowId: string,
	id: string,
	runId?: string,
): StoredDataBlockDraft | undefined {
	const file = draftBlockPath(dataRoot, workflowId, id);
	let value: unknown;
	try {
		value = readBounded(file);
	} catch {
		return undefined;
	}
	const wrapper =
		value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const document = documentOf(wrapper?.document);
	const draft = readDraftRecord(wrapper?.draft, workflowId, runId);
	if (!document || !draft) return undefined;
	return { document, draft, file };
}

/** Read the drafts one workflow owns. */
export function readStageBlockDrafts(
	dataRoot: string,
	workflowId: string,
	runId?: string,
): StageBlockStoreRead & { readonly drafts: readonly StoredDataBlockDraft[] } {
	const blocks: StoredDataBlock[] = [];
	const drafts: StoredDataBlockDraft[] = [];
	const diagnostics: StageBlockStoreDiagnostic[] = [];
	for (const file of jsonFiles(draftBlockRoot(dataRoot, workflowId))) {
		if (drafts.length >= MAX_STORED_BLOCKS) {
			diagnostics.push({
				code: "block-store-full",
				file,
				message: `a workflow holds at most ${MAX_STORED_BLOCKS} draft blocks`,
			});
			continue;
		}
		let value: unknown;
		try {
			value = readBounded(file);
		} catch (error) {
			diagnostics.push({
				code: "block-file-unreadable",
				file,
				message: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const wrapper =
			value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: undefined;
		const document = documentOf(wrapper?.document);
		const draft = readDraftRecord(wrapper?.draft, workflowId, runId);
		if (!document || !draft) {
			// Another run's draft under a reused id is simply not this run's file,
			// not a diagnostic about a broken document.
			if (
				draft === undefined &&
				runId !== undefined &&
				isForeignDraft(wrapper, workflowId, runId)
			)
				continue;
			const written = wrapper?.draft;
			const version =
				written !== null && typeof written === "object"
					? (written as Record<string, unknown>).version
					: undefined;
			// A record written by a newer format is a version refusal, not a
			// malformed document: the two need different fixes (`MIG-006`).
			diagnostics.push(
				version !== undefined && version !== STAGE_BLOCK_DRAFT_VERSION
					? {
							code: "block-store-version",
							file,
							message: `draft record version ${String(version)} is not ${STAGE_BLOCK_DRAFT_VERSION}`,
						}
					: invalidDiagnostic(file, wrapper?.document ?? value),
			);
			continue;
		}
		blocks.push({ document, file });
		drafts.push({ document, draft, file });
	}
	return { blocks, drafts, diagnostics };
}

/** Rewrite an existing file's text in place, atomically: a rollback must not
 * leave the approved document truncated when the process dies mid-write
 * (`MIG-009`). */
function writeAtomicText(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${Date.now()}.restore.tmp`;
	fs.writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, file);
}

function writeAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, "\t")}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	fs.renameSync(temporary, file);
}

export interface SaveDraftInput {
	readonly dataRoot: string;
	readonly workflowId: string;
	/** The authoring run's immutable identity, recorded so a later run under the
	 * same workflow id cannot adopt this draft (`CONC-103`). */
	readonly runId?: string;
	readonly stage: string;
	readonly document: StageDataBlockDocument;
	readonly planId?: string;
	readonly revision?: number;
	readonly now?: Date;
}

export interface SavedDraft {
	readonly file: string;
	readonly document: StageDataBlockDocument;
	readonly replaced: boolean;
	/** The version this save replaced, when it replaced one. */
	readonly replacedVersion?: string;
	readonly draft: StageBlockDraftRecord;
}

/** Save one draft, keeping the proof history of a draft it replaces. */
export function saveStageBlockDraft(input: SaveDraftInput): SavedDraft {
	// The store is the last gate before a draft is read back as executable: a
	// caller that skipped validation gets the same refusal here.
	const validation = validateDataBlock(input.document);
	if (!validation.ok) {
		const [first] = validation.issues;
		throw new StageBlockStoreError(
			"block-document-invalid",
			`block document is invalid: ${first ? `${first.path || "document"} ${first.message}` : "unknown issue"}`,
		);
	}
	const file = draftBlockPath(
		input.dataRoot,
		input.workflowId,
		input.document.id,
	);
	const now = (input.now ?? new Date()).toISOString();
	const existing = readStageBlockDraft(
		input.dataRoot,
		input.workflowId,
		input.document.id,
		input.runId,
	);
	// The read path caps the store; the write path has to as well, or a run can
	// create files that later reads refuse (`PERF-004`).
	if (existing === undefined) {
		const held = readStageBlockDrafts(
			input.dataRoot,
			input.workflowId,
			input.runId,
		).drafts;
		if (held.length >= MAX_STORED_BLOCKS)
			throw new StageBlockStoreError(
				"block-store-full",
				`a workflow holds at most ${MAX_STORED_BLOCKS} draft blocks`,
			);
	}
	const previous = existing?.draft;
	// Only the proofs of the document being written survive a re-save: adjusting
	// a block is authoring a new document, and a proof of the previous one does
	// not cover it (`SEC-004`). The tester runs the new version once.
	const digest = storedDigest(input.document);
	const draft: StageBlockDraftRecord = {
		version: STAGE_BLOCK_DRAFT_VERSION,
		workflowId: input.workflowId,
		...(input.runId === undefined ? {} : { runId: input.runId }),
		stage: input.stage,
		...(input.planId === undefined ? {} : { planId: input.planId }),
		...(input.revision === undefined ? {} : { revision: input.revision }),
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		proofs: (previous?.proofs ?? []).filter((proof) =>
			proofBelongsTo(proof, input.document.version, digest),
		),
	};
	writeAtomic(file, { draft, document: input.document });
	return {
		file,
		document: input.document,
		replaced: previous !== undefined,
		...(existing === undefined
			? {}
			: { replacedVersion: existing.document.version }),
		draft,
	};
}

export interface AppendedProof {
	/** The record now on disk, when the proof was appended. */
	readonly draft?: StageBlockDraftRecord;
	/** Set when nothing was written: the draft is gone, or it changed while the
	 * execution ran. Never a silent no-op. */
	readonly issue?: string;
}

/** Append one execution proof to the draft currently on disk.
 *
 * The proof is kept chronologically (newest `MAX_STORED_PROOFS`), so a passing
 * attempt is not erased by a later failing one — the report gate accepts a claim
 * backed by any passed proof of the run. The document written back is the one
 * the store holds *now*, not the caller's pre-execution snapshot: an adjustment
 * saved while the run was in flight must survive the proof (`CONC-004`). When
 * the version changed under the caller, nothing is written and the caller gets a
 * diagnostic naming both versions. */
export function appendStageBlockProof(input: {
	readonly dataRoot: string;
	readonly workflowId: string;
	/** The executing run's own identity, so a proof is never appended to a
	 * predecessor's draft under a reused workflow id (`CONC-103`). */
	readonly runId?: string;
	readonly document: StageDataBlockDocument;
	readonly proof: RecordedStageBlockProof;
}): AppendedProof {
	const found = readStageBlockDraft(
		input.dataRoot,
		input.workflowId,
		input.document.id,
		input.runId,
	);
	if (found === undefined)
		return {
			issue: `block ${input.document.id} is no longer a draft of this run; the proof was not recorded`,
		};
	const digest = storedDigest(found.document);
	// The version alone is not an identity: a same-version re-save replaces the
	// body, and a proof for the body that ran must not attach to the new one
	// (`MIG-008`).
	if (storedDigest(input.document) !== digest)
		return {
			issue: `block ${input.document.id} is now at version ${found.document.version} with a different body than the one that ran; the proof was not recorded`,
		};
	const draft: StageBlockDraftRecord = {
		...found.draft,
		updatedAt: input.proof.at,
		proofs: [
			...found.draft.proofs,
			{ ...input.proof, version: found.document.version, digest },
		].slice(-MAX_STORED_PROOFS),
	};
	writeAtomic(found.file, { draft, document: found.document });
	return { draft };
}

/** Remove every draft one workflow owns; called when its workspace closes. */
export function removeStageBlockDrafts(
	dataRoot: string,
	workflowId: string,
): number {
	const root = draftBlockRoot(dataRoot, workflowId);
	let removed = 0;
	for (const file of jsonFiles(root)) {
		try {
			fs.rmSync(file, { force: true });
			removed += 1;
		} catch {
			/* best effort: a draft is scratch state */
		}
	}
	try {
		fs.rmSync(root, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	return removed;
}

export interface PromoteInput {
	readonly configDir: string;
	readonly system: string;
	readonly document: StageDataBlockDocument;
	/** The approved version this promotion replaces, when there is one. */
	readonly previous?: StageDataBlockDocument;
	/** The file to write, when the caller already resolved it (an adjustment of
	 * an approved block keeps that block's own directory). */
	readonly file?: string;
}

/** Write one approved document, refusing a breaking change without a major
 * version bump. */
export function promoteDataBlock(input: PromoteInput): string {
	const checkedIn = stageBlockRegistry.get(input.document.id);
	if (checkedIn !== undefined && checkedIn.data === undefined)
		throw new StageBlockStoreError(
			"block-duplicate",
			`block ${input.document.id} is checked in; a data block never shadows one`,
		);
	const next = compileDataBlock(input.document);
	if (
		input.previous !== undefined &&
		compareVersions(next.version, input.previous.version) < 0
	)
		throw new StageBlockStoreError(
			"block-version-downgrade",
			`block ${next.id}@${next.version} would downgrade the approved ${input.previous.version}`,
		);
	if (input.previous !== undefined) {
		const previous = compileDataBlock(input.previous);
		const breaking = breakingContractChanges(previous, next);
		if (breaking.length > 0 && !hasMajorBump(previous.version, next.version))
			throw new StageBlockStoreError(
				"block-contract-breaking",
				`block ${next.id} changes ${breaking.join(", ")} and needs a major version bump from ${previous.version}`,
			);
	}
	if (systemSlug(input.system) === "")
		throw new StageBlockStoreError(
			"block-store-system",
			"the stage system is empty, so its block directory cannot be named",
		);
	const file =
		input.file ??
		approvedBlockPath(input.configDir, input.system, input.document.id);
	// Compare-and-write: the guards above ran against the caller's snapshot, so
	// re-read the target immediately before the rename. One writer wins and the
	// other is refused instead of silently overwriting a reviewed document
	// (`CONC-002`). The store is otherwise single-writer: only the promotion
	// effect of one workflow writes approved blocks.
	const current = readApprovedDocumentAt(file);
	if (current.kind === "invalid")
		throw new StageBlockStoreError(
			"block-file-unreadable",
			`block ${input.document.id} has a file this build cannot read (${current.message}); repair or move it before publishing over it`,
		);
	const expected = input.previous === undefined ? undefined : input.previous;
	if (
		JSON.stringify(current.kind === "document" ? current.document : null) !==
		JSON.stringify(expected ?? null)
	)
		throw new StageBlockStoreError(
			"block-concurrently-changed",
			`block ${input.document.id} changed in the approved store while this promotion ran; nothing was written`,
		);
	writeAtomic(file, input.document);
	return file;
}

/** What one approved path holds. "Unreadable" and "absent" are different
 * states and must not collapse into the same `undefined`: the compare-and-write
 * guard treats `undefined` as "nothing is there", so collapsing them lets a
 * promotion overwrite a document this build could not interpret — the one state
 * the read path is deliberately built to survive (`MIG-010`). */
type ApprovedDocumentRead =
	| { readonly kind: "absent" }
	| { readonly kind: "invalid"; readonly message: string }
	| { readonly kind: "document"; readonly document: StageDataBlockDocument };

function describeInvalid(value: unknown): string {
	const issues = validateDataBlock(value).issues;
	return (
		issues
			.slice(0, 3)
			.map((issue) => `${issue.path || "document"} ${issue.message}`)
			.join("; ") || "not a stage block document"
	);
}

function readApprovedDocumentAt(file: string): ApprovedDocumentRead {
	let value: unknown;
	try {
		value = readBounded(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { kind: "absent" };
		return {
			kind: "invalid",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	const document = documentOf(value);
	if (document === undefined)
		return { kind: "invalid", message: describeInvalid(value) };
	return { kind: "document", document };
}

export interface PromotedDrafts {
	readonly promoted: readonly string[];
	readonly removed: number;
}

/** Promote exactly the drafts the approved report claims, all or nothing.
 *
 * - `claims` is the report's claim set, and each claim names its document (id,
 *   version *and* digest): a draft the developer never saw in the review diff is
 *   never published, and a draft whose body or version changed after the report
 *   was written is refused rather than published under the approved label
 *   (`OSV-002`, `SEC-001`, `USAB-002`, `SEC-003`, `CONC-107`, `CONC-108`);
 * - a claimed draft must still exist and carry a `passed` proof *of that
 *   document* — same version and same digest — because a data block's only
 *   contract is the execution that proved it (`SEC-004`, `OSV-015`);
 * - a refusal writes back every file it already wrote — restoring the document
 *   it replaced, atomically, rather than deleting it (`CONC-001`, `MIG-002`,
 *   `MIG-009`) — and leaves every draft in place;
 * - the draft removal is the last statement on purpose: only a batch that fully
 *   landed removes drafts, and an unclaimed draft is removed together with the
 *   claimed ones (they are this run's scratch, and the next run authors its
 *   own). Moving that call above the `catch` would destroy the drafts a refused
 *   batch still needs (`CONC-104`). */
export function promoteStageBlockDrafts(input: {
	readonly configDir: string;
	readonly dataRoot: string;
	readonly workflowId: string;
	/** The approving run's own identity, so a predecessor's drafts are never
	 * published by this run's approval (`CONC-103`). */
	readonly runId?: string;
	readonly system: string;
	/** The documents the approved report claims, as `{ id, version, digest }`:
	 * the published set is exactly the reviewed set (`CONC-107`). */
	readonly claims: readonly {
		readonly id: string;
		readonly version: string;
		readonly digest: string;
	}[];
}): PromotedDrafts {
	const claimed = [
		...new Map(input.claims.map((claim) => [claim.id, claim])).values(),
	];
	if (claimed.length === 0) return { promoted: [], removed: 0 };
	const held = new Map(
		readStageBlockDrafts(
			input.dataRoot,
			input.workflowId,
			input.runId,
		).drafts.map((draft) => [draft.document.id, draft]),
	);
	const drafts = claimed.map((claim) => {
		const draft = held.get(claim.id);
		if (draft === undefined)
			throw new StageBlockStoreError(
				"block-draft-missing",
				`the approved report claims block ${claim.id}@${claim.version}, but this run holds no draft of it`,
			);
		// The approval publishes the document it reviewed, not whatever the run's
		// scratch happens to hold now: a draft saved between the report render and
		// this publish would otherwise be written under the reviewed claim's label
		// (`CONC-107`, `CONC-108`).
		if (draft.document.version !== claim.version)
			throw new StageBlockStoreError(
				"block-claim-mismatch",
				`the approved report claims block ${claim.id}@${claim.version}, but this run's draft is ${draft.document.version}; approve the version that ran`,
			);
		const digest = storedDigest(draft.document);
		if (digest !== claim.digest)
			throw new StageBlockStoreError(
				"block-claim-mismatch",
				`block ${claim.id}@${claim.version} changed after the report was written (the draft now has digest ${digest}, the report claims ${claim.digest}); run the current document once with stage_run and approve the claim stage_block_save returned`,
			);
		if (
			!draft.draft.proofs.some((proof) =>
				proofProvesBlock(proof, draft.document.version, digest),
			)
		)
			throw new StageBlockStoreError(
				"block-proof-missing",
				`block ${claim.id}@${draft.document.version} has no passed execution proof of this document in this run; run it once with stage_run before approving`,
			);
		return draft;
	});
	const approved = new Map(
		readApprovedBlocks(input.configDir).blocks.map((stored) => [
			stored.document.id,
			stored,
		]),
	);
	const written: {
		readonly file: string;
		readonly previous?: string;
	}[] = [];
	const promoted: string[] = [];
	try {
		for (const draft of drafts) {
			const stored = approved.get(draft.document.id);
			// An id that is already approved keeps its own directory: re-deriving
			// the path from this run's `system` would write a second file for one
			// id (and, when the system was renamed, refuse as if the store had
			// changed underneath) (`MIG-007`).
			if (
				stored !== undefined &&
				path.dirname(stored.file) !==
					path.join(
						approvedBlockRoot(input.configDir),
						systemSlug(input.system),
					)
			)
				throw new StageBlockStoreError(
					"block-store-system",
					`block ${stored.document.id} is approved under ${path.dirname(stored.file)} but this stage system resolves to ${path.join(approvedBlockRoot(input.configDir), systemSlug(input.system))}; keep one approved file per block id`,
				);
			const file =
				stored?.file ??
				approvedBlockPath(input.configDir, input.system, draft.document.id);
			// A file the read path refused is not an empty slot: the batch must not
			// overwrite a document this build cannot interpret (it may be a newer
			// format), and the rollback below must not pretend it had nothing to
			// restore (`MIG-010`).
			if (
				stored === undefined &&
				readApprovedDocumentAt(file).kind === "invalid"
			)
				throw new StageBlockStoreError(
					"block-file-unreadable",
					`block ${draft.document.id} already has a file at ${file} that this build cannot read; repair or move it before approving this block`,
				);
			const before = fs.existsSync(file)
				? fs.readFileSync(file, "utf8")
				: undefined;
			promoteDataBlock({
				configDir: input.configDir,
				system: input.system,
				document: draft.document,
				file,
				...(stored === undefined ? {} : { previous: stored.document }),
			});
			written.push({
				file,
				...(before === undefined ? {} : { previous: before }),
			});
			promoted.push(`${draft.document.id}@${draft.document.version}`);
		}
	} catch (error) {
		for (const entry of written)
			try {
				// Restore what the failed batch replaced; a file this batch created is
				// removed. Never delete a document that was already approved.
				if (entry.previous === undefined)
					fs.rmSync(entry.file, { force: true });
				else writeAtomicText(entry.file, entry.previous);
			} catch {
				/* the rollback is best effort; the refusal below reports */
			}
		throw error;
	}
	return {
		promoted,
		removed: removeStageBlockDrafts(input.dataRoot, input.workflowId),
	};
}

export interface LoadStageBlockRegistryInput {
	readonly configDir?: string;
	readonly dataRoot?: string;
	readonly workflowId?: string;
	/** The reading run's own identity, so a draft a previous run of a reused
	 * workflow id left behind is not listed as this run's (`CONC-103`). */
	readonly runId?: string;
}

/** Compose the registry a call executes against: checked-in modules, then the
 * approved store, then this workflow's drafts. A draft supersedes the approved
 * version of the same id (that is what adjusting a block means); a collision
 * with a checked-in block is a diagnostic and the checked-in block wins. */
export function loadStageBlockRegistry(
	input: LoadStageBlockRegistryInput = {},
): LoadedStageBlockRegistry {
	const diagnostics: StageBlockStoreDiagnostic[] = [];
	const approved = input.configDir
		? readApprovedBlocks(input.configDir)
		: { blocks: [], diagnostics: [] };
	diagnostics.push(...approved.diagnostics);
	const drafts = input.dataRoot
		? readStageBlockDrafts(input.dataRoot, input.workflowId ?? "", input.runId)
		: { drafts: [], blocks: [], diagnostics: [] };
	diagnostics.push(...drafts.diagnostics);
	const byId = new Map<string, BlockDefinition>(
		stageBlockRegistry.all.map((block) => [block.id, block]),
	);
	const checkedIn = new Set(byId.keys());
	for (const stored of approved.blocks) {
		if (checkedIn.has(stored.document.id)) {
			diagnostics.push({
				code: "block-duplicate",
				file: stored.file,
				id: stored.document.id,
				message: `block ${stored.document.id} is already checked in; a data block never shadows one`,
			});
			continue;
		}
		byId.set(stored.document.id, compileValidatedDataBlock(stored.document));
	}
	for (const stored of drafts.drafts) {
		if (checkedIn.has(stored.document.id)) {
			diagnostics.push({
				code: "block-duplicate",
				file: stored.file,
				id: stored.document.id,
				message: `block ${stored.document.id} is checked in; a draft never shadows one`,
			});
			continue;
		}
		byId.set(stored.document.id, compileValidatedDataBlock(stored.document));
	}
	return {
		registry: createStageBlockRegistry([...byId.values()]),
		diagnostics,
		approved: approved.blocks,
		drafts: drafts.drafts,
	};
}

function compareVersions(left: string, right: string): number {
	const parse = (value: string): number[] =>
		value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

/** The digest a stored document has when executed. */
export function storedDigest(document: StageDataBlockDocument): string {
	return blockDigest(compileValidatedDataBlock(document));
}

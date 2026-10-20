// Evidence selectors (add-dashboard-evidence-panel, task 1.1).
//
// One workflow's evidence manifest, and one entry's recorded bytes for the
// panel's inline preview, read through the gateway port like every other
// dashboard read. Both keys name the workflow, but only the manifest is dropped
// by a workflow event: a stored file is named after a ULID and its bytes are
// never rewritten, so it can only go away with the whole evidence directory —
// which is what a full invalidation (a gap or a cleared cache) covers.
//
// Reads only: the panel offers no mutating action, so this module has none.
import type { EvidenceManifest } from "../../contracts/environment.ts";
import { evidenceManifestSchema } from "../../contracts/environment.ts";
import type { StageJournal } from "../../contracts/stages.ts";
import { stageJournalSchema } from "../../contracts/stages.ts";
import { cache, gateway } from "./index.ts";

type Signal = AbortSignal | undefined;

export interface EvidenceReadOptions {
	readonly refresh?: boolean;
}

/** The evidence keys of one workflow: the manifest listing, which a workflow
 * event drops, and one entry's file bytes, which it does not. */
export function evidenceKey(repo: string, workflowId: string): string {
	return `evidence:${repo}:${workflowId}`;
}

/** One entry's recorded bytes. Immutable once stored: a ULID is never rewritten,
 * so nothing short of a full invalidation can outdate them. */
export function evidenceFileKey(
	repo: string,
	workflowId: string,
	id: string,
): string {
	return `evidence-file:${repo}:${workflowId}:${id}`;
}

/** One workflow's evidence manifest, in the store's own order (oldest first).
 * A workflow that never attached anything answers with an empty manifest. */
export async function loadEvidence(
	repo: string,
	workflowId: string,
	signal?: Signal,
	options: EvidenceReadOptions = {},
): Promise<EvidenceManifest | undefined> {
	return cache.load(
		`${evidenceKey(repo, workflowId)}:manifest`,
		(readSignal) =>
			gateway().observe<EvidenceManifest>(
				{ kind: "evidence", repo, workflowId },
				evidenceManifestSchema,
				readSignal,
			),
		{ signal, ...options },
	);
}

/** The recorded bytes of one entry, for the inline preview. `undefined` when
 * the workflow is unknown or the file is gone: the panel then shows metadata
 * only, which is an answer rather than a failure. */
export async function loadEvidenceFile(
	repo: string,
	workflowId: string,
	id: string,
	signal?: Signal,
): Promise<Uint8Array | undefined> {
	return cache.load(
		evidenceFileKey(repo, workflowId, id),
		(readSignal) => gateway().evidenceFile(workflowId, id, readSignal),
		{ signal },
	);
}

/** One workflow's stage step journal (`add-stage-flow-evidence`). It lives in the
 * same `evidence:` key family as the manifest, so a workflow event drops both:
 * steps are written while a run works, exactly like attached evidence. A
 * workflow that ran no stage flow answers with no entries. */
export function stageJournalKey(repo: string, workflowId: string): string {
	return `evidence:${repo}:${workflowId}:journal`;
}

export async function loadStageJournal(
	repo: string,
	workflowId: string,
	signal?: Signal,
	options: EvidenceReadOptions = {},
): Promise<StageJournal | undefined> {
	return cache.load(
		stageJournalKey(repo, workflowId),
		(readSignal) =>
			gateway().observe<StageJournal>(
				{ kind: "stage-journal", repo, workflowId },
				stageJournalSchema,
				readSignal,
			),
		{ signal, ...options },
	);
}

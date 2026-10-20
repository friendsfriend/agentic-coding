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

/** One entry's bytes: the answer, or a `SupersededRead` when the caller has to
 * tell "the file is gone" from "the cache dropped an outdated completion". */
export interface EvidenceFileReadOptions {
	readonly superseded?: "undefined" | "reject";
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
	options: EvidenceFileReadOptions = {},
): Promise<Uint8Array | undefined> {
	return cache.load(
		evidenceFileKey(repo, workflowId, id),
		(readSignal) => gateway().evidenceFile(workflowId, id, readSignal),
		{ signal, ...options },
	);
}

/** The most report text the dashboard decodes. A report is markdown an agent
 * wrote, so it is bounded here rather than trusted: a huge `.md` must not become
 * a huge render. */
export const EVIDENCE_TEXT_MAX_CHARS = 200_000;

/** The bytes a decode is given: a UTF-8 character is at most four bytes, so this
 * window always holds the bound's worth of characters. The decode therefore never
 * runs over a file larger than the text it can keep — a 20 MB report is a 800 KB
 * decode, not a 20 MB one. A sequence cut by the window's end decodes to one
 * replacement character past the bound, which the slice drops. */
export const EVIDENCE_TEXT_WINDOW_BYTES = EVIDENCE_TEXT_MAX_CHARS * 4;

/** One entry's recorded bytes decoded as text, for the evidence report. The
 * bytes come from the same immutable key as every other entry read, so a re-open
 * is a cache hit; `undefined` when the workflow is unknown or the file is gone,
 * which the subview reports as an absent report rather than a failure. */
export async function loadEvidenceText(
	repo: string,
	workflowId: string,
	id: string,
	signal?: Signal,
	options: EvidenceFileReadOptions = {},
): Promise<string | undefined> {
	const bytes = await loadEvidenceFile(repo, workflowId, id, signal, options);
	if (bytes === undefined) return undefined;
	const window =
		bytes.byteLength > EVIDENCE_TEXT_WINDOW_BYTES
			? bytes.subarray(0, EVIDENCE_TEXT_WINDOW_BYTES)
			: bytes;
	return new TextDecoder("utf-8")
		.decode(window)
		.slice(0, EVIDENCE_TEXT_MAX_CHARS);
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

// What proves a data block: the record of one execution of one document.
//
// A data block has no contract test. Its contract is the validated examples
// plus the live run that executed it, so the proof has to name the *document*
// that ran — `version` and `digest` — not just the block id. A proof that only
// names the block would legitimise whatever body happens to sit in the draft
// when a claim is read (`SEC-004`, `CONC-102`, `OSV-015`).
//
// It lives in the contract layer because two layers with nothing else in common
// have to agree on it: the pure step behavior that validates a report and the
// fs-bound store that promotes a draft. Both ask the same question through the
// same function instead of each keeping its own copy of the rule, and the
// source-layer guardrails keep it importable from both (a pure domain module may
// not reach into `stage-blocks/`, which is persistence).

export interface StageBlockProof {
	readonly stage: string;
	readonly runId: string;
	readonly planId?: string;
	readonly revision?: number;
	readonly status: "passed" | "failed";
	readonly at: string;
	readonly version: string;
	readonly digest: string;
	readonly journalIds: readonly number[];
	readonly evidenceIds: readonly string[];
}

/** What a caller records; the store fills in what it is the authority for. */
export type RecordedStageBlockProof = Omit<
	StageBlockProof,
	"version" | "digest"
>;

/** The proof projection a gate needs: the status plus what it proves. */
export interface StageBlockProofFacts {
	readonly status: "passed" | "failed";
	readonly version: string;
	readonly digest: string;
}

/** Whether a proof was recorded for this exact document. */
export function proofBelongsTo(
	proof: StageBlockProofFacts,
	version: string,
	digest: string,
): boolean {
	return proof.version === version && proof.digest === digest;
}

/** A proof counts for a claim only when it passed *and* was recorded for the
 * document the claim names. Both gates use this one rule. */
export function proofProvesBlock(
	proof: StageBlockProofFacts,
	version: string,
	digest: string,
): boolean {
	return proof.status === "passed" && proofBelongsTo(proof, version, digest);
}

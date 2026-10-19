// Pure resolution helpers of the orchestrator's workflow-management tools
// (efficiency backlog item 21: one identifier across the tools, keyed
// multi-id polls, and an unknown id answered instead of failed).
//
// The measured waste was a wrong id carried between two tools:
// `list_workflows` returned one identifier and `workflow_status` did not agree
// with it, so a poll of `add-environment-instances` failed inside a whole turn
// instead of answering `add-environment-instance-lifecycle`. Everything here is
// a pure function over the ids a read already returned: no I/O, no Effect, no
// server call, so it can be tested on its own and reused by the start guard.

/** One poll's bounded id list: the protocol bound, not a policy. */
export const MAX_WORKFLOW_IDS_PER_POLL = 8;
/** How many closest ids a `similar` answer names before it counts the rest. */
export const SIMILAR_ID_LIMIT = 5;

export interface SimilarIdCandidates {
	/** The closest ids, most similar first, at most `SIMILAR_ID_LIMIT`. */
	readonly candidates: string[];
	/** How many further similar ids were left out of `candidates`. */
	readonly more: number;
}

function tokens(id: string): string[] {
	return id
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

/** Two tokens name the same thing when they are equal or one is a prefix of the
 * other (`instances` ~ `instance`), which is exactly the wrong-id shape the
 * corpus shows. A shorter prefix than four characters is too weak to mean
 * anything (`a` prefixes half of every id). */
function tokenMatches(a: string, b: string): boolean {
	if (a === b) return true;
	const shorter = a.length <= b.length ? a : b;
	const longer = a.length <= b.length ? b : a;
	return shorter.length >= 4 && longer.startsWith(shorter);
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++)
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/** Shared lowercase tokens decide first (so a candidate that repeats the
 * caller's words beats a merely short id), edit distance decides inside a tie.
 * The distance term is capped below the per-token weight, so a long id can
 * never outrank a better token overlap. A candidate that shares no token is not
 * similar at all and is dropped instead of padding the list. */
function similarity(
	id: string,
	wanted: string,
	wantedTokens: string[],
): number {
	const idTokens = tokens(id);
	let shared = 0;
	for (const token of wantedTokens)
		if (idTokens.some((candidate) => tokenMatches(token, candidate))) shared++;
	if (shared === 0) return 0;
	return (
		shared * 1000 -
		Math.min(editDistance(id.toLowerCase(), wanted.toLowerCase()), 999)
	);
}

/** The closest existing ids to `wanted`, most similar first, bounded to `limit`
 * and reporting how many further similar ids exist. */
export function rankSimilarIds(
	ids: readonly string[],
	wanted: string,
	limit: number = SIMILAR_ID_LIMIT,
): SimilarIdCandidates {
	const wantedTokens = tokens(wanted);
	const scored = ids
		.filter((id) => id !== wanted)
		.map((id) => ({ id, score: similarity(id, wanted, wantedTokens) }))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	const capped = scored.slice(0, Math.max(0, limit));
	return {
		candidates: capped.map((entry) => entry.id),
		more: scored.length - capped.length,
	};
}

/** `workflow_status`'s `workflowId` as a poll list: one id or several, at most
 * `MAX_WORKFLOW_IDS_PER_POLL`, duplicates dropped. An empty call and an
 * oversized one are refused here rather than read as a partial poll. */
export function decodeWorkflowIds(
	value: string | readonly string[] | undefined,
): string[] {
	const list =
		typeof value === "string"
			? [value]
			: Array.isArray(value)
				? [...value]
				: [];
	const ids: string[] = [];
	for (const entry of list) {
		const id = typeof entry === "string" ? entry.trim() : "";
		if (id === "" || ids.includes(id)) continue;
		ids.push(id);
	}
	if (ids.length === 0)
		throw new Error("workflow_status needs at least one workflowId");
	if (ids.length > MAX_WORKFLOW_IDS_PER_POLL)
		throw new Error(
			`workflow_status takes at most ${MAX_WORKFLOW_IDS_PER_POLL} workflow ids in one call`,
		);
	return ids;
}

/** `workflow_status`'s `sinceRevision` per id: one number applies to every id,
 * a keyed record applies to the ids it names, and an unnamed id polls in full.
 * Only the requested ids are kept, so a stray key changes nothing. */
export function decodeSinceRevisions(
	value: number | Readonly<Record<string, number>> | undefined,
	ids: readonly string[],
): ReadonlyMap<string, number> {
	const revisions = new Map<string, number>();
	if (value === undefined) return revisions;
	if (typeof value === "number") {
		for (const id of ids) revisions.set(id, value);
		return revisions;
	}
	for (const id of ids) {
		const revision = value[id];
		if (typeof revision === "number") revisions.set(id, revision);
	}
	return revisions;
}

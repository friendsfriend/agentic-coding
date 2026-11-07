import { defineDoc } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import {
	type Draft,
	type DraftData,
	stagedTreeReceipt,
	stored,
} from "./definition-draft-data.ts";
import { promoteDefinition } from "./definition-promotion.ts";
import { stagedTreeIdentity } from "./definition-staged-tree.ts";

export type PromotionData = {
	records: Record<string, string>;
	requests: Record<string, string>;
	attempts?: Record<string, string>;
	acknowledgements?: Record<string, string>;
};
export const Promotions = defineDoc<PromotionData>({
	kind: "v2.environment-definition-promotions",
	version: 1,
	scope: "session",
	initial: () => ({ records: {}, requests: {}, attempts: {} }),
	checkpointWhen: () => true,
});

export function promotionRequest(body: Record<string, unknown>) {
	if (
		Object.keys(body).some(
			(key) =>
				![
					"requestId",
					"id",
					"revision",
					"digest",
					"approve",
					"sourcesApprove",
				].includes(key),
		)
	)
		throw new Error("Unsupported promotion field");
	const requestId = text(body.requestId, "promotion request ID", 128),
		id = text(body.id, "draft ID", 80),
		contentDigest = text(body.digest, "draft digest", 64),
		approve = text(body.approve, "approved content digest", 64),
		sourcesApprove =
			body.sourcesApprove === undefined
				? undefined
				: text(body.sourcesApprove, "approved auxiliary sources digest", 64);
	if (!/^draft-[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid definition draft ID");
	if (
		!/^[a-f0-9]{64}$/.test(contentDigest) ||
		!/^[a-f0-9]{64}$/.test(approve) ||
		(sourcesApprove !== undefined && !/^[a-f0-9]{64}$/.test(sourcesApprove)) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Promotion requires exact revision and content digests");
	// Validate even an historical replay before looking up its receipt. Keeping
	// the request hash unchanged preserves prior exact, valid retry identities.
	if (approve !== contentDigest)
		throw new Error("Approval must equal the exact requested content digest");
	const request = digest(
			sourcesApprove === undefined
				? JSON.stringify({ id, revision: body.revision, digest: contentDigest })
				: JSON.stringify({
						id,
						revision: body.revision,
						digest: contentDigest,
						sourcesApprove,
					}),
		),
		key = digest(requestId);
	return {
		id,
		revision: Number(body.revision),
		contentDigest,
		approve,
		sourcesApprove,
		request,
		key,
	};
}
export type PromotionRecord = ReturnType<typeof recordPromotion>;
/** A historical projection: never observes the destination or invokes effects. */
export function promotionIndex(doc: PromotionData | null | undefined) {
	return Object.values(doc?.records ?? {})
		.map((raw) => {
			const { id, draftId, revision, digest, outcome, observedAt, ordinal } =
				stored<PromotionRecord>(raw);
			return { id, draftId, revision, digest, outcome, observedAt, ordinal };
		})
		.sort((a, b) => b.ordinal - a.ordinal);
}
export function readPromotion(
	doc: PromotionData | null | undefined,
	id: string,
) {
	if (!/^promotion-[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid promotion record ID");
	const raw = doc?.records[id];
	if (!raw) throw new Error("Unknown promotion record");
	return stored<PromotionRecord>(raw);
}
/** Call before reading draft state: deleted drafts still have historical receipts. */
export function replayPromotion(
	records: PromotionData,
	intent: ReturnType<typeof promotionRequest>,
) {
	const recorded = records.requests[intent.key];
	if (!recorded) return null;
	const receipt = stored<{ request: string; id: string }>(recorded);
	if (receipt.request !== intent.request)
		throw new Error("Promotion request ID reused for different input");
	const raw = records.records[receipt.id];
	if (!raw) throw new Error("Private promotion receipt is unavailable");
	return stored<PromotionRecord>(raw);
}
/** Native transaction caller owns persistence. Filesystem publication is separate
 * from native receipt durability; this does not claim crash-atomicity. */
export function recordPromotion(
	config: Config,
	records: PromotionData,
	drafts: DraftData,
	intent: ReturnType<typeof promotionRequest>,
	onWrite: () => void,
) {
	if (Object.keys(records.records).length >= 64)
		throw new Error(
			"Private promotion history capacity reached; automatic pruning is unsupported",
		);
	const { id, revision, contentDigest, approve, request, key } = intent,
		raw = drafts.drafts[id];
	if (!raw) throw new Error("Unknown definition draft");
	const draft = stored<Draft>(raw);
	if (draft.revision !== revision || draft.digest !== contentDigest)
		throw new Error("Draft changed; load current before promotion");
	// A draft that saved source text writes those sources nowhere, so promotion
	// must be decided against a verified tree of exactly these bytes.
	const verifiedTree = draft.sources?.length
		? stagedTreeReceipt(drafts, id)
		: null;
	if (draft.sources?.length && !verifiedTree)
		throw new Error(
			"Promotion requires a verified staged tree identity for this draft revision; assemble the isolated tree first",
		);
	if (verifiedTree) {
		const identity = stagedTreeIdentity(draft);
		if (
			verifiedTree.revision !== draft.revision ||
			verifiedTree.digest !== draft.digest ||
			verifiedTree.treeDigest !== identity.treeDigest
		)
			throw new Error(
				"Staged tree identity is stale or does not match the staged bytes; reassemble the isolated tree for this revision",
			);
	}
	const result = promoteDefinition(
			config,
			draft,
			approve,
			intent.sourcesApprove,
			onWrite,
		),
		record = {
			...result,
			id: `promotion-${key}`,
			draftId: id,
			revision: draft.revision,
			digest: draft.digest,
			destination: "environments.json",
			sourceFilesWritten: result.auxiliaryFiles.length > 0,
			repositoriesChanged: false,
			runtimeChecked: false,
			reloaded: false,
			...(verifiedTree
				? {
						stagedTree: {
							treeDigest: verifiedTree.treeDigest,
							fileCount: verifiedTree.fileCount,
							bytes: verifiedTree.bytes,
							treeRetained: false as const,
						},
					}
				: {}),
			observedAt: new Date().toISOString(),
			ordinal: Object.keys(records.records).length + 1,
			message:
				"Historical promotion outcome only, not current live-file state. Written outcomes used an exclusive temp file, fsync and same-directory rename after checking the recorded base; unchanged outcomes wrote nothing. Auxiliary staged sources publish into the live configuration directory only; repository-bound sources, processes, containers and leases were never changed. No runtime validation or reload. Exact replay performs no new destination observation or write.",
		};
	records.records[record.id] = JSON.stringify(record);
	records.requests[key] = JSON.stringify({ request, id: record.id });
	return record;
}

import { defineDoc } from "@earendil-works/pi-durable";
import { type Config, digest, text } from "../config.ts";
import { type Draft, type DraftData, stored } from "./definition-draft-data.ts";
import { promoteDefinition } from "./definition-promotion.ts";

type PromotionData = {
	records: Record<string, string>;
	requests: Record<string, string>;
};
export const Promotions = defineDoc<PromotionData>({
	kind: "v2.environment-definition-promotions",
	version: 1,
	scope: "session",
	initial: () => ({ records: {}, requests: {} }),
	checkpointWhen: () => true,
});

export function promotionRequest(body: Record<string, unknown>) {
	if (
		Object.keys(body).some(
			(key) =>
				!["requestId", "id", "revision", "digest", "approve"].includes(key),
		)
	)
		throw new Error("Unsupported promotion field");
	const requestId = text(body.requestId, "promotion request ID", 128),
		id = text(body.id, "draft ID", 80),
		contentDigest = text(body.digest, "draft digest", 64),
		approve = text(body.approve, "approved content digest", 64);
	if (!/^draft-[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid definition draft ID");
	if (
		!/^[a-f0-9]{64}$/.test(contentDigest) ||
		!/^[a-f0-9]{64}$/.test(approve) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Promotion requires exact revision and content digests");
	// Validate even an historical replay before looking up its receipt. Keeping
	// the request hash unchanged preserves prior exact, valid retry identities.
	if (approve !== contentDigest)
		throw new Error("Approval must equal the exact requested content digest");
	const request = digest(
			JSON.stringify({ id, revision: body.revision, digest: contentDigest }),
		),
		key = digest(requestId);
	return {
		id,
		revision: Number(body.revision),
		contentDigest,
		approve,
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
	const result = promoteDefinition(config, draft, approve),
		record = {
			...result,
			id: `promotion-${key}`,
			draftId: id,
			revision: draft.revision,
			digest: draft.digest,
			destination: "environments.json",
			sourceFilesWritten: false,
			repositoriesChanged: false,
			runtimeChecked: false,
			reloaded: false,
			observedAt: new Date().toISOString(),
			ordinal: Object.keys(records.records).length + 1,
			message:
				"Historical promotion outcome only, not current live-file state. Written outcomes used an exclusive temp file, fsync and same-directory rename after checking the recorded base; unchanged outcomes wrote nothing. No source/repository files, processes, containers or leases were changed. No runtime validation or reload. Exact replay performs no new destination observation or write.",
		};
	records.records[record.id] = JSON.stringify(record);
	records.requests[key] = JSON.stringify({ request, id: record.id });
	return record;
}

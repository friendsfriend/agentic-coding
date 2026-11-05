import { digest, text } from "../config.ts";
import { stored } from "./definition-draft-data.ts";
import type {
	PromotionData,
	promotionRequest,
} from "./definition-promotion-records.ts";

type Attempt = {
	id: string;
	request: string;
	draftId: string;
	revision: number;
	digest: string;
	status: "pending" | "completed" | "failed-before-write" | "acknowledged";
	startedAt: string;
	acknowledgement?: string;
};
/** Durable uncertainty barrier, never a resumable execution grant. */
export function beginPromotion(
	doc: PromotionData,
	intent: ReturnType<typeof promotionRequest>,
) {
	doc.attempts ??= {};
	const attempts = doc.attempts;
	if (attempts[intent.key])
		throw new Error(
			"This promotion attempt already exists; inspect its outcome and use a new request only after resolving uncertainty",
		);
	if (
		Object.values(attempts).some(
			(raw) => stored<Attempt>(raw).status === "pending",
		)
	)
		throw new Error(
			"An unresolved promotion attempt blocks new writes; inspect promotion attempts before explicit acknowledgement",
		);
	if (Object.keys(attempts).length >= 128)
		throw new Error(
			"Promotion attempt capacity reached; automatic pruning is unsupported",
		);
	const attempt: Attempt = {
		id: `promotion-${intent.key}`,
		request: intent.request,
		draftId: intent.id,
		revision: intent.revision,
		digest: intent.contentDigest,
		status: "pending",
		startedAt: new Date().toISOString(),
	};
	attempts[intent.key] = JSON.stringify(attempt);
}
export function finishPromotion(
	doc: PromotionData,
	key: string,
	status: "completed" | "failed-before-write",
) {
	const raw = doc.attempts?.[key];
	if (!raw) throw new Error("Promotion attempt is unavailable");
	const attempt = stored<Attempt>(raw);
	if (attempt.status !== "pending")
		throw new Error("Promotion attempt is no longer pending");
	if (doc.attempts) doc.attempts[key] = JSON.stringify({ ...attempt, status });
}
export function promotionAttempts(doc: PromotionData | null | undefined) {
	return Object.values(doc?.attempts ?? {}).map((raw) => {
		const { id, draftId, revision, digest, status, startedAt } =
			stored<Attempt>(raw);
		return { id, draftId, revision, digest, status, startedAt };
	});
}
/** An acknowledgement only removes the blocker. It never writes/retries,
 * certifies file state, removes filesystem locks or grants execution authority. */
export function acknowledgePromotion(
	doc: PromotionData,
	body: Record<string, unknown>,
	active: ReadonlySet<string>,
) {
	if (
		Object.keys(body).some(
			(key) => !["requestId", "id", "acknowledge"].includes(key),
		)
	)
		throw new Error("Unsupported attempt acknowledgement field");
	const id = text(body.id, "promotion attempt ID", 80),
		requestId = text(body.requestId, "acknowledgement request ID", 128);
	if (!/^promotion-[a-f0-9]{64}$/.test(id) || body.acknowledge !== true)
		throw new Error(
			"Explicit true acknowledgement of an exact promotion attempt is required",
		);
	const key = id.slice("promotion-".length),
		raw = doc.attempts?.[key];
	if (!raw) throw new Error("Unknown promotion attempt");
	if (active.has(key))
		throw new Error("A live promotion attempt cannot be acknowledged");
	const attempt = stored<Attempt>(raw),
		acknowledgement = digest(
			JSON.stringify({ requestId, id, acknowledge: true }),
		);
	const acknowledgementKey = digest(requestId),
		previous = doc.acknowledgements?.[acknowledgementKey];
	if (previous && previous !== acknowledgement)
		throw new Error("Acknowledgement request ID reused for different input");
	if (
		attempt.status === "acknowledged" &&
		attempt.acknowledgement === acknowledgement
	)
		return { id, status: "acknowledged" as const };
	if (attempt.status !== "pending")
		throw new Error("Only an unresolved promotion attempt can be acknowledged");
	if (doc.attempts)
		doc.attempts[key] = JSON.stringify({
			...attempt,
			status: "acknowledged",
			acknowledgement,
		});
	doc.acknowledgements ??= {};
	doc.acknowledgements[acknowledgementKey] = acknowledgement;
	return { id, status: "acknowledged" as const };
}

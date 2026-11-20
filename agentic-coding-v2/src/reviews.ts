import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import { Catalog, decode, type Review, type TaskInfo } from "./state.ts";

export type ReviewRequest = {
	kind?: "code-review" | "question";
	questions?: import("./questions.ts").Question[];
	baseCommit?: string;
	title: string;
	path: string;
	snapshot: string | (() => Promise<string>);
};
/** The native tool task ID is the replay identity; no in-memory promise owns the decision. */
export async function requestReview(
	owner: TaskInfo,
	request: ReviewRequest,
	api: ToolExecutionApi,
	context: Context,
): Promise<Review> {
	const id = `review-${api.taskId}`;
	const catalog = await api.snapshot(Catalog, context);
	const previous = catalog?.reviews[id];
	const snapshot = previous
		? decode<Review>(previous).snapshot
		: typeof request.snapshot === "string"
			? request.snapshot
			: await request.snapshot();
	const candidate: Review = {
		kind: request.kind ?? "approval",
		...(request.baseCommit ? { baseCommit: request.baseCommit } : {}),
		ownerKind: catalog?.tasks[String(owner.id)] ? "task" : "conversation",
		callId: api.callId,
		...(request.questions ? { questions: request.questions } : {}),
		conversationId: api.conversationId,
		nativeToolTaskId: api.taskId,
		id,
		taskId: owner.id,
		topicId: owner.topicId,
		path: request.path,
		title: text(request.title, "review title", 512),
		snapshot,
		digest: digest(snapshot),
		state: "pending",
		comments: "",
		revision: 1,
		createdAt: Date.now(),
	};
	await api.commit(async (tx) => {
		const doc = await tx.doc(Catalog);
		if (doc.reviews[id]) {
			if (decode<Review>(doc.reviews[id]).digest !== candidate.digest)
				throw new Error(
					"Review snapshot changed during replay; request a fresh review",
				);
		} else {
			const requests = Object.values(doc.reviews).map((raw) =>
				decode<Review>(raw),
			);
			if (requests.length >= 1000)
				throw new Error(
					"Human interaction history capacity reached (1000 requests); history was retained",
				);
			if (
				requests.filter(
					(r) =>
						r.state === "pending" && r.conversationId === api.conversationId,
				).length >= 8
			)
				throw new Error(
					"Eight human requests are already pending in this conversation",
				);
			const serialized = JSON.stringify(candidate);
			if (Buffer.byteLength(serialized) > 650000)
				throw new Error(
					"Human request exceeds the 650 KB encoded snapshot limit; choose a smaller review scope or shorter previews",
				);
			doc.reviews[id] = serialized;
		}
	}, context);
	await api.details({ reviewId: id }, context);
	return waitForReview(id, api, context);
}

/** A human decision remains a durable document, not a local promise's authority. */
export async function waitForReview(
	id: string,
	api: Pick<ToolExecutionApi, "watchDoc">,
	context: Context,
): Promise<Review> {
	const watch = await api.watchDoc(Catalog, context);
	if (!watch) throw new Error("Review catalog missing");
	try {
		const initial = watch.value?.reviews[id];
		if (initial && decode<Review>(initial).state !== "pending")
			return decode<Review>(initial);
		return await new Promise<Review>((resolve, reject) => {
			watch.start(async (call) => {
				// Failed frames keep the last value; only a new document is a decision.
				if (call.kind !== "value" || call.retired) return;
				const raw = call.value.reviews[id];
				if (raw && decode<Review>(raw).state !== "pending")
					resolve(decode<Review>(raw));
			});
			void watch.closed.then(() =>
				reject(
					new Error(
						"Review wait interrupted; the same request will be recovered",
					),
				),
			);
		});
	} finally {
		await watch.stop();
	}
}

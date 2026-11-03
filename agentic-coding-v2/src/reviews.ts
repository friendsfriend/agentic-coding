import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { digest, text } from "./config.ts";
import { Catalog, decode, type Review, type TaskInfo } from "./state.ts";

export type ReviewRequest = {
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
	const previous = (await api.snapshot(Catalog, context))?.reviews[id];
	const snapshot = previous
		? decode<Review>(previous).snapshot
		: typeof request.snapshot === "string"
			? request.snapshot
			: await request.snapshot();
	const candidate: Review = {
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
		} else doc.reviews[id] = JSON.stringify(candidate);
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
			watch.start(async (value) => {
				const raw = value?.reviews[id];
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

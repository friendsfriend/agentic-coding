import type { Runtime } from "../../src/runtime.ts";
import { eventually } from "./runtime.ts";
export async function pendingReview(app: Runtime, id: number, title?: string) {
	const matches = (
		review: Awaited<ReturnType<Runtime["snapshot"]>>["reviews"][number],
	) =>
		review.taskId === id &&
		review.state === "pending" &&
		(title ? review.title === title : review.title.startsWith("Environment "));
	const state = await eventually(
		() => app.snapshot(),
		(state) => state.reviews.some(matches),
	);
	const review = state.reviews.find(matches);
	if (!review) throw new Error("Review disappeared");
	return review;
}
export async function approve(app: Runtime, id: number, title?: string) {
	const review = await pendingReview(app, id, title);
	await app.decide(
		review.id,
		review.revision,
		"approved",
		"Approve exact isolated fixture target",
	);
}

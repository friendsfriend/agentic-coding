import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskDetails } from "../../../protocol/index.ts";
import type { Runtime } from "../../../runtime.ts";
import {
	type Attachment,
	Catalog,
	decode,
	type Review,
	type TaskInfo,
	values,
} from "../../../state.ts";

/** Catalog-owned tasks only; no arbitrary native task/checkpoint or filesystem reads. */
export async function readTask(app: Runtime, id: number): Promise<TaskDetails> {
	const native = await app.taskResult(id);
	const catalog = await app.harness.snapshot(Catalog, context);
	const raw = catalog?.tasks[String(id)];
	if (!raw) throw new Error("Task metadata unavailable");
	return {
		id,
		metadata: { ...decode<TaskInfo>(raw) },
		native: native
			? {
					status: native.state.status,
					abortRequested: native.abortRequested,
					outcome:
						native.state.status === "terminal"
							? { ...native.state.outcome }
							: null,
				}
			: null,
		reviews: values<Review>(catalog?.reviews)
			.filter((review) => review.taskId === id)
			.map((review) => ({ ...review })),
		attachments: values<Attachment>(catalog?.attachments)
			.filter((item) => item.taskId === id)
			.map(({ id, taskId, mediaType, caption }) => ({
				id,
				taskId,
				mediaType,
				caption,
			})),
	};
}

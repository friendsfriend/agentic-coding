import {
	CompactionTask,
	defineExtension,
	type Harness,
	hook,
	type TaskId,
} from "@earendil-works/pi-durable";

/** Serialize native summarizers, not generation or summary placement.
 *
 * Task IDs impose a durable admission order. A nonblocking compaction ends
 * when its summary write is admitted, NOT when that write reaches the next
 * generation boundary. Waiting for the task therefore cannot create the
 * generation → summary-placement → generation cycle. No process-local lease
 * survives cancellation or needs reconstruction on reopen.
 */
export function compactionSerializationExtension(
	harness: () => Harness,
	waiting: (delta: number) => void = () => {},
) {
	return defineExtension({
		name: "host-compaction-serialization",
		hooks: [
			hook(CompactionTask, {
				beforeCompact: async (_compaction, runtime, context) => {
					const conversation = await harness().conversation(
						runtime.conversationId,
						context,
					);
					if (!conversation)
						throw new Error("compaction conversation is missing");
					const state = await conversation.viewState(context);
					let predecessors: TaskId[];
					try {
						const live = state.value.docs["pi.live"] as
							| { compactions?: { taskId: TaskId }[] }
							| undefined;
						predecessors = (live?.compactions ?? [])
							.map((entry) => entry.taskId)
							.filter((id) => id < runtime.taskId);
					} finally {
						state.dispose();
					}
					for (const id of predecessors) {
						waiting(1);
						try {
							await harness().waitForTask(id, context);
						} finally {
							waiting(-1);
						}
					}
				},
			}),
		],
	});
}

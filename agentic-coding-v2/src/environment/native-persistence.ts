import { BACKGROUND_CONTEXT as background } from "@earendil-works/chord/context";
import {
	defineDoc,
	type Harness,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Catalog, decode, type TaskInfo } from "../state.ts";
import type {
	DocumentData,
	EnvironmentDocument,
	EnvironmentPersistence,
} from "./persistence.ts";

function nativeDocument<T extends DocumentData>(
	document: EnvironmentDocument<T>,
) {
	return defineDoc({
		...document.definition,
		checkpointWhen: () => true,
	});
}

/** Only this adapter knows native task cancellation and document transactions. */
export function nativeEnvironmentPersistence(
	harness: Harness,
): EnvironmentPersistence {
	return {
		snapshot: (document) =>
			harness.snapshot(nativeDocument(document), background),
		commit: (operation) =>
			harness.commit(
				async (tx) =>
					operation({
						doc: async <T extends DocumentData>(
							document: EnvironmentDocument<T>,
						): Promise<T> =>
							// Native Draft<T> is a mutable view of the same JSON shape. Keep
							// its runtime-specific mapped type inside this adapter.
							(await tx.doc(nativeDocument(document))) as T,
						ownerActive: async (id) => {
							const task = await tx.task(id as TaskId);
							return Boolean(
								task &&
									!task.abortRequested &&
									task.state.status !== "terminal",
							);
						},
						ownerInfo: async (id) => {
							const raw = (await tx.doc(Catalog)).tasks[String(id)];
							return raw ? decode<TaskInfo>(raw) : undefined;
						},
					}),
				background,
			),
	};
}

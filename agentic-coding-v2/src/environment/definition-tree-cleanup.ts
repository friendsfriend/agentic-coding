import { digest, text } from "../config.ts";
import { type DraftData, stored } from "./definition-draft-data.ts";

export type TreeCleanup = {
	request: string;
	name: string | null;
	kind: "release" | "delete-draft";
	status: "pending" | "completed";
	startedAt: string;
	result?: string;
};
/** A pending marker is uncertainty, not permission to repeat a deletion. */
export function assertNoTreeCleanup(doc: Readonly<DraftData> | undefined) {
	if (
		Object.values(doc?.treeCleanups ?? {}).some(
			(raw) => stored<TreeCleanup>(raw).status === "pending",
		)
	)
		throw new Error(
			"Unresolved retained-tree cleanup blocks tree assembly and cleanup; inspect retained-tree metadata before recovery",
		);
}
export function cleanupReplay(
	doc: Readonly<DraftData> | undefined,
	key: string,
	request: string,
) {
	const raw = doc?.treeCleanups?.[key];
	if (!raw) return null;
	const attempt = stored<TreeCleanup>(raw);
	if (attempt.request !== request)
		throw new Error("Cleanup request ID reused for different input");
	if (attempt.status !== "completed" || attempt.result === undefined)
		throw new Error(
			"Retained-tree cleanup outcome is unresolved; automatic retry is forbidden",
		);
	return { result: stored<unknown>(attempt.result) };
}
export function beginTreeCleanup(
	doc: DraftData,
	key: string,
	request: string,
	kind: TreeCleanup["kind"],
	name: string | null,
) {
	assertNoTreeCleanup(doc);
	if (Object.keys(doc.treeCleanups ?? {}).length >= 128)
		throw new Error(
			"Retained-tree cleanup capacity reached; automatic pruning is unsupported",
		);
	doc.treeCleanups ??= {};
	doc.treeCleanups[key] = JSON.stringify({
		request,
		kind,
		name,
		status: "pending",
		startedAt: new Date().toISOString(),
	} satisfies TreeCleanup);
}
export function finishTreeCleanup(
	doc: DraftData,
	key: string,
	result: unknown,
) {
	const raw = doc.treeCleanups?.[key];
	if (!raw) throw new Error("Retained-tree cleanup marker is unavailable");
	const attempt = stored<TreeCleanup>(raw);
	if (attempt.status !== "pending")
		throw new Error("Retained-tree cleanup is no longer pending");
	if (doc.treeCleanups)
		doc.treeCleanups[key] = JSON.stringify({
			...attempt,
			status: "completed",
			result: JSON.stringify(result),
		} satisfies TreeCleanup);
}
export function treeCleanupHistory(doc: Readonly<DraftData> | undefined) {
	return Object.entries(doc?.treeCleanups ?? {}).map(([key, raw]) => {
		const { name, kind, status, startedAt } = stored<TreeCleanup>(raw);
		return { id: `tree-cleanup-${key}`, name, kind, status, startedAt };
	});
}
export function deletionIdentity(body: Record<string, unknown>) {
	if (
		Object.keys(body).some(
			(key) => !["requestId", "id", "revision"].includes(key),
		)
	)
		throw new Error("Unsupported staged draft removal field");
	const requestId = text(body.requestId, "draft request ID", 128),
		id = text(body.id, "draft ID", 80);
	if (
		!/^draft-[a-f0-9]{64}$/.test(id) ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error("Exact current revision required");
	return {
		key: digest(requestId),
		request: digest(
			JSON.stringify({ kind: "delete-draft", id, revision: body.revision }),
		),
	};
}

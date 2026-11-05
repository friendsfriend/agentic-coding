import { digest, text } from "../config.ts";
import { type DraftData, stored } from "./definition-draft-data.ts";

export type TreeCleanup = {
	request: string;
	name: string | null;
	kind: "release" | "delete-draft" | "supersede";
	status: "pending" | "completed" | "acknowledged";
	revision?: number;
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
	if (doc.treeCleanups?.[key])
		throw new Error(
			"Cleanup attempt already exists; acknowledgement never authorizes reuse of its request ID",
		);
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
		revision: 1,
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
			revision: (attempt.revision ?? 1) + 1,
			result: JSON.stringify(result),
		} satisfies TreeCleanup);
}
export function treeCleanupHistory(doc: Readonly<DraftData> | undefined) {
	return Object.entries(doc?.treeCleanups ?? {}).map(([key, raw]) => {
		const { name, kind, status, startedAt, revision } =
			stored<TreeCleanup>(raw);
		return {
			id: `tree-cleanup-${key}`,
			name,
			kind,
			status,
			startedAt,
			revision: revision ?? (status === "pending" ? 1 : 2),
		};
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

/** Retire only the uncertainty blocker. No filesystem operation or retry grant. */
export function acknowledgeTreeCleanup(
	doc: DraftData,
	body: Record<string, unknown>,
	active: ReadonlySet<string>,
) {
	if (
		Object.keys(body).some(
			(key) => !["requestId", "id", "revision", "acknowledge"].includes(key),
		)
	)
		throw new Error("Unsupported cleanup acknowledgement field");
	const id = text(body.id, "cleanup attempt ID", 80),
		requestId = text(body.requestId, "acknowledgement request ID", 128);
	if (
		!/^tree-cleanup-[a-f0-9]{64}$/.test(id) ||
		body.acknowledge !== true ||
		!Number.isSafeInteger(body.revision) ||
		Number(body.revision) < 1
	)
		throw new Error(
			"Explicit true acknowledgement of an exact cleanup attempt ID and revision is required",
		);
	const key = id.slice("tree-cleanup-".length),
		receiptKey = digest(requestId),
		request = digest(
			JSON.stringify({ id, revision: body.revision, acknowledge: true }),
		),
		previous = doc.treeCleanupAcknowledgements?.[receiptKey];
	if (previous) {
		const receipt = stored<{
			request: string;
			result: { id: string; revision: number; status: "acknowledged" };
		}>(previous);
		if (receipt.request !== request)
			throw new Error("Acknowledgement request ID reused for different input");
		return receipt.result;
	}
	const raw = doc.treeCleanups?.[key];
	if (!raw) throw new Error("Unknown cleanup attempt");
	if (active.has(key))
		throw new Error("A live cleanup attempt cannot be acknowledged");
	const attempt = stored<TreeCleanup>(raw),
		revision = attempt.revision ?? (attempt.status === "pending" ? 1 : 2);
	if (attempt.status !== "pending" || revision !== body.revision)
		throw new Error(
			"Only the exact current revision of a pending cleanup attempt can be acknowledged",
		);
	if (Object.keys(doc.treeCleanupAcknowledgements ?? {}).length >= 128)
		throw new Error(
			"Cleanup acknowledgement capacity reached; automatic pruning is unsupported",
		);
	const result = {
		id,
		revision: revision + 1,
		status: "acknowledged" as const,
	};
	if (doc.treeCleanups)
		doc.treeCleanups[key] = JSON.stringify({
			...attempt,
			status: "acknowledged",
			revision: result.revision,
		} satisfies TreeCleanup);
	doc.treeCleanupAcknowledgements ??= {};
	doc.treeCleanupAcknowledgements[receiptKey] = JSON.stringify({
		request,
		result,
	});
	return result;
}

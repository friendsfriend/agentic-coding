import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor } from "@earendil-works/pi-durable";
import type { Runtime } from "../../../runtime.ts";
import { clientSession } from "./sessions.ts";
/** Opaque, bounded, session-bound cursor registry. Client data cannot become
 * a backend cursor/filter or broaden the native catalog ownership check. */
export class SessionHistory {
	private cursors = new Map<
		string,
		{ id: number; cursor: Cursor; expiresAt: number }
	>();
	constructor(private app: Runtime) {}
	/** Expired first, then the soonest-expiring live reference. A fresh read never
	 * depends on a prior cursor, so refusing it would only deny an observation that
	 * is already permitted; an evicted continuation fails closed on its next use. */
	private evict(now: number) {
		for (const [key, value] of this.cursors)
			if (value.expiresAt <= now) this.cursors.delete(key);
		while (this.cursors.size >= 64) {
			let oldest: string | undefined;
			let expiry = Number.POSITIVE_INFINITY;
			for (const [key, value] of this.cursors)
				if (value.expiresAt < expiry) {
					expiry = value.expiresAt;
					oldest = key;
				}
			if (oldest === undefined) return;
			this.cursors.delete(oldest);
		}
	}
	private reserve(id: number, cursor: Cursor) {
		this.evict(Date.now());
		if (this.cursors.size >= 64)
			throw new Error("History cursor capacity reached; wait for expiry");
		const next = crypto.randomUUID();
		this.cursors.set(next, {
			id,
			cursor,
			expiresAt: Date.now() + 600000,
		});
		return next;
	}
	async read(id: number, cursor?: string) {
		const session = await clientSession(this.app, id, false);
		this.evict(Date.now());
		const continuation =
			cursor === undefined ? undefined : this.cursors.get(cursor);
		if (cursor !== undefined && (!continuation || continuation.id !== id))
			throw new Error(
				"History cursor is missing, expired or belongs to another session",
			);
		// Reserve the opaque continuation before the awaited read. Concurrent
		// requests cannot reuse it; failures remain consumed, never auto-replayed.
		if (cursor !== undefined) this.cursors.delete(cursor);
		const page = await session.entries(
			{ order: "descending" },
			50,
			continuation?.cursor,
			context,
		);
		// Recheck catalog authority after the non-atomic read.
		await clientSession(this.app, id, false);
		const next = page.next === undefined ? null : this.reserve(id, page.next);
		return {
			id,
			entries: [...page.items].reverse().map((entry) => ({ ...entry })),
			cursor: next,
		};
	}
}

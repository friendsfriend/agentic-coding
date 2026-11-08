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
	async read(id: number, cursor?: string) {
		const session = await clientSession(this.app, id, false);
		for (const [key, value] of this.cursors)
			if (value.expiresAt <= Date.now()) this.cursors.delete(key);
		const continuation =
			cursor === undefined ? undefined : this.cursors.get(cursor);
		if (cursor !== undefined && (!continuation || continuation.id !== id))
			throw new Error(
				"History cursor is missing, expired or belongs to another session",
			);
		if (this.cursors.size >= 64 && cursor === undefined)
			throw new Error("History cursor capacity reached; wait for expiry");
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
		let next: string | null = null;
		if (page.next) {
			if (this.cursors.size >= 64)
				throw new Error("History cursor capacity reached; wait for expiry");
			next = crypto.randomUUID();
			this.cursors.set(next, {
				id,
				cursor: page.next,
				expiresAt: Date.now() + 600000,
			});
		}
		return {
			id,
			entries: [...page.items].reverse().map((entry) => ({ ...entry })),
			cursor: next,
		};
	}
}

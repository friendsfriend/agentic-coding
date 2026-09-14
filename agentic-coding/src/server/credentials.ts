// Scoped ephemeral credential interactions for the unified backend
// (expose-unified-bun-backend, task 2.7). A credential request is bound to the
// operation and the authenticated client that owns it: only that client can
// answer, the answer is never persisted, and a disconnect or timeout cancels
// the interaction within its bound so owned work unblocks safely.
//
// The registry deliberately stores only the interaction identity and owner id
// in memory; the prompt and answer never enter a durable record, an event
// payload or a log line.
import { CREDENTIAL_TIMEOUT_MS } from "./protocol.ts";

export interface CredentialInteractionView {
	readonly id: string;
	readonly ownerId: string;
	readonly createdAt: string;
	readonly expiresAt: string;
}

interface PendingInteraction {
	readonly id: string;
	readonly ownerId: string;
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly resolve: (value: string) => void;
}

export type CredentialResolveOutcome =
	| { readonly accepted: true }
	| { readonly accepted: false; readonly reason: string };

/**
 * Single-owner credential interactions. `request` returns a promise that
 * resolves with the answered value, an empty string on timeout/disconnect, or
 * rejects when the owning signal aborts.
 */
export class CredentialRegistry {
	private nextId = 0;
	private readonly pending = new Map<string, PendingInteraction>();
	/** Owners with at least one open interaction, for disconnect cleanup. */
	private readonly byOwner = new Map<string, Set<string>>();

	constructor(
		readonly timeoutMs = CREDENTIAL_TIMEOUT_MS,
		private readonly now: () => number = () => Date.now(),
	) {}

	pendingFor(ownerId: string): CredentialInteractionView[] {
		const ids = this.byOwner.get(ownerId);
		if (!ids) return [];
		return [...ids]
			.map((id) => this.pending.get(id))
			.filter((entry): entry is PendingInteraction => entry !== undefined)
			.map((entry) => ({
				id: entry.id,
				ownerId: entry.ownerId,
				createdAt: new Date(entry.createdAt).toISOString(),
				expiresAt: new Date(entry.expiresAt).toISOString(),
			}));
	}

	/** Register a request and return its promise. The caller supplies the
	 * authenticated owner identity; only that owner can resolve it. */
	request(
		ownerId: string,
		_signal?: AbortSignal,
		timeoutMs = this.timeoutMs,
	): Promise<string> {
		this.nextId += 1;
		const id = `cred-${this.nextId}`;
		const createdAt = this.now();
		const expiresAt = createdAt + timeoutMs;
		return new Promise<string>((resolve, reject) => {
			const finish = (value: string, error?: Error) => {
				const current = this.pending.get(id);
				if (!current) return;
				clearTimeout(current.timer);
				this.pending.delete(id);
				const owners = this.byOwner.get(ownerId);
				owners?.delete(id);
				if (owners && owners.size === 0) this.byOwner.delete(ownerId);
				if (error) reject(error);
				else resolve(value);
			};
			const timer = setTimeout(() => finish(""), timeoutMs);
			this.pending.set(id, {
				id,
				ownerId,
				createdAt,
				expiresAt,
				timer,
				resolve: (value: string) => finish(value),
			});
			const owners = this.byOwner.get(ownerId) ?? new Set<string>();
			owners.add(id);
			this.byOwner.set(ownerId, owners);
		});
	}

	/** Interaction id of the newest request for an owner (used to correlate
	 * the response with the prompt that created it). */
	newestFor(ownerId: string): string | undefined {
		const ids = this.byOwner.get(ownerId);
		if (!ids || ids.size === 0) return undefined;
		return [...ids].at(-1);
	}

	/** Answer an interaction. A different owner, an unknown id or a stale
	 * revision is rejected without using the supplied value. */
	respond(
		ownerId: string,
		interactionId: string,
		value: string,
	): CredentialResolveOutcome {
		const entry = this.pending.get(interactionId);
		if (!entry) return { accepted: false, reason: "unknown interaction" };
		if (entry.ownerId !== ownerId)
			return {
				accepted: false,
				reason: "interaction belongs to another client",
			};
		if (this.now() >= entry.expiresAt)
			return { accepted: false, reason: "interaction expired" };
		entry.resolve(value);
		return { accepted: true };
	}

	/** Cancel every interaction owned by a disconnected client. */
	ownerDisconnected(ownerId: string): number {
		const ids = this.byOwner.get(ownerId);
		if (!ids) return 0;
		const count = ids.size;
		for (const id of [...ids]) this.pending.get(id)?.resolve("");
		return count;
	}

	/** Test/shutdown helper. */
	cancelAll(): void {
		for (const entry of [...this.pending.values()]) entry.resolve("");
	}
}

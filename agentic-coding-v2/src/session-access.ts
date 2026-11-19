import type { Session } from "./protocol/index.ts";

/** A finished task's history cannot be revived by input. Offer its nearest
 * observed writable owner, never a sibling, guessed root, or replacement agent.
 * This is navigation guidance only; the server rechecks admission separately. */
export function followUpSession(
	sessions: readonly Session[],
	id: number,
): Session | undefined {
	const seen = new Set([id]);
	let parent = sessions.find((session) => session.id === id)?.parent;
	while (parent !== undefined && parent !== null && !seen.has(parent)) {
		seen.add(parent);
		const owner = sessions.find((session) => session.id === parent);
		if (!owner) return undefined;
		if (owner.writable) return owner;
		parent = owner.parent;
	}
	return undefined;
}

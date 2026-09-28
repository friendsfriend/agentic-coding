// The one Effect-runtime execution boundary for worktree-port consumers that
// are Promise- or sync-shaped (introduce-worktree-port, task 1.5).
//
// The port is Effect-native and the environment repository facade is
// synchronous, so the facade's worktree methods run port effects through this
// named composition root instead of calling `Effect.runPromise` ad hoc: the
// source-layer architecture check keeps exactly one execution point per
// consumer boundary.
import { Effect } from "effect";

/** Run one port effect at an async consumer boundary. */
export function runWorktree<A, E>(
	effect: Effect.Effect<A, E, never>,
): Promise<A> {
	return Effect.runPromise(effect);
}

// The one Effect-runtime execution boundary for multiplexer-port consumers
// that are still Promise- or sync-shaped (add-multiplexer-adapters).
//
// The port is Effect-native, but the dashboard observation layer, tab and
// notification synchronization, and Herdr event helper are async/sync
// boundaries. They run port effects through this named composition root
// instead of calling `Effect.runPromise`/`runSync` ad hoc, so the
// source-layer architecture check keeps exactly one execution point per
// consumer boundary.
import { Effect } from "effect";

/** Run one port effect at an async consumer boundary. */
export function runMultiplexer<A, E>(
	effect: Effect.Effect<A, E, never>,
): Promise<A> {
	return Effect.runPromise(effect);
}

/** Run one synchronous port/scope effect at a sync consumer boundary. */
export function runMultiplexerSync<A, E>(
	effect: Effect.Effect<A, E, never>,
): A {
	return Effect.runSync(effect);
}

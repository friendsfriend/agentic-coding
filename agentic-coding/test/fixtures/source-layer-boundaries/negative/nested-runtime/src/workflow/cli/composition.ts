// A named application composition root. Runtime execution here is allowed, so
// the nested-runtime check must not flag this file when it is listed as a
// composition root.
import { Effect } from "effect";

export function runApp<T>(program: Effect.Effect<T, never, never>): void {
	Effect.runFork(program);
}

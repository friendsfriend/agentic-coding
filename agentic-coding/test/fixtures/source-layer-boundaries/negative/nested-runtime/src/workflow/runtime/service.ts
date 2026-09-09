// Guarded workflow service that spins up its own Effect runtime. This is the
// nested-runtime violation the cutover architecture check must reject: only a
// named application composition root may run Effect programs.
import { Effect } from "effect";

export function read<T>(program: Effect.Effect<T, never, never>): T {
	return Effect.runSync(program);
}

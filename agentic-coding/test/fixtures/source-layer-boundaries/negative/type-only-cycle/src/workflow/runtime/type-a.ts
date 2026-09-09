// Negative fixture: a cycle made only of erased type references must NOT be
// reported as a runtime (ESM load-order) cycle.
import type { TypeB } from "./type-b.ts";

export interface TypeA {
	b?: TypeB;
}
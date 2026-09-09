// Negative fixture: pure step behavior that transitively reads the
// filesystem/database through another module must fail with the dependency
// path to the forbidden boundary.
import { stepsShared } from "./pure-b.ts";

export function pureStepA(input: string): string {
	return stepsShared(input);
}
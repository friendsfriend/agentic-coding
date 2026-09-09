// Negative fixture: a value import through a .tsx module closes a runtime
// cycle. The architecture cycle check must report the source dependency path.
import { bSideEffect } from "./b.tsx";

export function aSideEffect(): string {
	bSideEffect();
	return "a";
}
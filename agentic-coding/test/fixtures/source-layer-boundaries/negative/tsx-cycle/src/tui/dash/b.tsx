import { aSideEffect } from "./a.tsx";

export function bSideEffect(): string {
	aSideEffect();
	return "b";
}
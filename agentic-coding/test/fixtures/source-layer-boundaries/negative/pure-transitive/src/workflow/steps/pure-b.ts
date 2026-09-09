import { readRows } from "../runtime/persistence.ts";

export function stepsShared(input: string): string {
	readRows(input);
	return input;
}
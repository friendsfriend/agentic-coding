// Exception-behavior fixture: one exact edge is approved, a different
// forbidden edge must still fail independently.

import { runCli } from "../cli/run.ts";
import { readRows } from "../runtime/persistence.ts";

export function mixedStep(input: string): string {
	readRows(input);
	runCli();
	return input;
}
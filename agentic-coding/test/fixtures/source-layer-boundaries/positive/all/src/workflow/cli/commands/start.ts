// Positive fixture: CLI composition importing the dispatcher and the
// application-operations layers.

import { resolveRepository } from "../../startup.ts";
import { run } from "../run.ts";

export function runStart(repo: string): void {
	resolveRepository(repo);
	run();
}
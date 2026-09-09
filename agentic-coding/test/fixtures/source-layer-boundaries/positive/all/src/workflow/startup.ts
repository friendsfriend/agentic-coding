// Positive fixture: the application-operations layer may compose CLI
// internals (git helper, engine registry) per the declared edges.
import { runGit } from "./cli/git.ts";

export function resolveRepository(repo: string): string {
	return runGit(repo);
}
// Fixture: what stays legal after read-family-traits-instead-of-ids. Family
// traits are read from the pinned definition, the documentation families keep
// their own id checks, and a family id that is *not* compared to a definition
// id (a path segment, a trait value, the selectable-family catalog) is not what
// the guard forbids.
import path from "node:path";

const OPENSPEC_DIR = "openspec";

export function changeFree(traits: { changeArtifacts: string } | undefined) {
	return traits?.changeArtifacts === "none";
}

export function documentationFamily(definitionId: string): boolean {
	return definitionId === "wiki" || definitionId === "research";
}

export function changeRoot(worktree: string, changeId: string): string {
	return path.join(worktree, OPENSPEC_DIR, "changes", changeId);
}

export const FAMILY_CATALOG = ["openspec", "solo", "verify"];

export function selectedFamily(value: string): boolean {
	return FAMILY_CATALOG.includes(value);
}

export function offeredAction(traits: { delivery: string } | undefined) {
	return traits?.delivery === "pull-request" ? "create-pr" : "close";
}

// Canonical configured-project catalog served by the devenv backend
// (`GET /api/projects`) and consumed by workflow creation, history loading,
// telemetry roots and CLI project listing. The stable configured identity is
// deliberately separate from the canonical Git repository (shared by every
// linked worktree) and the active checkout currently used for repository work.

export type ProjectKind = "app" | "library";

export type ProjectAvailability =
	| "available"
	| "missing"
	| "invalid"
	| "unresolved";

export interface ProjectCapabilities {
	openspec: boolean;
}

export interface CatalogProject {
	ident: string;
	displayName: string;
	kind: ProjectKind;
	/** Shared Git repository root; absent when it cannot be resolved. */
	canonicalRoot?: string;
	/** Selected checkout for repository work (may be a linked worktree). */
	activeCheckout?: string;
	available: boolean;
	availability: ProjectAvailability;
	detail?: string;
	capabilities: ProjectCapabilities;
}

export interface ProjectCatalog {
	/** Fingerprint of the projected catalog used to detect configured changes. */
	revision: string;
	projects: CatalogProject[];
}

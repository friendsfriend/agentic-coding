/** Agent-independent inspection boundary. No operation here grants execution authority. */
export interface EnvironmentCatalog {
	list(input: {
		repository?: string;
		offset: number;
		limit: number;
	}): Record<string, unknown>;
	discover(input: {
		repository: string;
		directory: string;
	}): Record<string, unknown>;
}

export class CatalogRefusal extends Error {
	constructor(
		readonly code:
			| "repository-not-authorized"
			| "catalog-unavailable"
			| "discovery-unavailable",
	) {
		super(code);
	}
}

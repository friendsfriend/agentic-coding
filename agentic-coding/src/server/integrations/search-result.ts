// The unified repository-search result the devenv clients expect
// (`packages/devenv/types`), shared by the GitHub and GitLab clients so neither
// provider leaks its own payload shape into the route response.
export interface ProviderSearchResult {
	readonly name: string;
	readonly fullPath: string;
	readonly httpUrl: string;
	readonly defaultBranch: string;
}

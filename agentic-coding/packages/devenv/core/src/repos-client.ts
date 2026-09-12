import type { RepoSearchResult } from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function searchRepos(
	deps: ClientDeps,
	provider: string,
	query: string,
	host?: string,
	signal?: AbortSignal,
): Promise<RepoSearchResult[]> {
	const payload: Record<string, string> = { provider, query };
	if (host) payload.host = host;

	const response = await deps.fetchFn(`${deps.baseUrl}/api/repos/search`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
		signal,
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as RepoSearchResult[];
}

export async function getRepoBranches(
	deps: ClientDeps,
	url: string,
	provider?: string,
): Promise<string[]> {
	const params = new URLSearchParams({ url });
	if (provider) params.append("provider", provider);

	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/repos/branches?${params}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	const data = (await response.json()) as { branches: string[] };
	return data.branches;
}

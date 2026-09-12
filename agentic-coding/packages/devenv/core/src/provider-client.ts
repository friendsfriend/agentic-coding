import type {
	Provider,
	ProviderCreateRequest,
	ProviderUpdateRequest,
} from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function getProviders(deps: ClientDeps): Promise<Provider[]> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/providers`);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Provider[];
}

export async function getProvider(
	deps: ClientDeps,
	name: string,
): Promise<Provider> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/providers/${encodeURIComponent(name)}`,
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Provider;
}

export async function createProvider(
	deps: ClientDeps,
	provider: ProviderCreateRequest,
): Promise<Provider> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/providers`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(provider),
	});

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Provider;
}

export async function updateProvider(
	deps: ClientDeps,
	name: string,
	updates: ProviderUpdateRequest,
): Promise<Provider> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/providers/${encodeURIComponent(name)}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(updates),
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}

	return (await response.json()) as Provider;
}

export async function deleteProvider(
	deps: ClientDeps,
	name: string,
): Promise<void> {
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/providers/${encodeURIComponent(name)}`,
		{
			method: "DELETE",
		},
	);

	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

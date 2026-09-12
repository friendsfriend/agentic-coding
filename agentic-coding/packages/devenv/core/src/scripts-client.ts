import type {
	ExecuteScriptResponse,
	ScriptArgsHistoryResponse,
	ScriptListResponse,
	ScriptMetadataResponse,
	ScriptMutationResponse,
} from "@devenv/types";
import type { ClientDeps } from "./client-types";
import { handleFetchError } from "./error-handler";

export async function getScripts(
	deps: ClientDeps,
): Promise<ScriptListResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts`, {
		method: "GET",
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptListResponse;
}

export async function executeScript(
	deps: ClientDeps,
	relativePath: string,
	args: string[] = [],
): Promise<ExecuteScriptResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ relativePath, args }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ExecuteScriptResponse;
}

export async function createScript(
	deps: ClientDeps,
	targetPath: string,
): Promise<ScriptMutationResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts/create`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ targetPath }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptMutationResponse;
}

export async function linkScript(
	deps: ClientDeps,
	targetPath: string,
	sourcePath: string,
): Promise<ScriptMutationResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts/link`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ targetPath, sourcePath }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptMutationResponse;
}

export async function deleteScript(
	deps: ClientDeps,
	relativePath: string,
): Promise<ScriptMutationResponse> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts/delete`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ relativePath }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptMutationResponse;
}

export async function getScriptArgsHistory(
	deps: ClientDeps,
	relativePath: string,
	limit = 50,
): Promise<ScriptArgsHistoryResponse> {
	const encodedPath = encodeURIComponent(relativePath);
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/scripts/history?relativePath=${encodedPath}&limit=${limit}`,
		{ method: "GET" },
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptArgsHistoryResponse;
}

export async function addScriptArgsHistory(
	deps: ClientDeps,
	relativePath: string,
	values: Record<string, string>,
): Promise<void> {
	const response = await deps.fetchFn(`${deps.baseUrl}/api/scripts/history`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ relativePath, values }),
	});
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
}

export async function getScriptMetadata(
	deps: ClientDeps,
	relativePath: string,
): Promise<ScriptMetadataResponse> {
	const encodedPath = encodeURIComponent(relativePath);
	const response = await deps.fetchFn(
		`${deps.baseUrl}/api/scripts/metadata?path=${encodedPath}`,
		{ method: "GET" },
	);
	if (!response.ok) {
		await handleFetchError(response, deps.onError);
	}
	return (await response.json()) as ScriptMetadataResponse;
}

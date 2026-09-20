// Authenticated read adapters for the read-only Settings sections
// (centralize-application-settings, task 2.4). Every remote read goes through
// the environment client's capability-bearing fetch (`createCustomFetch`,
// `Authorization: Bearer <instance token>`), so a Settings section can never
// reach a server it is not authenticated to and never falls back to a local
// configuration file: an unavailable server is a retryable section error.
//
// Only status fields are decoded. A provider's token is represented by
// `hasToken` and never requested, returned or rendered.
import { createCustomFetch } from "@devenv/core";
import type { CatalogProject } from "@devenv/types";
import { loadProjectCatalog } from "../data/workflow.ts";

export interface ProviderStatus {
	name: string;
	type: string;
	username: string;
	/** Credential presence only — the value is never fetched. */
	hasToken: boolean;
	invalid: boolean;
	problem?: string;
}

export interface ProjectStatusSnapshot {
	revision: string;
	projects: CatalogProject[];
}

function authenticatedFetch(): typeof fetch {
	return createCustomFetch() as typeof fetch;
}

/** Provider status from the connected server; throws on an unavailable server. */
export async function readProviderStatus(
	baseUrl: string,
	signal?: AbortSignal,
): Promise<ProviderStatus[]> {
	const response = await authenticatedFetch()(`${baseUrl}/api/providers`, {
		...(signal ? { signal } : {}),
	});
	if (!response.ok)
		throw new Error(`providers unavailable (${response.status})`);
	const body = (await response.json()) as unknown;
	if (!Array.isArray(body))
		throw new Error("providers response was not a list");
	return body.map((raw) => {
		const entry = (raw ?? {}) as Record<string, unknown>;
		return {
			name: String(entry.name ?? ""),
			type: String(entry.type ?? ""),
			username: typeof entry.username === "string" ? entry.username : "",
			hasToken: entry.has_token === true,
			invalid: entry.invalid === true,
			...(typeof entry.message === "string" && entry.message
				? { problem: entry.message }
				: typeof entry.reason === "string" && entry.reason
					? { problem: entry.reason }
					: {}),
		};
	});
}

/** Configured project catalog from the connected server (or the bounded read
 * when this process owns no environment surface). Throws on failure. */
export async function readProjectStatus(
	options: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<ProjectStatusSnapshot> {
	const catalog = await loadProjectCatalog(options.signal);
	if (!catalog) throw new Error("project catalog read was superseded");
	return { revision: catalog.revision, projects: catalog.projects };
}

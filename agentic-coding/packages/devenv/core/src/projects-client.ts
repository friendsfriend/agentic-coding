import type { ProjectCatalog } from "@devenv/types";
import type { ClientDeps } from "./client-types";

/**
 * Failure fetching the configured-project catalog. `retryable` is true for
 * transport failures and server-side errors; a rejected configuration (for
 * example duplicate identifiers) is reported as a non-retryable diagnostic.
 */
export class ProjectCatalogError extends Error {
	readonly status?: number;
	readonly retryable: boolean;

	constructor(
		message: string,
		options: { status?: number; retryable: boolean },
	) {
		super(message);
		this.name = "ProjectCatalogError";
		this.status = options.status;
		this.retryable = options.retryable;
	}
}

/**
 * Fetch the canonical configured-project catalog. A transport/HTTP failure
 * rejects so callers can distinguish "catalog unavailable" from a valid empty
 * catalog.
 */
export async function getProjectCatalog(
	deps: ClientDeps,
	signal?: AbortSignal,
): Promise<ProjectCatalog> {
	let response: Response;
	try {
		response = await deps.fetchFn(`${deps.baseUrl}/api/projects`, { signal });
	} catch (error) {
		throw new ProjectCatalogError(
			`project catalog request failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ retryable: true },
		);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		deps.onError?.(
			`HTTP ${response.status} Error`,
			body || response.statusText,
		);
		throw new ProjectCatalogError(
			`project catalog request failed (HTTP ${response.status})${
				body ? `: ${body.slice(0, 300)}` : ""
			}`,
			{ status: response.status, retryable: response.status >= 500 },
		);
	}

	return (await response.json()) as ProjectCatalog;
}

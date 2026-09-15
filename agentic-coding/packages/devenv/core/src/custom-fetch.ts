import { getLogger } from "./logger";

/**
 * Custom fetch that uses native fetch (works in separate process)
 * Wrapped with logging for debugging
 *
 * The environment surface is served by the same executable as the workflow
 * surface, so there is only one address and one capability to present:
 *
 *  - `AGENTIC_DEVENV_TOKEN` is the environment surface's instance capability
 *    (set by the shell that owns the server, or by an operator attaching to a
 *    server they started). `AGENTIC_WORKFLOW_TOKEN` is the fallback for the
 *    single-process case, where both surfaces are the same listener.
 */

/** Strip query strings and userinfo so credentials are never written to the
 * on-disk debug log. Only the scheme, host and path are retained. */
export function redactUrl(url: string | URL): string {
	try {
		const parsed = new URL(String(url));
		return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	} catch {
		return String(url).split("?")[0];
	}
}

/** The capability the environment client presents, if any. */
export function environmentToken(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	return env.AGENTIC_DEVENV_TOKEN || env.AGENTIC_WORKFLOW_TOKEN || undefined;
}

export function createCustomFetch(): (
	url: string | URL,
	options?: RequestInit,
) => Promise<Response> {
	return async (
		url: string | URL,
		options?: RequestInit,
	): Promise<Response> => {
		const token = environmentToken();
		const init: RequestInit = token
			? {
					...options,
					headers: {
						...((options?.headers as Record<string, string>) ?? {}),
						authorization: `Bearer ${token}`,
					},
				}
			: (options ?? {});
		const safeUrl = redactUrl(url);
		getLogger().write("DEBUG", `[FETCH] ${safeUrl}`);

		try {
			// Use native fetch - works fine in separate process
			const response = await fetch(url, init);
			getLogger().write("DEBUG", `[FETCH] ${safeUrl} -> ${response.status}`);
			return response;
		} catch (error) {
			getLogger().write("ERROR", `[FETCH] ${safeUrl} failed: ${error}`);
			throw error;
		}
	};
}

/**
 * Custom fetch with SSE support for subscribeToEvents
 */
export function createCustomFetchWithSSE(): (
	url: string | URL,
	options?: RequestInit,
) => Promise<Response> {
	// Use same implementation - native fetch handles SSE
	return createCustomFetch();
}

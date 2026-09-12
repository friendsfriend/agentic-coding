import { getLogger } from "./logger";

/**
 * Custom fetch that uses native fetch (works in separate process)
 * Wrapped with logging for debugging
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

export function createCustomFetch(): (
	url: string | URL,
	options?: RequestInit,
) => Promise<Response> {
	return async (
		url: string | URL,
		options?: RequestInit,
	): Promise<Response> => {
		const safeUrl = redactUrl(url);
		getLogger().write("DEBUG", `[FETCH] ${safeUrl}`);

		try {
			// Use native fetch - works fine in separate process
			const response = await fetch(url, options);
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

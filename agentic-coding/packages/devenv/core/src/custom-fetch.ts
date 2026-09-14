import { getLogger } from "./logger";

/**
 * Custom fetch that uses native fetch (works in separate process)
 * Wrapped with logging for debugging
 *
 * Two unified-backend cutover hooks, both environment-gated so the behaviour is
 * identical when the shell runs the environment feature standalone:
 *
 *  - `AGENTIC_WORKFLOW_TOKEN`: the unified server authenticates every route, so
 *    the environment client presents the shell's instance capability. The token
 *    travels in a header and is never logged (only the redacted URL is).
 *  - `AGENTIC_DEVENV_FORWARD_URL`: while the migrated route families are being
 *    switched to the unified server, the shell points the environment client's
 *    transport at that server. The path and query are preserved, so an unchanged
 *    client reaches the new owner; unset it to roll back to the previous owner.
 *    No request is ever sent to both.
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

/** The origin every environment request is forwarded to, or `undefined` when
 * the environment client talks to its own base URL. */
export function forwardOrigin(
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const target = env.AGENTIC_DEVENV_FORWARD_URL;
	if (!target || target === "") return undefined;
	try {
		return new URL(target).origin;
	} catch {
		return undefined;
	}
}

/** Rewrite one request URL onto the forward origin, keeping path and query. */
export function forwardUrl(url: string | URL, origin: string): string {
	try {
		const parsed = new URL(String(url));
		return `${origin}${parsed.pathname}${parsed.search}`;
	} catch {
		return String(url);
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
		const origin = forwardOrigin();
		const target = origin ? forwardUrl(url, origin) : url;
		const token = process.env.AGENTIC_WORKFLOW_TOKEN;
		const init: RequestInit = token
			? {
					...options,
					headers: {
						...((options?.headers as Record<string, string>) ?? {}),
						authorization: `Bearer ${token}`,
					},
				}
			: (options ?? {});
		const safeUrl = redactUrl(target);
		getLogger().write("DEBUG", `[FETCH] ${safeUrl}`);

		try {
			// Use native fetch - works fine in separate process
			const response = await fetch(target, init);
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

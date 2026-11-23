import { actionListSchema } from "../interface/descriptors.ts";
import { loopbackBaseUrl } from "../transports/http/loopback-url.ts";
import type { UiActionDescriptor, UiCapabilityApi } from "./capability-api.ts";

export { loopbackBaseUrl } from "../transports/http/loopback-url.ts";

export class UiCapabilityError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** Remote implementation of the server-independent UI contract. The OpenTUI and
 * an OpenCode plugin can use this without importing MCP registration or server
 * bootstrap; only the capability interface and this HTTP transport are needed. */
export function createHttpUiCapabilityApi(options: {
	url: string;
	token: string;
	fetch?: typeof fetch;
}): UiCapabilityApi {
	const base = loopbackBaseUrl(options.url);
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token))
		throw new Error("Invalid capability token");
	const request = async (
		route: string,
		signal: AbortSignal,
		init: RequestInit = {},
	) => {
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 180_000);
		let response: Response;
		try {
			response = await (options.fetch ?? fetch)(`${base}${route}`, {
				...init,
				redirect: "error",
				signal: AbortSignal.any([signal, timeout.signal]),
				headers: {
					authorization: `Bearer ${options.token}`,
					...init.headers,
				},
			});
		} finally {
			clearTimeout(timer);
		}
		const text = await response.text();
		if (text.length > 256 * 1024)
			throw new UiCapabilityError("response-too-large");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new UiCapabilityError("invalid-response");
		}
		if (!response.ok) {
			const code =
				typeof body === "object" && body !== null && "error" in body
					? (body as { error?: unknown }).error
					: undefined;
			throw new UiCapabilityError(
				typeof code === "string" ? code : "request-failed",
			);
		}
		return body;
	};
	return {
		async list() {
			const controller = new AbortController();
			const body = actionListSchema.parse(
				await request("/capabilities", controller.signal),
			);
			return body.actions as readonly UiActionDescriptor[];
		},
		async invoke(name, input, invokeOptions) {
			const controller = new AbortController();
			const signal = invokeOptions?.signal
				? AbortSignal.any([invokeOptions.signal, controller.signal])
				: controller.signal;
			const body = await request(
				`/capabilities/${encodeURIComponent(name)}`,
				signal,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(input ?? {}),
				},
			);
			if (
				typeof body !== "object" ||
				body === null ||
				!("result" in body) ||
				typeof body.result !== "object" ||
				body.result === null ||
				Array.isArray(body.result)
			)
				throw new UiCapabilityError("invalid-response");
			return body.result as Record<string, unknown>;
		},
	};
}

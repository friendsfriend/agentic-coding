import { digest, object, text } from "../config.ts";

/** Shared HTTP admission guards. Refusals name the rule, never values. */
export function queryOnly(query: URLSearchParams, allowed: readonly string[]) {
	for (const key of query.keys())
		if (!allowed.includes(key) || query.getAll(key).length !== 1)
			throw new Error("Unknown or repeated query parameter");
}
export function readBody(body: unknown): Record<string, unknown> {
	return object(body);
}
export function exactId(value: unknown, name: string, prefix: string): string {
	const id = text(value, name, 80);
	if (
		!id.startsWith(`${prefix}-`) ||
		!/^[a-z0-9-]+$/.test(id) ||
		id.length > 80
	)
		throw new Error(`Invalid ${name}`);
	return id;
}
/** Bounded server-side fetch: timeout, size cap, no credential echo. With
 * `onTooLarge: "truncate"` the body is cut at the cap and flagged. */
export async function boundedFetch(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit & {
		timeoutMs?: number;
		maxBytes?: number;
		onTooLarge?: "throw" | "truncate";
	},
): Promise<{
	status: number;
	headers: Headers;
	body: string;
	truncated: boolean;
}> {
	const timeoutMs = init.timeoutMs ?? 15000,
		maxBytes = init.maxBytes ?? 65536;
	const controller = new AbortController(),
		timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			...init,
			signal: controller.signal,
		});
		const reader = response.body?.getReader();
		if (!reader)
			return {
				status: response.status,
				headers: response.headers,
				body: "",
				truncated: false,
			};
		const chunks: Uint8Array[] = [];
		let length = 0,
			truncated = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > maxBytes) {
				if (init.onTooLarge === "truncate") {
					truncated = true;
					break;
				}
				throw new Error("Upstream response too large");
			}
			chunks.push(value);
		}
		const body = Buffer.concat(chunks).toString("utf8");
		return {
			status: response.status,
			headers: response.headers,
			body,
			truncated,
		};
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "Upstream response too large"
		)
			throw error;
		throw new Error("Upstream request failed");
	} finally {
		clearTimeout(timer);
	}
}
export function redactSecrets(
	value: string,
	secrets: readonly string[],
): string {
	let out = value;
	for (const secret of secrets)
		if (secret) out = out.split(secret).join("<redacted>");
	return out.slice(0, 4096);
}
export { digest };

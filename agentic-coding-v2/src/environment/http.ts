import { request as httpRequest, STATUS_CODES } from "node:http";
import { request as httpsRequest } from "node:https";
import { localEndpoint } from "./endpoint.ts";
import type { HttpOptions } from "./http-options.ts";

type HttpResponse = {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	bodyFormat: "text" | "omitted";
	bytes: number;
	truncated: boolean;
	url: string;
	transport: "http" | "https-verified";
	method: HttpOptions["method"];
};
const redirects = new Set([301, 302, 303, 307, 308]);
/** One exchange; redirect locations stay private until validated by the bounded caller. */
function exchange(
	address: string,
	options: HttpOptions,
	redact: (value: string) => string,
	signal: AbortSignal,
	ca?: Buffer,
	authorization?: string,
) {
	return new Promise<{ result: HttpResponse; location?: string }>(
		(resolve, reject) => {
			signal.throwIfAborted();
			const url = localEndpoint(address),
				chunks: Buffer[] = [];
			let bytes = 0,
				settled = false;
			const finish = (
				error: boolean,
				result?: HttpResponse,
				location?: string,
			) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				if (error || !result)
					reject(new Error("Local endpoint request failed or was interrupted"));
				else resolve({ result, ...(location ? { location } : {}) });
			};
			const secure = url.protocol === "https:",
				request = secure ? httpsRequest : httpRequest;
			const client = request(
				{
					protocol: url.protocol,
					...(secure
						? {
								rejectUnauthorized: true,
								minVersion: "TLSv1.2" as const,
								...(ca ? { ca } : {}),
							}
						: {}),
					hostname: url.hostname.replace(/^\[|\]$/g, ""),
					port: url.port || (secure ? 443 : 80),
					path: `${url.pathname}${url.search}`,
					method: options.method,
					agent: false,
					maxHeaderSize: 16384,
					headers: {
						accept: "application/json, text/plain, */*",
						...options.headers,
						...(authorization ? { authorization } : {}),
					},
				},
				(response) => {
					response.on("error", () => finish(true));
					response.on("aborted", () => finish(true));
					const headers: Record<string, string> = {};
					for (const name of ["content-type", "content-length", "location"]) {
						const value = response.headers[name];
						if (typeof value === "string")
							headers[name] = redact(value).slice(0, 512);
					}
					let truncated = false;
					const result = (
						body: string,
						bodyFormat: HttpResponse["bodyFormat"],
					): HttpResponse => ({
						status: response.statusCode ?? 0,
						statusText: STATUS_CODES[response.statusCode ?? 0] ?? "",
						headers,
						body,
						bodyFormat,
						bytes,
						truncated,
						url: redact(url.href).slice(0, 2048),
						transport: secure ? "https-verified" : "http",
						method: options.method,
					});
					if (
						options.followRedirects &&
						redirects.has(response.statusCode ?? 0) &&
						response.headers.location
					) {
						finish(
							false,
							result("[redirect response body omitted]", "omitted"),
							response.headers.location,
						);
						response.destroy();
						return;
					}
					const done = () => {
						if (settled) return;
						const text =
								/^(text\/|application\/(?:[\w.+-]*\+)?(?:json|xml)(?:;|$))/i.test(
									String(response.headers["content-type"] ?? ""),
								) && !response.headers["content-encoding"],
							raw = Buffer.concat(chunks).toString("utf8"),
							complete = truncated
								? raw.slice(0, raw.lastIndexOf("\n") + 1)
								: raw;
						let body = text
							? `${redact(complete)}${truncated ? "\n[incomplete final line omitted at source cap]" : ""}`
							: "[non-text or encoded response omitted]";
						if (JSON.stringify(body).length > 24000) {
							body = `${body.slice(0, 3990)}\n[truncated]`;
							truncated = true;
						}
						finish(false, result(body, text ? "text" : "omitted"));
					};
					response.on("data", (chunk: Buffer) => {
						if (settled) return;
						const remaining = 65536 - bytes;
						chunks.push(chunk.subarray(0, remaining));
						bytes += Math.min(chunk.length, remaining);
						if (chunk.length > remaining) {
							truncated = true;
							done();
							response.destroy();
						}
					});
					response.on("end", done);
				},
			);
			const abort = () => {
				client.destroy();
				finish(true);
			};
			const timer = setTimeout(abort, 10000);
			signal.addEventListener("abort", abort, { once: true });
			client.on("error", () => finish(true));
			if (signal.aborted) abort();
			else client.end(options.body);
		},
	);
}
/** Ten seconds for the entire same-origin chain, never a new timeout per redirect. */
export async function endpointRequest(
	address: string,
	options: HttpOptions,
	redact: (value: string) => string,
	signal?: AbortSignal,
	ca?: Buffer,
	authorization?: string,
	beforeRequest?: () => Promise<Buffer | undefined>,
	beforeSend?: () => void,
) {
	const origin = localEndpoint(address).origin;
	const controller = new AbortController(),
		abort = () => controller.abort(),
		timer = setTimeout(abort, 10000);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const history: Array<{ status: number; method: string; url: string }> = [];
	let current = address,
		next = options;
	try {
		for (;;) {
			controller.signal.throwIfAborted();
			const trust = beforeRequest ? await beforeRequest() : ca;
			controller.signal.throwIfAborted();
			beforeSend?.();
			const { result, location } = await exchange(
				current,
				next,
				redact,
				controller.signal,
				trust,
				authorization,
			);
			if (!location) return { ...result, redirects: history };
			if (history.length >= 3)
				throw new Error("Endpoint redirect limit exceeded");
			let destination: URL;
			try {
				if (location.length > 4096) throw new Error();
				destination = localEndpoint(new URL(location, current).href);
			} catch {
				throw new Error("Endpoint redirect is not a valid local URL");
			}
			if (destination.origin !== origin)
				throw new Error("Endpoint redirect cannot leave the approved origin");
			destination.hash = "";
			history.push({
				status: result.status,
				method: result.method,
				url: redact(current).slice(0, 512),
			});
			if (
				(result.status === 303 && next.method !== "HEAD") ||
				([301, 302].includes(result.status) && next.method === "POST")
			) {
				const { "content-type": _contentType, ...headers } = next.headers;
				next = { ...next, method: "GET", body: undefined, headers };
			}
			current = destination.href;
		}
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

// The HTTP call behind `http_request` (`add-agent-debug-tools`).
//
// The caller names an app endpoint the workflow holds (the route resolves it) and
// this module makes one call to it: the method is from a fixed set, the request
// body is bounded, the response is read incrementally and stopped at the cap
// instead of being buffered whole, and the header values that are credentials by
// definition (`authorization`, `set-cookie`, `cookie`) are replaced before the
// answer leaves the process. The route also runs the shared environment
// redactor over the result, so a declared secret cannot travel back either.
/** The response-body cap: what one call may hand to the model. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** The request-body cap. */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
/** Headers one call may send, and one value's bound. */
export const MAX_HEADER_COUNT = 32;
export const MAX_HEADER_CHARS = 4096;
/** How long one call may take. */
export const HTTP_TIMEOUT_MS = 30_000;
/** The methods a call may use: a read tool that also probes writes, bounded by
 * the endpoint's own authorization. */
export const HTTP_METHODS = [
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Header values that are credentials by definition, whatever the app does. */
const REDACTED_HEADERS = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
]);

/** A refusal the route answers with its own status instead of a 500. */
export class HttpRequestError extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "HttpRequestError";
		this.code = code;
		this.status = status;
	}
}

export interface HttpHeader {
	readonly name: string;
	readonly value: string;
}

export interface HttpCallResult {
	readonly status: number;
	readonly statusText: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly bytes: number;
	readonly truncated: boolean;
	readonly url: string;
}

/**
 * The target URL of one call: the endpoint the workflow holds, plus the
 * caller's path. The path may not leave the endpoint's own origin — a
 * protocol-relative or absolute path would turn a call to this workflow's app
 * into a call to somewhere else.
 */
export function endpointUrl(base: string, path: string | undefined): string {
	const origin = new URL(base);
	if (path === undefined || path.trim() === "") return origin.toString();
	const candidate = path.trim();
	for (let index = 0; index < candidate.length; index++) {
		const code = candidate.charCodeAt(index);
		if (code < 0x20 || code === 0x7f)
			throw new HttpRequestError(
				"invalid-path",
				"path must not contain control characters",
			);
	}
	const target = new URL(
		candidate.startsWith("/") ? candidate : `/${candidate}`,
		origin,
	);
	if (target.origin !== origin.origin)
		throw new HttpRequestError(
			"invalid-path",
			`path ${JSON.stringify(path)} leaves the endpoint's origin`,
		);
	return target.toString();
}

function method(value: string | undefined): HttpMethod {
	const upper = (value ?? "GET").trim().toUpperCase();
	if (!(HTTP_METHODS as readonly string[]).includes(upper))
		throw new HttpRequestError(
			"invalid-method",
			`method must be one of ${HTTP_METHODS.join(", ")}, received ${JSON.stringify(value)}`,
		);
	return upper as HttpMethod;
}

function headersOf(headers: readonly HttpHeader[] | undefined): Headers {
	const out = new Headers();
	if (!headers) return out;
	if (headers.length > MAX_HEADER_COUNT)
		throw new HttpRequestError(
			"too-many-headers",
			`at most ${MAX_HEADER_COUNT} headers are accepted, received ${headers.length}`,
		);
	for (const header of headers) {
		if (header.value.length > MAX_HEADER_CHARS)
			throw new HttpRequestError(
				"header-too-long",
				`header ${JSON.stringify(header.name)} is longer than ${MAX_HEADER_CHARS} characters`,
			);
		out.set(header.name, header.value);
	}
	return out;
}

/** The response headers, with the credential-bearing values replaced. */
function responseHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of headers) {
		out[name] = REDACTED_HEADERS.has(name.toLowerCase())
			? `«redacted:${name.toLowerCase()}»`
			: value.length > MAX_HEADER_CHARS
				? `${value.slice(0, MAX_HEADER_CHARS)}…`
				: value;
	}
	return out;
}

/**
 * Read at most `max` bytes of a response body, stopping (and cancelling) as soon
 * as the cap is reached: the answer is bounded while it is being read, not after
 * it has been buffered.
 */
async function readBounded(
	response: Response,
	max: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
	const stream = response.body;
	if (!stream) return { text: "", bytes: 0, truncated: false };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	let truncated = false;
	for (;;) {
		const next = await reader.read();
		if (next.done) break;
		const chunk = next.value;
		bytes += chunk.byteLength;
		if (bytes > max) {
			chunks.push(
				chunk.slice(0, Math.max(0, max - (bytes - chunk.byteLength))),
			);
			truncated = true;
			await reader.cancel().catch(() => undefined);
			break;
		}
		chunks.push(chunk);
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const buffer = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		text: new TextDecoder().decode(buffer),
		bytes: total,
		truncated,
	};
}

/** One bounded call to an endpoint the caller already holds. */
export async function callEndpoint(input: {
	readonly url: string;
	readonly method?: string;
	readonly headers?: readonly HttpHeader[];
	readonly body?: string;
	readonly timeoutMs?: number;
	readonly send?: typeof fetch;
}): Promise<HttpCallResult> {
	const verb = method(input.method);
	const body = input.body;
	if (body !== undefined && body.length > MAX_REQUEST_BODY_BYTES)
		throw new HttpRequestError(
			"body-too-large",
			`body is longer than ${MAX_REQUEST_BODY_BYTES} characters`,
		);
	if (body !== undefined && (verb === "GET" || verb === "HEAD"))
		throw new HttpRequestError(
			"body-not-allowed",
			`${verb} does not carry a request body`,
		);
	const send = input.send ?? fetch;
	const response = await send(input.url, {
		method: verb,
		headers: headersOf(input.headers),
		...(body === undefined ? {} : { body }),
		signal: AbortSignal.timeout(input.timeoutMs ?? HTTP_TIMEOUT_MS),
		redirect: "manual",
	});
	const read = await readBounded(response, MAX_RESPONSE_BYTES);
	return {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders(response.headers),
		body: read.text,
		bytes: read.bytes,
		truncated: read.truncated,
		url: response.url === "" ? input.url : response.url,
	};
}

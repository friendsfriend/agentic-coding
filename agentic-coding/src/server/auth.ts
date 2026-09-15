// Instance authorization and bounded request guards for the unified backend
// (expose-unified-bun-backend, task 1.3/1.4). Loopback binding is the default
// but is never treated as authorization: every request carries a per-instance
// bearer token, browser origins are restricted to loopback, and bodies/paths
// are bounded before any handler sees them.
//
// The token is generated once per server instance and handed to the owning
// TUI/CLI over an inherited descriptor or environment variable — never a URL,
// never a log line, never an event payload.
import { timingSafeEqual } from "node:crypto";
import { MAX_PATH_CHARS, MAX_REQUEST_BYTES } from "./protocol.ts";

export class AuthorizationError extends Error {
	constructor(
		readonly status: number,
		readonly reason: string,
	) {
		super(reason);
	}
}

export class PayloadBoundError extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

export interface InstanceAuthority {
	readonly instance: string;
	readonly token: string;
}

/** A fresh per-instance identity + capability token. A caller that has already
 * exported a capability (the shell hands one to its environment client before
 * the listener exists) passes it in instead of receiving a second one. */
export function createInstanceAuthority(
	instance = crypto.randomUUID().replaceAll("-", ""),
	token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	),
): InstanceAuthority {
	return { instance, token };
}

function constantTimeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Routes whose authorization is a capability carried in the path rather than
 * the instance token.
 *
 * The change-request review callback is the only one: the spawned review agent
 * runs `curl` against a URL it was given and must not be handed the instance
 * capability (it would leak into the agent's prompt, transcript and history).
 * Its authorization is the 128-bit, single-review, short-lived token that the
 * stream registers and revokes, and the handler still validates that token,
 * the method, the body bounds and the browser origin. Every other route keeps
 * requiring the instance bearer token.
 */
export function isSessionAuthorizedRoute(
	method: string,
	pathname: string,
): boolean {
	if (method.toUpperCase() !== "POST") return false;
	const prefix = "/api/ai/cr-comment-callback/";
	return pathname.startsWith(prefix) && pathname.length > prefix.length;
}

/**
 * Routes answered without the instance token.
 *
 * `GET /api/health` is the liveness/identity probe every client, launcher and
 * operator uses; it reports the instance id and the environment roots but no
 * secret, exactly as the retired backend's health route did. It is a single
 * exact path, not a prefix, so no other surface is reachable unauthenticated.
 */
export function isPublicRoute(method: string, pathname: string): boolean {
	if (method.toUpperCase() !== "GET") return false;
	return pathname === "/api/health";
}

/** `http://127.0.0.1:*`, `http://[::1]:*` and `localhost` are the only
 * browser origins allowed. A missing Origin (CLI/native client) is not a
 * browser and passes; any other origin is rejected before routing. */
export function originAllowed(origin: string | null): boolean {
	if (origin === null || origin === "") return true;
	let host: string;
	try {
		host = new URL(origin).hostname;
	} catch {
		return false;
	}
	return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Authorize a request against the instance authority. Throws
 * `AuthorizationError` for a missing/forged token or an untrusted origin. */
export function authorizeRequest(
	request: Request,
	authority: InstanceAuthority,
): void {
	if (!originAllowed(request.headers.get("origin")))
		throw new AuthorizationError(403, "untrusted origin");
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer "))
		throw new AuthorizationError(401, "missing instance capability");
	const supplied = header.slice("Bearer ".length).trim();
	if (!constantTimeEqual(supplied, authority.token))
		throw new AuthorizationError(401, "invalid instance capability");
}

/** A textual path/argument must be bounded and free of control characters so
 * it can never smuggle a second line into a diagnostic or a shell boundary. */
export function assertBoundedText(label: string, value: string): void {
	if (value.length > MAX_PATH_CHARS)
		throw new PayloadBoundError(
			`${label} exceeds ${MAX_PATH_CHARS} characters`,
		);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters
	if (/[\x00-\x1f\x7f]/.test(value))
		throw new PayloadBoundError(`${label} contains control characters`);
}

/** Read a request body up to `limit` bytes; reject (413) rather than buffer an
 * unbounded payload. */
export async function readBoundedBody(
	request: Request,
	limit = MAX_REQUEST_BYTES,
): Promise<string> {
	const declared = request.headers.get("content-length");
	if (declared !== null) {
		const size = Number(declared);
		if (!Number.isFinite(size) || size < 0)
			throw new PayloadBoundError("invalid content-length");
		if (size > limit) throw new PayloadBoundError("request body is too large");
	}
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			total += part.value.byteLength;
			if (total > limit)
				throw new PayloadBoundError("request body is too large");
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
		"utf8",
	);
}

/** Parse a bounded JSON request body. */
export async function readJsonBody(
	request: Request,
	limit = MAX_REQUEST_BYTES,
): Promise<unknown> {
	const text = await readBoundedBody(request, limit);
	if (!text.trim()) return {};
	try {
		return JSON.parse(text);
	} catch {
		throw new PayloadBoundError("request body is not valid JSON");
	}
}

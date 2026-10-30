// Instance authorization and bounded request guards for the unified backend
// (expose-unified-bun-backend, task 1.3/1.4). Loopback binding is the default
// but is never treated as authorization: every request carries a per-instance
// bearer token, browser origins are restricted to loopback, and bodies/paths
// are bounded before any handler sees them.
//
// The token is generated once per server instance and handed to the owning
// TUI/CLI over an inherited descriptor, environment variable, or mode-0600
// loopback handoff file — never a URL, log line, or event payload.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OrchestratorDeveloperInput } from "../contracts/orchestrator-input.ts";
import type { WorkflowPrincipal } from "../contracts/workflow.ts";
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

/** Loopback clients can reread current capability after server restart. The
 * file is mode 0600 and replaced atomically; it is a handoff mechanism, not an
 * authorization bypass. */
export function instanceTokenFile(port: number): string {
	const owner =
		typeof process.getuid === "function"
			? String(process.getuid())
			: (process.env.USER ?? "user");
	return path.join(os.tmpdir(), `agentic-coding-${owner}-${port}.token`);
}

export function instanceTokenFileForUrl(baseUrl: string): string | undefined {
	try {
		const url = new URL(baseUrl);
		if (
			url.hostname !== "127.0.0.1" &&
			url.hostname !== "localhost" &&
			url.hostname !== "[::1]" &&
			url.hostname !== "::1"
		)
			return undefined;
		const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
		return Number.isInteger(port) && port > 0 && port <= 65535
			? instanceTokenFile(port)
			: undefined;
	} catch {
		return undefined;
	}
}

export function readInstanceTokenFile(file: string): string | undefined {
	try {
		const token = fs.readFileSync(file, "utf8").trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

export function publishInstanceToken(file: string, token: string): void {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		try {
			fs.unlinkSync(temporary);
		} catch {}
	}
}

export function removeInstanceToken(file: string, token: string): void {
	if (readInstanceTokenFile(file) !== token) return;
	try {
		fs.unlinkSync(file);
	} catch {}
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

/** Who a request authenticates as. `operator` holds the instance token (the
 * TUI, the CLI, managed agents); `orchestrator` holds the narrower capability
 * derived from it for the Home Orchestrator session, which the server confines
 * to its route/action policy (`orchestrator-policy.ts`). The one principal
 * union lives with the workflow contract, which records it on the events and
 * metadata it attributes. */
export type Principal = WorkflowPrincipal;

/** The orchestrator capability for an instance token: an HMAC of the instance
 * token, so any holder of the instance token can hand it out, the server can
 * verify it without new state, and its holder cannot recover the instance
 * token from it. */
export function orchestratorTokenFor(instanceToken: string): string {
	return createHmac("sha256", instanceToken)
		.update("agentic-coding:orchestrator:v1")
		.digest("hex");
}

/** Mint a conversation capability only at the operator bootstrap after
 * the host has returned its durable identity. The instance-wide orchestrator
 * token cannot derive it. Its authenticated payload, not caller JSON, names
 * the conversation a clarification mutation may act for. */
export interface OrchestratorConversationIdentity {
	readonly hostId: string;
	readonly conversationId: string;
}

function developerInputPayload(input: OrchestratorDeveloperInput): string {
	return JSON.stringify([
		input.hostId,
		input.conversationId,
		input.runId,
		input.requestId,
		input.text,
		input.whenBusy,
		input.expiresAt,
	]);
}

/** Operator-only signing domain. A scoped/shared orchestrator token cannot
 * mint a valid proof, even if it runs this same public signing function. */
export function orchestratorDeveloperInputProofFor(
	instanceToken: string,
	input: OrchestratorDeveloperInput,
): string {
	return createHmac("sha256", instanceToken)
		.update(`agentic-coding:developer-input:v1:${developerInputPayload(input)}`)
		.digest("hex");
}

export function verifyOrchestratorDeveloperInputProof(
	authority: InstanceAuthority,
	identity: OrchestratorConversationIdentity,
	input: OrchestratorDeveloperInput,
	proof: string,
	now = Date.now(),
): boolean {
	return (
		input.hostId === identity.hostId &&
		input.conversationId === identity.conversationId &&
		input.expiresAt > now &&
		input.expiresAt <= now + 120_000 &&
		/^[0-9a-f]{64}$/.test(proof) &&
		constantTimeEqual(
			proof,
			orchestratorDeveloperInputProofFor(authority.token, input),
		)
	);
}

function validConversationPart(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.trim().length > 0 &&
		Buffer.byteLength(value) <= 256 &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: capability identity must not contain control characters
		!/[\x00-\x1f\x7f]/.test(value)
	);
}

export function orchestratorConversationTokenFor(
	instanceToken: string,
	identity: OrchestratorConversationIdentity,
): string {
	if (
		!validConversationPart(identity.hostId) ||
		!validConversationPart(identity.conversationId)
	)
		throw new AuthorizationError(
			400,
			"invalid orchestrator conversation identity",
		);
	const payload = Buffer.from(
		JSON.stringify([identity.hostId, identity.conversationId]),
	).toString("base64url");
	const signature = createHmac("sha256", instanceToken)
		.update(`agentic-coding:orchestrator-conversation:v1:${payload}`)
		.digest("hex");
	return `oc1.${payload}.${signature}`;
}

function conversationIdentityForToken(
	supplied: string,
	authority: InstanceAuthority,
): OrchestratorConversationIdentity | undefined {
	if (supplied.length > 2048 || !supplied.startsWith("oc1.")) return undefined;
	const parts = supplied.split(".");
	if (parts.length !== 3 || !parts[1]) return undefined;
	try {
		const decoded: unknown = JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		);
		if (
			!Array.isArray(decoded) ||
			decoded.length !== 2 ||
			!validConversationPart(decoded[0]) ||
			!validConversationPart(decoded[1])
		)
			return undefined;
		const identity = { hostId: decoded[0], conversationId: decoded[1] };
		return constantTimeEqual(
			supplied,
			orchestratorConversationTokenFor(authority.token, identity),
		)
			? identity
			: undefined;
	} catch {
		return undefined;
	}
}

/** Optional identity for compatibility reads/starts: shared capabilities do
 * not imply custody. Mutation boundaries use the mandatory authorizer below. */
export function orchestratorConversationFor(
	request: Request,
	authority: InstanceAuthority,
): OrchestratorConversationIdentity | undefined {
	if (!originAllowed(request.headers.get("origin")))
		throw new AuthorizationError(403, "untrusted origin");
	const header = request.headers.get("authorization") ?? "";
	return header.startsWith("Bearer ")
		? conversationIdentityForToken(header.slice(7).trim(), authority)
		: undefined;
}

/** Deliberately rejects operator and shared capabilities: neither supplies a
 * calling conversation. */
export function authorizeOrchestratorConversation(
	request: Request,
	authority: InstanceAuthority,
): OrchestratorConversationIdentity {
	const identity = orchestratorConversationFor(request, authority);
	if (!identity)
		throw new AuthorizationError(
			401,
			"missing or invalid orchestrator conversation capability",
		);
	return identity;
}

/** Header naming the owner an agent environment capability was minted for. The
 * owner is not a claim the wire may choose: the server recomputes the
 * capability for the named owner and refuses a request whose token does not
 * match, so a run can never speak for another workflow. */
export const ENVIRONMENT_OWNER_HEADER = "x-agentic-env-owner";

/** The agent environment capability for one owner: an HMAC of the instance
 * token bound to that owner. Every run of a workflow receives this (never the
 * instance token), and the server derives the owner from the pair, so a
 * request can only act on the owner's own apps. */
export function environmentTokenFor(
	instanceToken: string,
	owner: string,
): string {
	return createHmac("sha256", instanceToken)
		.update(`agentic-coding:environment:v1:${owner}`)
		.digest("hex");
}

/** The owner form an environment capability may name. Deliberately narrower
 * than `parseEnvironmentOwner`: an agent capability is always a workflow's. */
function isEnvironmentOwner(value: string): boolean {
	if (value.length > 512) return false;
	if (!value.startsWith("workflow:")) return false;
	const id = value.slice("workflow:".length);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in a header value
	return id.trim() !== "" && !/[\x00-\x1f\x7f]/.test(value);
}

/** Authorize an agent environment request and name the owner it acts as.
 * Workflow capabilities act only as their bound workflow; the orchestrator
 * capability acts only as the developer's user environment, not as operator.
 * Throws `AuthorizationError` for a missing/forged capability, an owner the
 * capability was not minted for, or an untrusted origin. */
export function authorizeEnvironmentRequest(
	request: Request,
	authority: InstanceAuthority,
): string {
	if (!originAllowed(request.headers.get("origin")))
		throw new AuthorizationError(403, "untrusted origin");
	const owner = (request.headers.get(ENVIRONMENT_OWNER_HEADER) ?? "").trim();
	if (owner !== "user" && !isEnvironmentOwner(owner))
		throw new AuthorizationError(
			401,
			"missing or invalid agent environment owner",
		);
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer "))
		throw new AuthorizationError(401, "missing agent environment capability");
	const supplied = header.slice("Bearer ".length).trim();
	// The Home Orchestrator shares the developer's environment, never a
	// workflow's lease or the operator's review/release authority.
	if (owner === "user") {
		if (
			constantTimeEqual(supplied, orchestratorTokenFor(authority.token)) ||
			conversationIdentityForToken(supplied, authority)
		)
			return owner;
		throw new AuthorizationError(401, "invalid agent environment capability");
	}

	if (!constantTimeEqual(supplied, environmentTokenFor(authority.token, owner)))
		throw new AuthorizationError(401, "invalid agent environment capability");
	return owner;
}

/** Authorize a request against the instance authority and name the principal
 * it authenticated as. Throws `AuthorizationError` for a missing/forged token
 * or an untrusted origin. */
export function authorizeRequest(
	request: Request,
	authority: InstanceAuthority,
): Principal {
	if (!originAllowed(request.headers.get("origin")))
		throw new AuthorizationError(403, "untrusted origin");
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer "))
		throw new AuthorizationError(401, "missing instance capability");
	const supplied = header.slice("Bearer ".length).trim();
	if (constantTimeEqual(supplied, authority.token)) return "operator";
	if (
		constantTimeEqual(supplied, orchestratorTokenFor(authority.token)) ||
		conversationIdentityForToken(supplied, authority)
	)
		return "orchestrator";
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

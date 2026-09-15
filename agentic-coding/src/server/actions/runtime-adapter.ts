// Private container/Kubernetes operation adapter
// (`port-action-execution-to-bun`, task 4.1).
//
// The runtime capabilities that are still Go-owned (Docker API container
// lifecycle, Kubernetes cluster cleanup) are reached through one bounded
// envelope. The contract is narrow on purpose:
//
//   - **Bun owns the run.** The request carries the run/step/command identity;
//     the adapter returns what the operation produced. It allocates no run tree,
//     writes no history and never reports a step outcome.
//   - **The operation set is closed.** A literal name, never a shell string,
//     never SQL and never a credential.
//   - **Cancellation propagates** and a late result is rejected: a response that
//     arrives after the caller cancelled (or after ownership changed) never
//     publishes under the new owner.
import type { RuntimeOperationDispatch } from "./routes.ts";

export const RUNTIME_OPERATION_PATH =
	"/api/v1/actions/private/runtime-operation";

/** Every operation the adapter accepts. */
export const RUNTIME_OPERATIONS = [
	"docker.container.start",
	"docker.container.stop",
	"docker.container.restart",
	"kubernetes.cluster.refresh",
] as const;

export type RuntimeOperation = (typeof RUNTIME_OPERATIONS)[number];

export interface RuntimeAdapterOptions {
	/** Base URL of the private Go child. */
	readonly baseUrl: string | (() => string | undefined);
	readonly token?: string | (() => string | undefined);
	/** Bounded response size; a runtime listing can be large but not unbounded. */
	readonly maxResponseBytes?: number;
	readonly fetch?: typeof fetch;
	/** Injectable clock for tests. */
	readonly now?: () => number;
}

/**
 * A result that arrived after the caller was no longer the owner. The engine
 * never sees it: the dispatch resolves the *current* call and drops the stale
 * one, so a cancelled or superseded operation cannot publish.
 */
export class LateRuntimeResultError extends Error {
	constructor(operation: string) {
		super(`runtime operation ${operation} returned after its owner changed`);
		this.name = "LateRuntimeResultError";
	}
}

export function createRuntimeAdapter(
	options: RuntimeAdapterOptions,
): RuntimeOperationDispatch {
	const baseUrlOf = (): string | undefined =>
		typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl;
	const tokenOf = (): string | undefined =>
		typeof options.token === "function" ? options.token() : options.token;
	const doFetch = options.fetch ?? fetch;
	const maxBytes = options.maxResponseBytes ?? 1024 * 1024;

	return {
		async execute(request) {
			const baseUrl = baseUrlOf();
			if (!baseUrl) {
				return {
					ok: false,
					output: "",
					error: "no private runtime backend is attached",
				};
			}
			if (!isKnownOperation(request.operation)) {
				return {
					ok: false,
					output: "",
					error: `unsupported runtime operation ${JSON.stringify(request.operation)}`,
				};
			}
			if (request.signal.aborted) {
				return { ok: false, output: "", error: "operation canceled" };
			}
			const target = new URL(RUNTIME_OPERATION_PATH, baseUrl);
			const headers = new Headers({ "content-type": "application/json" });
			const token = tokenOf();
			if (token) headers.set("x-instance-token", token);
			let response: Response;
			try {
				response = await doFetch(target, {
					method: "POST",
					headers,
					body: JSON.stringify({
						operation: request.operation,
						...(request.containerId
							? { containerId: request.containerId }
							: {}),
						...(request.parameters ? { parameters: request.parameters } : {}),
						// Identity is passed through so the Go side can log which run
						// asked; it must not allocate a run of its own.
						owner: request.owner,
					}),
					signal: request.signal,
				});
			} catch (error) {
				if (request.signal.aborted) {
					return { ok: false, output: "", error: "operation canceled" };
				}
				return {
					ok: false,
					output: "",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			// Ownership is re-checked after the await: a result that arrives once
			// the caller aborted never publishes.
			if (request.signal.aborted) {
				throw new LateRuntimeResultError(request.operation);
			}
			const buffer = await response.arrayBuffer();
			if (buffer.byteLength > maxBytes) {
				return {
					ok: false,
					output: "",
					error: "runtime response exceeded the bound",
				};
			}
			const text = new TextDecoder().decode(buffer);
			if (!response.ok) {
				return {
					ok: false,
					output: text,
					error: `runtime operation failed with ${response.status}`,
				};
			}
			let decoded: { ok?: boolean; output?: unknown; error?: unknown };
			try {
				decoded = JSON.parse(text) as typeof decoded;
			} catch {
				return { ok: false, output: text, error: "invalid runtime response" };
			}
			return {
				ok: decoded.ok === true,
				output: typeof decoded.output === "string" ? decoded.output : "",
				...(typeof decoded.error === "string" && decoded.error !== ""
					? { error: decoded.error }
					: {}),
			};
		},
	};
}

export function isKnownOperation(
	operation: string,
): operation is RuntimeOperation {
	return (RUNTIME_OPERATIONS as readonly string[]).includes(operation);
}

/** The envelope the Go child decodes; a closed set with no free-form fields. */
export interface RuntimeOperationRequest {
	operation: RuntimeOperation;
	containerId?: string;
	parameters?: Record<string, unknown>;
	owner: { runId: string; stepId: string; commandId: string };
}

/**
 * Validates a decoded request. Excess fields, an unknown operation, a
 * non-identifier container and an owner identity that is not exactly one of the
 * three ids are rejected, so a malformed envelope never reaches a runtime.
 */
export function decodeRuntimeOperationRequest(
	raw: unknown,
): RuntimeOperationRequest {
	if (!isRecord(raw)) throw new Error("invalid runtime operation request");
	for (const key of Object.keys(raw)) {
		if (!["operation", "containerId", "parameters", "owner"].includes(key)) {
			throw new Error(`unexpected field ${JSON.stringify(key)}`);
		}
	}
	const operation = raw.operation;
	if (typeof operation !== "string" || !isKnownOperation(operation)) {
		throw new Error("unsupported runtime operation");
	}
	const containerId = raw.containerId;
	if (containerId !== undefined) {
		if (
			typeof containerId !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(containerId)
		) {
			throw new Error("invalid containerId");
		}
	}
	const owner = raw.owner;
	if (!isRecord(owner)) throw new Error("owner identity is required");
	for (const key of Object.keys(owner)) {
		if (!["runId", "stepId", "commandId"].includes(key)) {
			throw new Error(`unexpected owner field ${JSON.stringify(key)}`);
		}
	}
	const ownerIdentity = {
		runId: identifier(owner.runId, "runId"),
		stepId: identifier(owner.stepId, "stepId"),
		commandId: identifier(owner.commandId, "commandId"),
	};
	return {
		operation,
		...(containerId === undefined ? {} : { containerId }),
		...(isRecord(raw.parameters) ? { parameters: raw.parameters } : {}),
		owner: ownerIdentity,
	};
}

function identifier(value: unknown, name: string): string {
	if (typeof value !== "string" || value === "" || value.length > 256) {
		throw new Error(`invalid ${name}`);
	}
	if (value.includes("\n") || value.includes("\u0000")) {
		throw new Error(`invalid ${name}`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

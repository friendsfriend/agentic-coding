// Private control protocol between the durable agent host and its clients
// (the workflow engine adapter and the dashboard session view). Newline-
// delimited JSON over a Unix socket (durable-agent-host spec, D3). Pure types
// and framing only: no pi-durable or node:net import here, so this module is
// safe for the workflow/dashboard layers to depend on directly.

/** Wire protocol version. A client whose `hello` names a different version is
 * refused rather than guessing compatibility. */
export const PROTOCOL_VERSION = 1;

/** Frames above this size are rejected before they are parsed, so a runaway
 * client cannot exhaust the host's memory one line at a time. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** `orchestrator` is served only by a host opened in orchestrator mode: the
 * `read` tool plus the orchestrator's workflow tools, no shell, no writes. */
export type ToolPolicy = "default" | "read-only" | "orchestrator";

export interface EnsureRunRequest {
	readonly type: "ensureRun";
	readonly runId: string;
	readonly cwd: string;
	readonly runEnvPath: string;
	/** The engine's canonical agent name (`canonicalAgentName`): the same
	 * identity the pane-based adapters already reuse to find a live agent
	 * across rounds, so the durable host reuses one conversation per name
	 * instead of inventing a second persistence key. */
	readonly name: string;
	readonly toolPolicy: ToolPolicy;
	readonly model?: string;
	readonly thinking?: string;
}
export interface SubmitRequest {
	readonly type: "submit";
	readonly runId: string;
	readonly text: string;
	readonly requestId: string;
	readonly whenBusy?: "steer" | "followUp";
}
export interface StatusRequest {
	readonly type: "status";
	readonly runId: string;
}
/** Live model / thinking override for one run (dashboard \`/model\` and
 * \`/thinking\`). Both fields are the same string forms \`ensureRun\` uses. */
export interface ConfigureRunRequest {
	readonly type: "configureRun";
	readonly runId: string;
	readonly model?: string;
	readonly thinking?: string;
}
/** The models and thinking levels this host can run. */
export interface CatalogRequest {
	readonly type: "catalog";
}
export interface AbortRequest {
	readonly type: "abort";
	readonly runId: string;
}
export interface StopRunRequest {
	readonly type: "stopRun";
	readonly runId: string;
}
export interface ShutdownRequest {
	readonly type: "shutdown";
}
export interface WatchRequest {
	readonly type: "watch";
	readonly runId: string;
}
export interface HelloRequest {
	readonly type: "hello";
	readonly protocolVersion: number;
}
export type HostRequest =
	| HelloRequest
	| EnsureRunRequest
	| SubmitRequest
	| StatusRequest
	| ConfigureRunRequest
	| CatalogRequest
	| AbortRequest
	| StopRunRequest
	| ShutdownRequest
	| WatchRequest;

export type RunStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HelloResponse {
	readonly type: "hello";
	readonly protocolVersion: number;
	readonly hostId: string;
}
export interface EnsureRunResponse {
	readonly type: "ensureRun";
	readonly runId: string;
	readonly conversationId: string;
}
export interface SubmitResponse {
	readonly type: "submit";
	readonly runId: string;
	readonly submissionId: string;
}
export interface StatusResponse {
	readonly type: "status";
	readonly runId: string;
	readonly status: RunStatus;
	readonly lastError?: string;
}
export interface OkResponse {
	readonly type: "ok";
}
export interface CatalogResponse {
	readonly type: "catalog";
	/** `provider/modelId` for every chat model the host's catalog knows. */
	readonly models: readonly string[];
	readonly thinkingLevels: readonly string[];
	/** Context window per `provider/modelId`, for the prompt's context meter. */
	readonly contextWindows: Readonly<Record<string, number>>;
}
export interface ErrorResponse {
	readonly type: "error";
	readonly code:
		| "oversized-frame"
		| "version-mismatch"
		| "unknown-run"
		| "invalid-request"
		| "internal";
	readonly message: string;
}
/** One `watch` frame: the conversation's view snapshot, coalesced by the host
 * (durable-agent-host D3 / pi-durable's own watch coalescing). */
export interface WatchFrame {
	readonly type: "watchFrame";
	readonly runId: string;
	readonly value: unknown;
}
export type HostResponse =
	| HelloResponse
	| EnsureRunResponse
	| SubmitResponse
	| StatusResponse
	| CatalogResponse
	| OkResponse
	| ErrorResponse
	| WatchFrame;

/** Encode one request/response as one NDJSON line (trailing `\n`). Throws if
 * the encoded frame would exceed {@link MAX_FRAME_BYTES}, so a caller never
 * sends a frame the host (or another client) would have to reject. */
export function encodeFrame(value: HostRequest | HostResponse): string {
	const line = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES)
		throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`);
	return line;
}

export type DecodedFrame =
	| { readonly ok: true; readonly value: HostRequest | HostResponse }
	| { readonly ok: false; readonly error: ErrorResponse };

/** Decode one received line (without its trailing newline). Oversized and
 * malformed frames are reported as structured errors instead of throwing, so
 * a server loop can reject one bad frame and keep serving other clients. */
export function decodeFrame(line: string): DecodedFrame {
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES)
		return {
			ok: false,
			error: {
				type: "error",
				code: "oversized-frame",
				message: `frame exceeds ${MAX_FRAME_BYTES} bytes`,
			},
		};
	try {
		const value = JSON.parse(line) as HostRequest | HostResponse;
		if (!value || typeof value !== "object" || typeof value.type !== "string")
			throw new Error("missing type");
		return { ok: true, value };
	} catch (error) {
		return {
			ok: false,
			error: {
				type: "error",
				code: "invalid-request",
				message: `malformed frame: ${(error as Error).message}`,
			},
		};
	}
}

/** Incremental NDJSON reassembler for a byte stream: feed raw chunks, get back
 * complete lines (without the trailing newline) in arrival order. */
export class FrameReader {
	private buffer = "";
	push(chunk: string): string[] {
		this.buffer += chunk;
		const lines: string[] = [];
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			lines.push(this.buffer.slice(0, index));
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
		}
		return lines;
	}
}

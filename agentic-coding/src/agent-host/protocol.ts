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
 * full coding tools (read/write/edit/bash) plus the orchestrator's own
 * workflow-management tools, so it can act directly or launch a workflow. */
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
	/** How the prompt is placed when the conversation is busy. The wire value is
	 * open on purpose: `steer` and `overwrite` (and `interrupt`) replace what the
	 * agent is doing, anything else queues behind it, and a client whose mode this
	 * build does not know still has its prompt accepted rather than dropped
	 * ({@link normalizeSubmitMode}). An idle conversation always starts the next
	 * turn, whatever the mode. */
	readonly whenBusy?: string;
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
/** One manual compaction of a run's conversation (`/compact` in the agent
 * session prompt). `instructions` is free-text guidance for the summarizer,
 * bounded by the host; absent means no guidance. */
export interface CompactRunRequest {
	readonly type: "compactRun";
	readonly runId: string;
	readonly instructions?: string;
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
	/** The run's durable conversation, for a client that still holds it while the
	 * host no longer tracks the run: a host restart drops the in-memory run map,
	 * and the run id lives only there. Read-only by construction — the watch
	 * serves the transcript the conversation already holds and never registers a
	 * run, so `submit`/`abort` keep refusing an unknown run id. */
	readonly conversationId?: string;
	/** What each frame must carry. `docs` serves the live documents (`pi.live`,
	 * `pi.inbox`) without the committed transcript: the Agents panel's activity
	 * badge reads nothing else, and a run's transcript is megabytes that would
	 * otherwise cross the socket again on every token-rate frame. Absent means
	 * the full conversation view, which the session page needs. */
	readonly view?: "docs";
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
	| CompactRunRequest
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
	/** The run's workflow state as reconciled for this prompt
	 * (`agent.resume`): `resumed` reopened a run parked by a developer abort,
	 * `finished` names a run that already handed off, `blocked` a run parked by
	 * its own blocked handoff, `stale` a parked run its step moved past. Absent
	 * when the host had nothing to reconcile. The prompt itself is delivered in
	 * every case. */
	readonly workflowState?: SubmitWorkflowState;
	readonly workflowNote?: string;
}
/** What reconciling one run's workflow state before a prompt reported. */
export type SubmitWorkflowState =
	| "resumed"
	| "active"
	| "blocked"
	| "finished"
	| "stale";

/** Normalize one client's `whenBusy` mode to the two modes pi-durable queues
 * with. `steer`/`overwrite`/`interrupt` interrupt the running turn, every other
 * value (including `followUp` and any mode this build does not know) queues
 * behind it. An unknown mode is never a reason to reject or drop a prompt: the
 * mode only decides where it lands. */
export function normalizeSubmitMode(value: unknown): "steer" | "followUp" {
	if (typeof value !== "string") return "followUp";
	const mode = value.trim().toLowerCase();
	return mode === "steer" || mode === "overwrite" || mode === "interrupt"
		? "steer"
		: "followUp";
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
/** One compaction's structured outcome. `already-compacting` and
 * `nothing-to-compact` are answers, not errors: the request was understood and
 * nothing was admitted. */
export type CompactionRunStatus =
	| "started"
	| "already-compacting"
	| "nothing-to-compact";

export interface CompactRunResponse {
	readonly type: "compactRun";
	readonly runId: string;
	readonly status: CompactionRunStatus;
	/** The admitted compaction task's identity, for `started`. */
	readonly taskId?: string;
	/** The reason of the compaction already in flight, for `already-compacting`. */
	readonly reason?: string;
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
	| CompactRunResponse
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

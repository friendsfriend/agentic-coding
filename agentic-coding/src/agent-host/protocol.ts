// Private control protocol between the durable agent host and its clients
// (the workflow engine adapter and the dashboard session view). Newline-
// delimited JSON over a Unix socket (durable-agent-host spec, D3). Pure types
// and framing only: no pi-durable or node:net import here, so this module is
// safe for the workflow/dashboard layers to depend on directly.

import type { TargetReceipt } from "../contracts/scheduling.ts";
import type { ScheduledEnvelope } from "./scheduled-admission.ts";

export interface ScheduledAdmissionRequest {
	readonly type: "scheduledAdmission";
	readonly operation: "reserve" | "activate" | "query";
	readonly envelope: ScheduledEnvelope;
	readonly fence: number;
}
export interface ScheduledAdmissionResponse {
	readonly type: "scheduledAdmission";
	readonly receipt: TargetReceipt;
}

/** Wire protocol version. A client whose `hello` names a different version is
 * refused rather than guessing compatibility. */
export const PROTOCOL_VERSION = 2;

/** Frames above this size are rejected before they are parsed, so a runaway
 * client cannot exhaust the host's memory one line at a time. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** `orchestrator` is served only by a host opened in orchestrator mode: the
 * full coding tools (read/write/edit/bash) plus the orchestrator's own
 * workflow-management tools, so it can act directly or launch a workflow. */
export type ToolPolicy =
	| "default"
	| "read-only"
	| "orchestrator"
	| "collection";

import type { LaunchClaim } from "../contracts/launch.ts";

export interface AdmitWorkflowRunRequest
	extends Omit<EnsureRunRequest, "type" | "expectedConversationId"> {
	readonly type: "admitWorkflowRun";
	readonly claim: LaunchClaim;
	readonly text: string;
	readonly requestId: string;
}

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
	/** Recovery only: refuse a missing/rebound conversation instead of creating
	 * a replacement. Taken from the authoritative workflow run handle. */
	readonly expectedConversationId?: string;
	readonly toolPolicy: ToolPolicy;
	readonly model?: string;
	readonly thinking?: string;
}
/** Separate verb so an older host fails closed rather than ignoring recovery's
 * no-create precondition on an ordinary ensureRun request. */
export interface RecoverRunRequest
	extends Omit<EnsureRunRequest, "type" | "expectedConversationId"> {
	readonly type: "recoverRun";
	readonly expectedConversationId: string;
}
export interface ClarificationDeliveryRequest {
	readonly type: "clarificationDelivery";
	readonly hostId: string;
	readonly conversationId: string;
	readonly deliveryId: string;
	readonly text: string;
}
export interface ClarificationDeliveryResponse {
	readonly type: "clarificationDelivery";
	readonly hostId: string;
	readonly conversationId: string;
	readonly deliveryId: string;
	readonly runId: string;
}
export interface ClarificationTranscriptRequest {
	readonly type: "clarificationTranscript";
	readonly runId: string;
	readonly hostId: string;
	readonly conversationId: string;
	/** Omitted lists recent real messages; selected references fail closed. */
	readonly messageIds?: readonly string[];
}
export interface ClarificationClaimRequest
	extends Omit<ClarificationTranscriptRequest, "type" | "messageIds"> {
	readonly type: "clarificationClaim";
	readonly confirmationMessageId: string;
	readonly binding: string;
}
export interface ClarificationClaimResponse {
	readonly type: "clarificationClaim";
	readonly confirmationMessageId: string;
	readonly binding: string;
}
export interface ClarificationTranscriptResponse {
	readonly type: "clarificationTranscript";
	readonly messages: readonly import("./clarification-transcript.ts").ClarificationTranscriptMessage[];
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
	/** Internal attribution only. Developer provenance needs a separate
	 * authenticated ingress; a socket caller cannot declare itself human. */
	readonly source?: "internal";
	readonly developerInput?: import("../contracts/orchestrator-input.ts").OrchestratorDeveloperInput;
	readonly developerProof?: string;
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
export interface FenceStoppedRunRequest {
	readonly type: "fenceStoppedRun";
	readonly claim: LaunchClaim;
}
export interface StopRunRequest {
	readonly type: "stopRun";
	readonly runId: string;
}
export interface ShutdownRequest {
	readonly type: "shutdown";
}
/** Ask a surviving host to close only when no tracked run is doing live work.
 * This contains no retry authority; a fresh host receives its new capability
 * through the launcher's inherited descriptor. */
export interface PrepareRestartForReattachmentRequest {
	readonly type: "prepareRestartForReattachment";
}
export interface WatchRequest {
	readonly type: "watch";
	readonly runId: string;
	/** Recovery hint for a run whose in-memory record was lost on host restart.
	 * The host must verify its persisted run/conversation association before
	 * publishing any frame; a caller-supplied conversation alone is not evidence.
	 * Recovery never registers a run, so submit/abort still refuse unknown runs. */
	readonly conversationId?: string;
	/** What each frame must carry. `docs` serves the live documents (`pi.live`,
	 * `pi.inbox`) without the committed transcript: the Agents panel's activity
	 * badge reads nothing else, and a run's transcript is megabytes that would
	 * otherwise cross the socket again on every token-rate frame. Absent means
	 * the full conversation view, which the session page needs. */
	readonly view?: "docs";
	/** Ask for an initial snapshot followed by operation patches
	 * (`WatchFrame.patch`) instead of a full snapshot per change. The host
	 * serves full snapshots when this is absent, so an older client keeps the
	 * protocol it knows. */
	readonly patch?: boolean;
}
export interface HelloRequest {
	readonly type: "hello";
	readonly protocolVersion: number;
}
export type HostRequest =
	| {
			readonly type: "revokeSession";
			readonly runId: string;
			readonly hostId: string;
			readonly conversationId: string;
	  }
	| { readonly type: "resolveSession"; readonly runId: string }
	| { readonly type: "scheduledIdentity" }
	| ScheduledAdmissionRequest
	| ClarificationTranscriptRequest
	| ClarificationDeliveryRequest
	| ClarificationClaimRequest
	| HelloRequest
	| EnsureRunRequest
	| AdmitWorkflowRunRequest
	| RecoverRunRequest
	| SubmitRequest
	| StatusRequest
	| { readonly type: "inspectLaunch"; readonly runId: string }
	| ConfigureRunRequest
	| CatalogRequest
	| CompactRunRequest
	| RetryTaskRequest
	| AbortRequest
	| StopRunRequest
	| FenceStoppedRunRequest
	| ShutdownRequest
	| PrepareRestartForReattachmentRequest
	| WatchRequest;

export type RunStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HelloResponse {
	readonly type: "hello";
	readonly protocolVersion: number;
	readonly hostId: string;
}
export interface PrepareRestartForReattachmentResponse {
	readonly type: "prepareRestartForReattachment";
	readonly status: "ready" | "busy";
}
export interface EnsureRunResponse {
	readonly type: "ensureRun";
	readonly runId: string;
	readonly conversationId: string;
}
export interface SubmitResponse {
	/** Only a verified operator-attested input receives this acknowledgement. */
	readonly developerInputAccepted?: true;
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
export interface RuntimeFailure {
	readonly kind:
		| "task_faulted"
		| "task_parked"
		| "host_failure"
		| "session_failure"
		| "extension_failure"
		| "other_failure";
	readonly domain: "task" | "host" | "session" | "extension" | "unknown";
	readonly taskId?: string;
	/** Current durable parked-failure episode, required to reject stale UI retries. */
	readonly generation?: number;
	readonly reason?: string;
	readonly error?: string;
}

export type RetryTaskStatus =
	| "retried"
	| "already-in-progress"
	| "stale"
	| "refused";

export interface RetryTaskRequest {
	readonly type: "retryTask";
	readonly runId: string;
	readonly conversationId: string;
	readonly taskId: string;
	readonly generation: number;
	/** Private host-launch capability. Never copied into a run environment or
	 * returned in a response. */
	readonly recoveryCapability: string;
}

export interface RetryTaskResponse {
	readonly type: "retryTask";
	readonly runId: string;
	readonly taskId: string;
	readonly status: RetryTaskStatus;
	readonly reason?: string;
}

/** Bounded diagnostic text shared by host reports and defensive UI projections.
 * Structured payloads are never stringified into diagnostics. */
export function safeFailureMessage(value: unknown, limit = 240): string {
	if (typeof value !== "string") return "";
	const safe = value
		.replace(/-----BEGIN[\s\S]*?-----END[^\n]*/g, "[REDACTED]")
		.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
			"[REDACTED]",
		)
		.replace(
			/\b(HERDR_RUN_TOKEN|(?:api[_-]?)?key|token|secret|password|passwd|authorization)\s*[:=]\s*[^\s,;]+/gi,
			"$1=[REDACTED]",
		)
		.replace(/\s+/g, " ")
		.trim();
	return safe.length > limit
		? `${safe.slice(0, Math.max(0, limit - 1))}…`
		: safe;
}

export interface StatusResponse {
	readonly type: "status";
	readonly runId: string;
	readonly status: RunStatus;
	readonly lastError?: string;
	readonly runtimeFailure?: RuntimeFailure;
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
		| "launch-verifier-unavailable"
		| "launch-claim-refused"
		| "unknown-run"
		| "invalid-request"
		| "internal";
	readonly message: string;
}
/** One incremental view update: chord operations applied to the previous
 * `value`, plus the measured timings when they changed. `ops` may be empty for
 * a timings-only update. */
export interface WatchPatch {
	readonly ops: readonly unknown[];
	readonly timings?: Readonly<Record<string, unknown>>;
}
/** One `watch` frame: either the conversation's full view snapshot or, when
 * the watcher asked for patches, the operations that advance its previous
 * snapshot. Coalesced by the host (durable-agent-host D3 / pi-durable's own
 * watch coalescing). */
export interface WatchFrame {
	readonly type: "watchFrame";
	readonly runId: string;
	readonly value?: unknown;
	readonly patch?: WatchPatch;
}
export type HostResponse =
	| { readonly type: "resolveSession"; readonly conversationId?: string }
	| { readonly type: "scheduledIdentity"; readonly hostId: string }
	| ScheduledAdmissionResponse
	| ClarificationTranscriptResponse
	| ClarificationDeliveryResponse
	| ClarificationClaimResponse
	| HelloResponse
	| PrepareRestartForReattachmentResponse
	| EnsureRunResponse
	| SubmitResponse
	| StatusResponse
	| ({
			readonly type: "launchObservation";
	  } & import("../contracts/launch.ts").LaunchObservation)
	| CatalogResponse
	| CompactRunResponse
	| RetryTaskResponse
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

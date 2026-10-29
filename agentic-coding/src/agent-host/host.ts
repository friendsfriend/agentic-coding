import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue, Op } from "@earendil-works/chord/delta";
import type { Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type {
	CompactionResult,
	Cursor,
	ReportInfo,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	AgentDoc,
	type Conversation,
	type ConversationId,
	configure,
	createRegistry,
	DEFAULT_RESTART_LIMIT,
	defineDoc,
	type Extension,
	Harness,
	type JsonObject,
	LiveDoc,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	createToolSearchExtension,
	TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import { DEVELOPER_ABORT_MESSAGE } from "../contracts/workflow.ts";
import {
	COMPACTION_MAX_INSTRUCTIONS,
	type CompactionCeiling,
	type CompactionConfig,
	type CompactionPolicy,
	compactionConfigForModel,
	evaluateCompactionCeiling,
	resolveCompactionCeiling,
	resolveCompactionPolicy,
	resolveModelCompactionPolicies,
	STAGE_TESTER_COMPACTION_CEILING_TOKENS,
} from "../workflow/compaction.ts";
import { parseRunEnvFile } from "../workflow/run-env.ts";
import { boundedCodingTools } from "./bash-tool.ts";
import { createBrowserExtension } from "./browser-tools.ts";
import { createDurableCodemode } from "./codemode.ts";
import { compactionSerializationExtension } from "./compaction-serialization.ts";
import { configuredProviderIds, durableModels } from "./configured-models.ts";
import { createDebugExtension } from "./debug-tools.ts";
import {
	ENVIRONMENT_URL_ENV,
	ensureEnvironmentServer,
} from "./environment-capability.ts";
import { createEnvironmentExtension } from "./environment-tools.ts";
import {
	type FailFastDecision,
	type ToolSurfaceMonitor,
	toolSurfaceMonitorFor,
} from "./fail-fast.ts";
import { createBatchThrottle, createFrameThrottle } from "./frame-throttle.ts";
import { createHostIdentity, hostIdentityPaths } from "./host-identity.ts";
import { LaunchVerificationError } from "./launch-verifier.ts";
import type { HostLayout } from "./layout.ts";
import { createOrchestratorExtension } from "./orchestrator.ts";
import { LocalPiToolBridge } from "./pi-tool-bridge.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	type HostResponse,
	normalizeSubmitMode,
	PROTOCOL_VERSION,
	type RetryTaskStatus,
	type RunStatus,
	type RuntimeFailure,
	type SubmitWorkflowState,
	safeFailureMessage,
	type ToolPolicy,
	type WatchPatch,
} from "./protocol.ts";
import {
	activateScheduled,
	hasQueuedScheduled,
	queryScheduled,
	reserveScheduled,
	type ScheduledEnvelope,
} from "./scheduled-admission.ts";
import {
	type AgentHostSettings,
	normalizeLocalPiToolsSettings,
} from "./settings.ts";
import { createStageExtension } from "./stage-tools.ts";
import { backupHostStore } from "./storage-upgrade.ts";
import {
	attachTelemetry,
	type EntryTiming,
	emitRuntimeEnvelope,
	emitSessionWindow,
	emitToolTelemetry,
	type SessionWindowReason,
	type TelemetryIdentity,
	type ToolOutcomeObservation,
} from "./telemetry.ts";
import { suggestingCodingTools } from "./tool-suggestions.ts";
import {
	resolveCodemodeRegistered,
	type ToolSurfaceOptions,
} from "./tool-surface.ts";
import {
	CODING_SESSION_PREAMBLE,
	codingTools,
	createAskJevExtension,
	createDebugRequestExtension,
	createPromptExtension,
	createSearchExtension,
	createWorkflowDialogueExtension,
	type DurableRunContext,
	type ResumedRunState,
	type RunContextLookup,
	recordAbortedRunHandoff,
	recordFailFastRunHandoff,
	recordResumedRunHandoff,
	withoutDebugRequestTools,
} from "./tools.ts";

// pi-ai's default OAuth loaders hide imports from bundlers. Embed/register all
// flows here so compiled hosts can derive auth and refresh without node_modules.
registerBunOAuthFlows();

/** Shortest interval between two conversation frames a watcher receives. A
 * generating model changes the conversation at token rate; 50 ms keeps the
 * transcript live (about 20 frames a second) while bounding what each frame
 * costs the watcher. */
const STATE_FRAME_COALESCE_MS = 50;
/** Patch frames carry only the changed paths, so the same token-rate stream is
 * cheap enough to advance at 30 frames a second. This is the same trade
 * opencode's client makes: an initial snapshot, then fine-grained updates as
 * the server commits them. */
const PATCH_FRAME_COALESCE_MS = 33;
/** A stable empty timing map, so a conversation with no measured turns does not
 * look "changed" on every patch delivery. */
const NO_TIMINGS: Record<string, EntryTiming> = {};

/** The one cheap tool-host re-probe a run's dead surface gets before it is
 * stopped (efficiency backlog item 3). The host behind a run's `env_*`,
 * `browser_*` and debug tools is the unified workflow server, and a run that
 * received its capability knows its address: re-running the discovery probe is
 * a file read plus one bounded loopback health request, which is what turns
 * "the server was restarted under a live run" back into a working surface.
 *
 * A run with no environment capability has no such host to re-probe — the
 * caller reports that honestly (`probed: false`) and still grants the one extra
 * turn — so this never invents a mechanism that does not exist. */
async function reprobeToolHost(
	env: Readonly<Record<string, string>>,
): Promise<boolean> {
	if (!env[ENVIRONMENT_URL_ENV]) return false;
	try {
		return (await ensureEnvironmentServer()) !== undefined;
	} catch {
		return false;
	}
}

interface RunMapState extends JsonObject {
	format: number;
	runs: Record<string, { conversationId: number }>;
	/** Legacy ownership map, drained into individually keyed documents on open.
	 * Storage predating ownership evidence may lack this field. */
	runConversations: Record<string, { conversationId: number }>;
}
const RunMapDoc = defineDoc<RunMapState>({
	kind: "agentic.runs",
	version: 2,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ format: 2, runs: {}, runConversations: {} }),
	// Materialization keeps legacy evidence intact until the atomic commit.
	migrate: (value) => ({ ...(value as RunMapState), format: 1 }),
});

interface ConversationAssociation extends JsonObject {
	identity: string;
	conversationId: number;
}

interface RuntimeFailureDoc extends JsonObject {
	active: boolean;
	runId: string;
	conversationId: number;
	generation: number;
	retryAcceptedGeneration: number;
	retryAcceptedRestarts: number;
	kind: RuntimeFailure["kind"];
	domain: RuntimeFailure["domain"];
	taskId: string;
	reason: string;
	error: string;
}

function runtimeFailureDoc(conversationId: number) {
	return defineDoc<RuntimeFailureDoc>({
		kind: `agentic.failure.${createHash("sha256").update(String(conversationId)).digest("hex")}`,
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({
			active: false,
			runId: "",
			conversationId,
			generation: 0,
			retryAcceptedGeneration: -1,
			retryAcceptedRestarts: -1,
			kind: "other_failure",
			domain: "unknown",
			taskId: "",
			reason: "",
			error: "",
		}),
	});
}

type HarnessFailureReport = RuntimeFailure & {
	readonly conversationId?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function recordString(
	record: Record<string, unknown> | undefined,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = record?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function reportFailure(
	_error: unknown,
	info: ReportInfo,
): HarnessFailureReport {
	const task = "task" in info ? info.task : undefined;
	const taskId = task?.id;
	const conversationId =
		task?.conversationId ??
		(info.type === "extension_error" ? info.conversationId : undefined) ??
		taskConversationId(info);
	let kind: RuntimeFailure["kind"];
	let domain: RuntimeFailure["domain"];
	let reason: string | undefined;
	switch (info.type) {
		case "task_parked":
			kind = "task_parked";
			domain = "task";
			reason = "restart_limit";
			break;
		case "task_faulted":
			kind = "task_faulted";
			domain = "task";
			reason = info.reason;
			break;
		case "task_outdated":
		case "migration_failed":
		case "task_error":
			kind = "other_failure";
			domain = "task";
			if (info.type === "task_outdated") reason = info.reason;
			break;
		case "host_error":
			kind = "host_failure";
			domain = "host";
			break;
		case "session_failed":
			kind = "session_failure";
			domain = "session";
			break;
		case "extension_error":
			kind = "extension_failure";
			domain = "extension";
			break;
		case "listener_error":
			kind = "host_failure";
			domain = "host";
			break;
	}
	const safeReason =
		reason === "restart_limit" ||
		reason === "threw" ||
		reason === "missing_task" ||
		reason === "incompatible_task"
			? reason
			: undefined;
	// Free-form exception messages can contain prompts, tool arguments or results.
	// Keep only a bounded class name and the structured reason above.
	const errorName = "HarnessError";
	return {
		kind,
		domain,
		...(taskId !== undefined
			? { taskId: safeFailureMessage(String(taskId), 128) }
			: {}),
		...(safeReason ? { reason: safeReason } : {}),
		error: errorName,
		...(conversationId !== undefined ? { conversationId } : {}),
	};
}

function taskState(task: unknown): { status?: string; reason?: string } {
	const record = asRecord(task);
	const state =
		asRecord(record?.state) ??
		asRecord(asRecord(record?.record)?.state) ??
		record;
	const blocked = asRecord(state?.blocked) ?? asRecord(record?.blocked);
	const reason =
		recordString(state, "reason", "blockedReason", "blocked_reason") ??
		(typeof blocked?.reason === "string" ? blocked.reason : undefined);
	const status = recordString(state, "status") ?? recordString(state, "kind");
	return {
		...(status ? { status } : {}),
		...(reason ? { reason } : {}),
	};
}

function taskConversationId(task: unknown): number | undefined {
	const record = asRecord(task);
	const taskRecord = asRecord(record?.record) ?? record;
	const value = taskRecord?.conversationId;
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : undefined;
	}
	return undefined;
}

function parseTaskId(value: string): TaskId | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0
		? (parsed as TaskId)
		: undefined;
}

function taskRestartCount(task: unknown): number | undefined {
	const record = asRecord(asRecord(task)?.record) ?? asRecord(task);
	const restarts = record?.restarts;
	return restarts === undefined && record?.id !== undefined
		? 0
		: typeof restarts === "number" && Number.isSafeInteger(restarts)
			? restarts
			: undefined;
}

function isRestartLimitParked(task: unknown): boolean {
	const state = taskState(task);
	if (state.status !== undefined && state.status !== "pending")
		return state.status === "blocked" && state.reason === "restart_limit";
	const record = asRecord(asRecord(task)?.record) ?? asRecord(task);
	const restarts = taskRestartCount(task);
	return (
		record?.abortRequested !== true &&
		restarts !== undefined &&
		restarts >= DEFAULT_RESTART_LIMIT
	);
}

function sanitizePiLiveDiagnostics(value: unknown): unknown {
	const live = asRecord(value);
	if (!live) return value;
	const safe = { ...live };
	if (safe.compactionFailure !== undefined)
		safe.compactionFailure = { error: "compaction failed" };
	if (Array.isArray(safe.compactions))
		safe.compactions = safe.compactions.map((candidate) => {
			const compaction = asRecord(candidate);
			const retry = asRecord(compaction?.retry);
			if (!compaction || !retry) return candidate;
			return { ...compaction, retry: { ...retry, error: "retry failed" } };
		});
	return safe;
}

function sanitizeWatchValue(
	value: unknown,
): Record<string, unknown> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const docs = asRecord(record.docs);
	const live = docs?.["pi.live"];
	return docs && live !== undefined
		? {
				...record,
				docs: { ...docs, "pi.live": sanitizePiLiveDiagnostics(live) },
			}
		: record;
}

/** One constant-size durable document per identity, not a history-sized map.
 * Hash the key so arbitrary protocol identities cannot alias document kinds. */
interface LaunchFence extends JsonObject {
	runId: string;
	name: string;
	revision: number;
	claimAttempt: number;
	requestId: string;
	state: "prepared" | "admitted" | "stopping" | "stopped";
}
function launchFenceDoc(kind: "run" | "role", identity: string) {
	return defineDoc<LaunchFence>({
		kind: `agentic.launch.${kind}.${createHash("sha256").update(identity).digest("hex")}`,
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({
			runId: "",
			name: "",
			revision: 0,
			claimAttempt: 0,
			requestId: "",
			state: "prepared",
		}),
	});
}

/** Index only unfinished accepted stop commits, never historical launches.
 * It lets startup finish native cancellation BEFORE the harness resumes tasks.
 * This is host fence metadata, not another workflow queue or authority. */
interface StopBarriers extends JsonObject {
	runs: Record<string, { name: string; conversationId: number }>;
}
const StopBarriersDoc = defineDoc<StopBarriers>({
	kind: "agentic.launch.stopping",
	version: 1,
	scope: "session",
	checkpointWhen: () => false,
	initial: () => ({ runs: {} }),
});

function associationDoc(kind: "run" | "role", identity: string) {
	return defineDoc<ConversationAssociation>({
		kind: `agentic.${kind}.${createHash("sha256").update(identity).digest("hex")}`,
		version: 1,
		scope: "session",
		checkpointWhen: () => false,
		initial: () => ({ identity, conversationId: 0 }),
	});
}

/** One-time, atomic upgrade of already-issued ownership and role reuse keys.
 * Clear the legacy maps in the same commit: later opens, ensures and recovery
 * never snapshot the historical aggregate again. No workflow state is changed. */
async function migrateAssociations(
	harness: Harness,
	context: Context,
	backup?: () => void,
) {
	const map = await harness.snapshot(RunMapDoc, context);
	if (map?.format === 2) return;
	backup?.();
	await harness.commit(async (tx) => {
		const legacy = await tx.doc(RunMapDoc);
		for (const [kind, entries] of [
			["role", legacy.runs],
			["run", legacy.runConversations ?? {}],
		] as const) {
			for (const [identity, { conversationId }] of Object.entries(entries)) {
				const association = await tx.doc(associationDoc(kind, identity));
				association.conversationId = conversationId;
			}
		}
		legacy.runs = {};
		legacy.runConversations = {};
		legacy.format = 2; // v1 readers now explicitly reject the stored version.
	}, context);
}

/** pi-durable never threads pi-ai's `options.sessionId`, but the built-in
 * `opencode-go` provider needs it to emit its required `x-opencode-session`
 * routing header. Without it every generation fails with a 400
 * `MissingSessionID` and the submission settles `model_error`, so the
 * dashboard shows a worker that starts and is idle again instantly. Pane
 * runtimes get a session id from pi's own session manager; a durable host has
 * none, so pin one per host process for provider session affinity.
 * ponytail: one id per host, not per conversation — split it per conversation
 * if OpenCode's per-conversation routing ever measurably matters. */
export function withDurableSession(models: MutableModels): MutableModels {
	const provider = models.getProvider("opencode-go");
	if (!provider) return models;
	const sessionId = randomUUID();
	const withSession = <T>(options: T | undefined): T =>
		({
			...(options as object | undefined),
			sessionId:
				(options as { sessionId?: string } | undefined)?.sessionId ?? sessionId,
		}) as T;
	models.setProvider({
		...provider,
		stream: (model, context, options) =>
			provider.stream(model, context, withSession(options)),
		streamSimple: (model, context, options) =>
			provider.streamSimple(model, context, withSession(options)),
	} as Provider);
	return models;
}

/** The marker the monitor's delivered notes carry as their first line. A note is
 * the orchestrator's own delivery, not the developer speaking. */
const MONITOR_NOTE_PREFIX = "[workflow-monitor]";

/** Whether a submitted text is the developer's own message: the monitor's notes
 * and the abort marker are deliveries, not words the developer wrote, so a
 * `taskRef.previousMessage` start never sends one. */
function developerMessage(text: string): boolean {
	if (text.startsWith(MONITOR_NOTE_PREFIX)) return false;
	return text.trim() !== DEVELOPER_ABORT_MESSAGE;
}

function readJevBinding(env: Record<string, string>): DurableRunContext["jev"] {
	const raw = env.AGENTIC_JEV;
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<{
			provider: string;
			model: string;
			endpoint: string;
		}>;
		if (
			typeof parsed.provider === "string" &&
			typeof parsed.model === "string" &&
			typeof parsed.endpoint === "string"
		)
			return {
				provider: parsed.provider,
				model: parsed.model,
				endpoint: parsed.endpoint,
			};
	} catch {
		/* no binding */
	}
	return undefined;
}

export interface EnsureRunInput {
	readonly runId: string;
	readonly cwd: string;
	readonly runEnvPath: string;
	/** The engine's canonical agent name: the run-map dedup key (see
	 * `protocol.ts`'s `EnsureRunRequest.name`). */
	readonly name: string;
	readonly expectedConversationId?: string;
	readonly toolPolicy: ToolPolicy;
	readonly model?: string;
	readonly thinking?: string;
}

/** Shortest interval a manual compaction waits for a task that has nothing to
 * summarize to leave the live list. pi-durable completes such a task
 * immediately and reports no reason, so the task's absence — plus its receipt —
 * is the only signal there is; waiting for it turns that race into a definite
 * answer, and a real summarizer (a provider call) is always still listed. */
const COMPACTION_SETTLE_MS = 250;
const COMPACTION_SETTLE_POLL_MS = 10;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunRecord {
	conversationId: ConversationId;
	readOnly: boolean;
	/** Role-bound ceilings let narrowly scoped workflow agents use less context. */
	role?: string;
	/** The `provider/modelId` this run's conversation uses, tracked so a
	 * percentage compaction threshold can be resolved against a real context
	 * window. Absent when nothing named a model and `pi.agent` carries none. */
	model?: string;
}

/** The run a conversation is currently bound to, with the identity that run
 * records under (efficiency backlog item 20: a run's window is its session's
 * window). One conversation serves every later run of the same step and role, so
 * this is what makes a turn attributable to the run that was working: the
 * telemetry stream reads it per envelope and the session-window events name it.
 * It survives the run's retirement (`stopRun` keeps it) because the conversation
 * is what continues — a host restart is the only thing that loses it. */
interface SessionBinding {
	readonly runId: string;
	readonly identity: TelemetryIdentity;
}

/** A `runtime.session_window.closed` record that could not be written, kept for the
 * conversation's next binding. */
interface PendingSessionClose {
	readonly identity: TelemetryIdentity;
	readonly reboundTo: string;
}

/** How many unwritten closes one conversation keeps: an unwritable sink must not grow
 * the list without bound, and a stale close is worth less than the next one. */
const MAX_PENDING_SESSION_CLOSES = 8;

/** What the host remembers about one conversation's cost-ceiling compactions
 * (efficiency backlog item 6): the measured turn, what it decided at, and the
 * turns it compacted at, which is what the floor and the loop guard count. */
export interface CeilingRecord {
	turnIndex: number;
	lastCompactionTurn?: number;
	lastCompactionTokens?: number;
	/** The measured context of the first turn after a compaction: the base the
	 * token floor counts new context from. Without it the floor would measure the
	 * *net* change, which a compaction hides — a conversation that shrinks from
	 * 200k to 20k and then grows back to 80k added 60k of new context, not −120k. */
	baselineTokens?: number;
	/** Set while the next measured turn will be that baseline. */
	awaitingBaseline?: boolean;
	compactionTurns: number[];
	/** Set once the loop guard tripped: no further ceiling compaction for this
	 * conversation, and the warning was emitted. */
	suspended?: boolean;
	/** Set once the "ignored above the overflow threshold" warning was emitted, so
	 * a long run records it once instead of on every turn. */
	warnedAboveOverflow?: boolean;
}

/** One manual compaction's outcome (durable-agent-compaction: "Manual
 * compaction outcomes"). */
export type CompactionRunStatus =
	| "started"
	| "already-compacting"
	| "nothing-to-compact";

export interface CompactRunResult {
	readonly status: CompactionRunStatus;
	/** The admitted compaction's task identity, for `started`. */
	readonly taskId?: string;
	/** The reason of the compaction already in flight, for `already-compacting`. */
	readonly reason?: string;
}

export interface DurableHostOptions {
	readonly layout: HostLayout;
	readonly settings: AgentHostSettings;
	/** The effective compaction section, read at every resolution (design D4):
	 * `host-main.ts` supplies a file-backed accessor, tests supply a constant.
	 * Absent, the static `settings.compaction` is used, and with neither the
	 * documented defaults apply. */
	readonly compaction?: () => CompactionConfig;
	readonly globalAgentDir: string;
	readonly credentialsPath?: string;
	/** Orchestrator mode (`--orchestrator`): the host installs only the coding
	 * tools and the orchestrator extension, and serves the `orchestrator` tool
	 * policy instead of workflow runs. */
	readonly orchestrator?: boolean;
	/** Standalone coding-session mode (`--session`): the host installs the
	 * coding tools, `grep`, `codemode` and the repository context prompt, but
	 * none of the workflow tools or the workflow preamble. It serves the
	 * `default` policy only. */
	readonly session?: boolean;
	/** Private launch capability for the developer-mediated retry frame. */
	readonly retryCapability?: string;
	readonly log?: (line: string) => void;
	/** Test-only overrides: a faux `Models` collection and/or an in-memory
	 * `Storage` in place of the real SQLite file and live pi credentials.
	 * Production callers (`host-main.ts`) never set these. */
	readonly storage?: Storage;
	readonly models?: Models;
	/** Injectable substitution for the one cheap tool-host re-probe a dead tool
	 * surface gets (`reprobeToolHost` by default). A focused test supplies its
	 * own so no test ever probes the developer's real configuration; production
	 * leaves it unset. */
	readonly probeToolHost?: (
		env: Readonly<Record<string, string>>,
	) => Promise<boolean>;
}

/** One open durable harness plus its control socket. Owns exactly the state
 * `durable-agent-host` assigns a host: run bookkeeping, the socket server,
 * and the harness/storage lifecycle. */
export class DurableHost {
	private readonly runs = new Map<string, RunRecord>();
	private readonly runtimeFailureLogQueue: string[] = [];
	private runtimeFailureLogDraining = false;
	private readonly contexts = new Map<ConversationId, DurableRunContext>();
	/** Each run's own environment, keyed by run id. A decision belongs to the run that
	 * made it: after a rebinding `contexts` holds the successor's, so a retired run's
	 * late decision read from there would be written under the successor's token. */
	private readonly runContexts = new Map<string, DurableRunContext>();
	/** The developer message each conversation's running turn is answering, in
	 * the developer's own words: the orchestrator's `taskRef.previousMessage`
	 * substitutes it as the task instead of re-typing prose that was already
	 * sent. A message that arrived while a turn was already running is *queued*,
	 * never substituted for the one that turn answers. Monitor notes and abort
	 * markers are recorded in neither map. */
	private readonly turnDeveloperMessages = new Map<ConversationId, string>();
	/** The developer messages admitted behind a running turn, oldest first: each
	 * becomes the answered message when the turn ahead of it commits. */
	private readonly queuedDeveloperMessages = new Map<
		ConversationId,
		string[]
	>();
	private readonly telemetry = new Map<ConversationId, () => void>();
	/** The per-run dead-surface monitors, keyed like the telemetry attachments:
	 * one counter per conversation, dropped with the run. */
	private readonly toolSurfaces = new Map<ConversationId, ToolSurfaceMonitor>();
	/** What the one tool-host re-probe of a run answered, so the run's own
	 * `blocked` event reports the mechanism honestly instead of assuming one. */
	private readonly toolProbes = new Map<ConversationId, boolean>();
	/** Measured wall-clock timing per committed assistant entry, keyed by
	 * conversation then entry id. In-memory: a host restart loses it. */
	private readonly timings = new Map<
		ConversationId,
		Record<string, EntryTiming>
	>();
	/** Watchers that asked for patch frames, woken when a measured timing
	 * arrives. The timing is not part of the conversation view, so it can change
	 * without an operation to carry it. */
	private readonly timingListeners = new Map<ConversationId, Set<() => void>>();
	/** Synthetic runtime reports are durable in a small per-conversation doc,
	 * not in pi.live. Wake both full-session and docs-only watches when one lands. */
	private readonly runtimeFailureListeners = new Map<
		ConversationId,
		Set<() => void>
	>();
	private readonly retryingTasks = new Set<string>();
	private readonly watchers = new Map<net.Socket, Set<() => void>>();
	/** Runs whose `blocked` handoff this host recorded as a developer abort.
	 * The developer's next message reconciles the workflow state for exactly
	 * these runs (`workflow resume-run`), so a fresh run never pays for a
	 * reconcile it cannot need. */
	private readonly abortedRuns = new Set<string>();
	/** Runs whose workflow state this host generation already reconciled once.
	 * A park can outlive the host that recorded it (a restart, or a park an
	 * older build recorded without the abort marker), so the first prompt of
	 * each run asks the engine once - the engine's durable state decides. */
	private readonly reconciledRuns = new Set<string>();
	/** Per-conversation chain of the mutating operations (`submit`, `abort`,
	 * `stopRun`). See {@link serialized}. */
	private readonly operations = new Map<string, Promise<void>>();
	/** Admission and stop of an as-yet-unseen run share this lock. A successful
	 * stop is a durable tombstone, not an inference from an empty run map. */
	private readonly managedOperations = new Map<string, Promise<void>>();
	private managedOperation<T>(
		runId: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const work = (this.managedOperations.get(runId) ?? Promise.resolve()).then(
			operation,
		);
		const settled = work.then(
			() => {},
			() => {},
		);
		this.managedOperations.set(runId, settled);
		void settled.then(() => {
			if (this.managedOperations.get(runId) === settled)
				this.managedOperations.delete(runId);
		});
		return work;
	}

	admitWorkflowRun(
		input: import("./protocol.ts").AdmitWorkflowRunRequest,
	): Promise<{ conversationId: string }> {
		this.assertOpen();
		return this.managedOperation(input.runId, async () => {
			const { verifyWorkflowLaunch } = await import("./launch-verifier.ts");
			const { decodeContract } = await import("../contracts/decode.ts");
			const { launchClaimSchema } = await import("../contracts/launch.ts");
			const claim = decodeContract<
				import("../contracts/launch.ts").LaunchClaim
			>("host.launch-claim", launchClaimSchema, input.claim);
			if (claim.intent === "stop")
				throw new Error("Cancellation claim cannot admit a run");
			if (claim.runId !== input.runId)
				throw new Error("Launch run identity mismatch");
			let permit = await verifyWorkflowLaunch(claim);
			if (
				path.resolve(permit.hostRoot) !== path.resolve(this.options.layout.root)
			)
				throw new Error("Launch belongs to another host");
			return this.managedOperation(`role:${permit.name}`, async () => {
				permit = await verifyWorkflowLaunch(claim);
				const environment = parseRunEnvFile(
					fs.readFileSync(permit.runEnvPath, "utf8"),
				);
				if (
					environment.HERDR_WORKFLOW_ID !== permit.workflowId ||
					environment.HERDR_RUN_ID !== permit.runId
				)
					throw new Error(
						"Authoritative run environment does not match the launch claim",
					);
				const runDoc = launchFenceDoc("run", input.runId);
				const roleDoc = launchFenceDoc("role", permit.name);
				let admitted = false;
				await this.harness.commit(async (tx) => {
					const run = await tx.doc(runDoc);
					const role = await tx.doc(roleDoc);
					if (
						run.state === "stopped" ||
						run.state === "stopping" ||
						(run.runId && run.claimAttempt > permit.claimAttempt) ||
						(role.runId &&
							(role.revision > permit.revision ||
								(role.runId === input.runId &&
									role.claimAttempt > permit.claimAttempt)))
					)
						throw new Error("Launch is fenced by a newer admission or stop");
					admitted = run.state === "admitted";
					if (run.requestId && run.requestId !== permit.requestId && !admitted)
						throw new Error(
							"Unacknowledged launch request changed; inspect admission before dispatch",
						);
					const identity = {
						name: permit.name,
						runId: input.runId,
						revision: permit.revision,
						claimAttempt: permit.claimAttempt,
						requestId: run.requestId || permit.requestId,
						state: admitted ? ("admitted" as const) : ("prepared" as const),
					};
					Object.assign(run, identity);
					Object.assign(role, identity);
				}, BACKGROUND_CONTEXT);
				const ensured = await this.ensureRun(
					{
						runId: input.runId,
						name: permit.name,
						cwd: permit.cwd,
						runEnvPath: permit.runEnvPath,
						toolPolicy: permit.toolPolicy,
						...(permit.model ? { model: permit.model } : {}),
						...(permit.thinking ? { thinking: permit.thinking } : {}),
					},
					true,
				);
				// Crash after submit/before this doc commit replays the SAME request id.
				// Already-admitted work is only reattached, never submitted a second turn.
				if (!admitted) {
					permit = await verifyWorkflowLaunch(claim);
					if (Date.parse(permit.leaseExpiresAt) <= Date.now())
						throw new Error(
							"Launch verification expired before admission; inspect workflow status",
						);
					await this.submit(
						input.runId,
						input.text,
						permit.requestId,
						"followUp",
						true,
					);
					await this.harness.commit(async (tx) => {
						const run = await tx.doc(runDoc);
						run.state = "admitted";
						const role = await tx.doc(roleDoc);
						if (role.runId === input.runId) role.state = "admitted";
					}, BACKGROUND_CONTEXT);
				}
				return ensured;
			});
		});
	}
	/** Context windows by model ref (see `modelWindow`). */
	private readonly modelWindows = new Map<string, number | undefined>();
	/** The cost ceiling's per-conversation bookkeeping, keyed by conversation. */
	private readonly ceilings = new Map<ConversationId, CeilingRecord>();
	/** Compaction tasks this host admitted for cost, so the telemetry envelope
	 * reports `auto-ceiling` instead of pi-durable's `manual`. */
	private readonly ceilingCompactions = new Set<string>();
	/** Ceiling compactions admitted but not yet seen starting on the event stream:
	 * `conversation.compact()` resolves after the task's `compaction_start` event
	 * is published, so the kind has to be claimed before the call and not from its
	 * returned identity. */
	private readonly ceilingPending = new Map<ConversationId, number>();
	/** Each conversation's telemetry identity, so a ceiling decision can report
	 * itself as an envelope on the same file the run writes. */
	private readonly telemetryIdentities = new Map<
		ConversationId,
		TelemetryIdentity
	>();
	/** The run each conversation is bound to *now* — the session window's binding,
	 * and the identity the conversation's telemetry stream stamps its envelopes
	 * with. Deliberately not dropped by `stopRun`: a conversation outlives the run
	 * it was created for, and the run it left is what a rebinding reports. Its
	 * lifetime is the host process, shared with `telemetry`'s per-conversation
	 * stream: both are dropped together when the host shuts down, never per run. */
	private readonly sessionBindings = new Map<ConversationId, SessionBinding>();
	/** The `closed` records that could not be written, per conversation, retried on
	 * its next binding (`recordSessionWindow`). */
	private readonly pendingSessionCloses = new Map<
		ConversationId,
		PendingSessionClose[]
	>();
	/** The session-window transition in flight per conversation. A rebinding's
	 * read-drain-write is one step: two of them must neither interleave nor observe
	 * each other's previous binding. */
	private readonly sessionWindowChain = new Map<
		ConversationId,
		Promise<void>
	>();
	private server: net.Server | undefined;
	private authenticatedServer: tls.Server | undefined;
	private readonly authenticatedSockets = new Set<net.Socket>();
	private readonly activeRequests = new Set<Promise<void>>();
	private closing = false;
	private shutdownPromise: Promise<void> | undefined;

	/** Thinking levels pi-ai accepts, newest first for the picker. */
	static readonly THINKING_LEVELS = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	] as const;

	private constructor(
		private readonly harness: Harness,
		private readonly options: DurableHostOptions,
		private readonly models: Models | undefined,
		/** The durable `codemode` tool when the user's global pi settings enable
		 * it, so a read-only run's explicit selection can still offer it. */
		private readonly codemodeTool: ToolRegistration | undefined,
		private readonly closeCodemode: (() => Promise<void>) | undefined,
		/** The read-only run's share of the workflow extensions: `ask_jev` (the
		 * in-session judgment tool the protocol tells every verifier to reach for),
		 * `grep` (the bounded repository search a review needs), the environment
		 * tools (a verifier starts and reads the app it verifies), the browser and
		 * the debug tools (a verifier reproduces the failure it reads about). A
		 * read-only run names its tools explicitly, so all of them have to be listed
		 * here or the prompt would name a tool the session never got. */
		private readonly readOnlyTools: readonly ToolRegistration[],
		/** Every workflow tool of a run with edit rights (the read-only set plus
		 * the dialogue tools). A debug run names its tools explicitly, so it is
		 * built from this list minus the delegated debug request tools. */
		private readonly workflowTools: readonly ToolRegistration[],
		/** The orchestrator extension, present only in orchestrator mode. */
		private readonly orchestratorExtension: Extension | undefined,
		/** The published tool registry, kept only so a focused test can read what
		 * a run of this host is actually offered (`toolDescriptionsForTest`). */
		private readonly registry: Registry,
		private readonly localPiBridge: LocalPiToolBridge | undefined,
	) {}

	/** The workflow-run extensions: dialogue tools, `ask_jev`, `grep`, the
	 * environment tools, and the workflow system prompt. Never installed in
	 * orchestrator mode or in a standalone coding session. */
	private static installWorkflowExtensions(
		registry: ReturnType<typeof createRegistry>,
		lookup: RunContextLookup,
		options: DurableHostOptions,
		surface: ToolSurfaceOptions,
	): {
		readonly readOnlyTools: readonly ToolRegistration[];
		readonly workflowTools: readonly ToolRegistration[];
	} {
		const dialogue = createWorkflowDialogueExtension(lookup);
		registry.install(dialogue);
		const jev = createAskJevExtension(lookup);
		registry.install(jev);
		const search = createSearchExtension(surface);
		registry.install(search);
		// Every durable run gets the environment tools, read-only runs included:
		// they act on the app slot instead of the source tree, so a verifier can
		// start, read and stop the app it is verifying without edit rights.
		const environment = createEnvironmentExtension(lookup);
		registry.install(environment);
		// The browser tools are part of the same environment capability: a run
		// browses the apps it holds, and a read-only verifier browses too, so they
		// are installed outside the edit-rights gate.
		const browser = createBrowserExtension(lookup);
		registry.install(browser);
		// The debug tools ride the same capability: they read the traces this
		// workflow's runs exported, the data an app it holds requires, and the
		// endpoints of the apps it holds — all of which a verifier needs.
		const debug = createDebugExtension(lookup);
		registry.install(debug);
		// The stage tool rides it too: a run reads the hosted stages this
		// configuration allows (never a credential value) and finds out which role
		// to log in as, which a read-only verifier needs as much as a coder.
		const stages = createStageExtension(lookup);
		registry.install(stages);
		// The delegated debug request tools ride every durable run except a
		// `debug` run itself: the delegation has to be impossible from the role
		// that answers requests, not merely discouraged
		// (add-debug-subagent-requests).
		const debugRequests = createDebugRequestExtension(lookup);
		registry.install(debugRequests);
		registry.install(createPromptExtension(options.globalAgentDir));
		const shared = [
			...(jev.tools ?? []),
			...(search.tools ?? []),
			...(environment.tools ?? []),
			...(browser.tools ?? []),
			...(stages.tools ?? []),
			...(debug.tools ?? []),
			...(debugRequests.tools ?? []),
		];
		return {
			readOnlyTools: shared,
			workflowTools: [...(dialogue.tools ?? []), ...shared],
		};
	}

	private assertOpen(): void {
		if (this.closing) throw new Error("agent host is shutting down");
	}

	private enqueueRuntimeFailureLog(line: string): void {
		if (this.runtimeFailureLogQueue.length >= 128) return;
		this.runtimeFailureLogQueue.push(line);
		if (this.runtimeFailureLogDraining) return;
		this.runtimeFailureLogDraining = true;
		void this.drainRuntimeFailureLogs();
	}

	private async drainRuntimeFailureLogs(): Promise<void> {
		try {
			while (this.runtimeFailureLogQueue.length > 0) {
				const line = this.runtimeFailureLogQueue.shift();
				if (!line) continue;
				try {
					await fs.promises.appendFile(
						this.options.layout.logPath,
						`${new Date().toISOString()} ${line}\n`,
					);
				} catch {
					// Failure diagnostics are best effort and must not recurse.
				}
				try {
					this.options.log?.(line);
				} catch {
					// A diagnostic callback must never destabilize the host.
				}
			}
		} finally {
			this.runtimeFailureLogDraining = false;
		}
	}

	private log(line: string): void {
		try {
			fs.appendFileSync(
				this.options.layout.logPath,
				`${new Date().toISOString()} ${line}\n`,
			);
		} catch {
			/* best-effort diagnostics only */
		}
		try {
			this.options.log?.(line);
		} catch {
			/* external diagnostic observers cannot affect the host */
		}
	}

	static async open(options: DurableHostOptions): Promise<DurableHost> {
		if (options.orchestrator && options.session)
			throw new Error(
				"a host serves either the orchestrator session or a coding session, not both",
			);
		fs.mkdirSync(options.layout.root, { recursive: true, mode: 0o700 });
		fs.mkdirSync(options.layout.runEnvDir, { recursive: true, mode: 0o700 });
		const registry = createRegistry();
		const host: { instance?: DurableHost } = {};
		registry.install(
			compactionSerializationExtension(
				() => {
					if (!host.instance) throw new Error("host is not initialized");
					return host.instance.harness;
				},
				(delta) => {
					if (host.instance) host.instance.compactionWaiters += delta;
				},
			),
		);
		const pendingReports: HarnessFailureReport[] = [];
		const onReport = (error: unknown, info: ReportInfo) => {
			try {
				const report = reportFailure(error, info);
				const instance = host.instance;
				if (instance)
					void instance.observeHarnessReport(report).catch(() => {
						/* reports are diagnostic and cannot affect the harness */
					});
				else if (pendingReports.length < 32) pendingReports.push(report);
			} catch {
				// The Harness report callback is observational: malformed reports,
				// diagnostic I/O and observers must never destabilize the host.
			}
		};
		// Whether this host's runs get `codemode` at all, resolved once and before
		// the coding tools are installed: the same flag decides whether the tool is
		// registered below and whether the `read`/`grep`/`bash` descriptions and
		// the assignments name it (tool-surface.ts). A run is never told about a
		// tool its tool set does not contain.
		// The same resolution decides whether `grep` is named: orchestrator mode
		// installs the same bounded search extension as workflow runs.
		const surface: ToolSurfaceOptions = {
			codemodeRegistered: resolveCodemodeRegistered(options.globalAgentDir),
			searchRegistered: true,
		};
		const codemodeRegistered = surface.codemodeRegistered === true;
		// pi-durable's coding tools with the bounded `bash` in place of its own
		// (bash-tool.ts): every runtime this host serves gets the same default
		// wall-clock bound, whoever selects the tool by name.
		registry.install(boundedCodingTools(surface));
		// …and `read`/`edit` with the self-correcting failure hints
		// (tool-suggestions.ts). Installed after the coding tools so its
		// registration of each of those names is the one a run selects; a
		// suggestion-only failure never replaces the tool's own error text.
		registry.install(suggestingCodingTools(surface));
		const lookup = (conversationId: ConversationId) =>
			host.instance?.contexts.get(conversationId);
		const orchestrator = options.orchestrator
			? createOrchestratorExtension(lookup, async (conversationId, context) => {
					const instance = host.instance;
					if (!instance) throw new Error("Host is not initialized.");
					return {
						kind: "wake-up",
						hostId: await instance.scheduledIdentity(),
						hostSocket: options.layout.socketPath,
						conversationId: String(conversationId),
						runId: context.runId,
					};
				})
			: undefined;
		if (orchestrator) registry.install(orchestrator);
		// A standalone coding session is a plain coding agent: it gets the
		// repository context prompt and `grep`, but no workflow dialogue,
		// environment, stage or debug tools and no managed-run preamble.
		if (options.session) {
			registry.install(createSearchExtension(surface));
			registry.install(
				createPromptExtension(
					options.globalAgentDir,
					(cwd) => cwd,
					CODING_SESSION_PREAMBLE,
				),
			);
		}
		// Operational tools need no workflow identity. The orchestrator's existing
		// server capability binds them to the developer's user environment; keep
		// workflow-only dialogue, handoff and delegated debug tools out of it.
		const operationalTools = orchestrator
			? [
					createSearchExtension(surface),
					createEnvironmentExtension(lookup),
					createBrowserExtension(lookup),
					createDebugExtension(lookup),
					createStageExtension(lookup),
				].flatMap((extension) => {
					registry.install(extension);
					return extension.tools ?? [];
				})
			: [];
		const workflowTools =
			orchestrator || options.session
				? { readOnlyTools: [], workflowTools: operationalTools }
				: DurableHost.installWorkflowExtensions(
						registry,
						lookup,
						options,
						surface,
					);
		// A durable run gets codemode only when the user's own global pi settings
		// enable it, matching what a managed pane session inherits. It is an
		// additional tool: the run keeps its direct tools either way. The
		// orchestrator never gets it: its tool surface is exactly its own.
		const codemode = codemodeRegistered ? createDurableCodemode() : undefined;
		if (codemode) registry.install(codemode.extension);
		const bridgeConfig = normalizeLocalPiToolsSettings(
			options.settings.localPiTools,
		);
		const localPiDiagnostics = bridgeConfig.diagnostic
			? [bridgeConfig.diagnostic]
			: [];
		const localPiToolSearch =
			bridgeConfig.settings?.enabled === true
				? createToolSearchExtension()
				: undefined;
		if (localPiToolSearch) registry.install(localPiToolSearch);
		const localPiBridge =
			bridgeConfig.settings?.enabled === true
				? new LocalPiToolBridge({
						registry,
						settings: bridgeConfig.settings,
						globalAgentDir: options.globalAgentDir,
						contextFor: (conversationId) =>
							host.instance?.contexts.get(conversationId),
						log: (line) => host.instance?.log(line),
						catalogChanged: (id) => host.instance?.schedulePiCatalog(id),
						ownerClosed: (id) => host.instance?.closePiCatalogWatch(id),
					})
				: undefined;
		// The one collection this host resolves and offers models from: pi-ai's
		// built-ins with the user's global-pi `models.json` custom providers
		// composed in (`configured-models.ts`), so the `/model` picker, the Settings
		// profile select and a run's own model resolution agree on what exists. A
		// `models.json` that cannot be used degrades to the built-ins and reports one
		// diagnostic, logged below once the host can log it.
		const modelDiagnostics: string[] = [];
		const models =
			options.models ??
			withDurableSession(
				await durableModels({
					credentialsPath: options.credentialsPath,
					onDiagnostic: (message) => modelDiagnostics.push(message),
				}),
			);
		const storage =
			options.storage ??
			(await openNodeSqliteStorage(options.layout.storagePath));
		const context: Context = BACKGROUND_CONTEXT;
		const liveCompaction = () => {
			const windows: Record<string, number | undefined> = {};
			for (const provider of models.getProviders())
				for (const model of models.getModels(provider.id))
					windows[`${model.provider}/${model.id}`] = model.contextWindow;
			return resolveModelCompactionPolicies(
				options.compaction?.() ?? options.settings.compaction ?? {},
				windows,
			);
		};
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				onReport,
				settings: {
					restartLimit: DEFAULT_RESTART_LIMIT,
					// A getter, not a snapshot: `HarnessSettings` are "read at every
					// resolution and never copied", so a saved configuration change reaches a
					// *running* conversation without a host restart (design D4). The
					// Catalog-derived exact entries also work during resume(), before
					// the run map exists; no conversation supplies another's window.
					get compaction() {
						return liveCompaction();
					},
					...(options.settings.retry ? { retry: options.settings.retry } : {}),
					...(options.settings.steeringMode
						? { steeringMode: options.settings.steeringMode }
						: {}),
					...(options.settings.followUpMode
						? { followUpMode: options.settings.followUpMode }
						: {}),
				},
				env: (target) => {
					const found = host.instance?.contexts.get(target.conversationId);
					if (!found) return undefined;
					return new NodeExecutionEnv({
						cwd: target.cwd ?? found.cwd,
						shellEnv: { ...process.env, ...found.env },
					});
				},
			},
			context,
		);
		try {
			await migrateAssociations(
				harness,
				context,
				// Injected storage is caller-owned (in-memory in focused tests).
				options.storage
					? undefined
					: () => backupHostStore(options.layout.storagePath),
			);
		} catch (error) {
			await harness.close(context);
			try {
				await localPiBridge?.closeAll();
				await codemode?.close();
			} catch {
				/* preserve the opening failure */
			}
			throw error;
		}
		const instance = new DurableHost(
			harness,
			options,
			models,
			codemode?.tool,
			codemode?.close,
			workflowTools.readOnlyTools,
			workflowTools.workflowTools,
			orchestrator,
			registry,
			localPiBridge,
		);
		host.instance = instance;
		try {
			const barriers = await harness.snapshot(StopBarriersDoc, context);
			for (const runId of Object.keys(barriers?.runs ?? {}))
				await instance.finishStopBarrier(runId);
		} catch (error) {
			await instance.shutdown();
			throw error;
		}
		harness.resume();
		for (const report of pendingReports)
			void instance.observeHarnessReport(report).catch(() => {
				/* reports are diagnostic and cannot affect the harness */
			});
		for (const diagnostic of modelDiagnostics) instance.log(diagnostic);
		for (const diagnostic of localPiDiagnostics) instance.log(diagnostic);
		return instance;
	}

	private compactionWaiters = 0;

	compactionWaitersForTest(): number {
		return this.compactionWaiters;
	}

	private readonly ensuringRuns = new Map<
		string,
		Promise<{ conversationId: string }>
	>();
	private readonly ensuringRoles = new Map<string, Promise<void>>();
	private readonly piCatalogWatches = new Map<
		ConversationId,
		() => Promise<void>
	>();
	private readonly piCatalogPending = new Set<ConversationId>();
	private readonly piCatalogWork = new Map<ConversationId, Promise<void>>();
	private readonly piCatalogAgain = new Set<ConversationId>();
	private piCatalogFailureReported = false;

	private reportPiCatalogFailure(): void {
		if (this.piCatalogFailureReported) return;
		this.piCatalogFailureReported = true;
		this.log("local Pi bridge catalog reconciliation failed");
	}

	private async closePiCatalogWatch(id: ConversationId): Promise<void> {
		this.piCatalogPending.delete(id);
		this.piCatalogAgain.delete(id);
		const stop = this.piCatalogWatches.get(id);
		this.piCatalogWatches.delete(id);
		await stop?.();
	}

	private async watchPiCatalog(id: ConversationId): Promise<void> {
		if (!this.localPiBridge?.hasOwner(id) || this.closing) return;
		if (this.piCatalogWatches.has(id)) {
			this.schedulePiCatalog(id);
			return;
		}
		const conversation = await this.harness.conversation(
			id,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return;
		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		if (this.closing || !this.localPiBridge.hasOwner(id)) {
			await watch.stop();
			return;
		}
		this.piCatalogWatches.set(id, async () => {
			await watch.stop();
		});
		watch.start(async (value) => {
			const live = value.docs["pi.live"] as { run?: unknown } | undefined;
			if (this.piCatalogPending.has(id) && !live?.run)
				this.schedulePiCatalog(id);
		});
		// Also close the notification gap between the initial snapshot and the
		// run record/watch installation. This is bounded admission work, not polling.
		this.schedulePiCatalog(id);
	}

	private schedulePiCatalog(id: ConversationId): void {
		if (this.closing) return;
		this.piCatalogPending.add(id);
		if (this.piCatalogWork.has(id)) {
			this.piCatalogAgain.add(id);
			return;
		}
		const record = [...this.runs.values()].find(
			(run) => run.conversationId === id,
		);
		if (!record) return;
		const work = this.serialized(record, async () => {
			await Promise.allSettled([...this.ensuringRuns.values()]);
			if (this.closing || !this.piCatalogWatches.has(id)) return;
			const run = this.contexts.get(id);
			if (!run) return;
			const idle = await this.harness.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, id);
				const agent = await tx.doc(AgentDoc, id);
				if (
					this.closing ||
					!this.piCatalogWatches.has(id) ||
					this.contexts.get(id) !== run
				)
					return;
				const busy = live.run !== undefined;
				// The idle test and selection commit share the Harness transaction:
				// queued generations cannot start between a stale idle read and configure.
				this.localPiBridge?.reconcileCatalog(id, busy);
				const selected =
					this.localPiBridge?.toolsForPolicy(id, run.toolPolicy) ?? [];
				const current = agent.tools;
				if (!Array.isArray(current)) return;
				const names = new Set(
					current.filter(
						(name) => busy || !this.localPiBridge?.isBridgeToolName(name),
					),
				);
				for (const tool of selected) names.add(tool.name);
				const next = [...names];
				if (
					next.length !== current.length ||
					next.some((name, index) => current[index] !== name)
				) {
					const available = new Map(
						this.registry
							.snapshot()
							.tools()
							.map(({ tool }) => [tool.name, tool]),
					);
					const tools = next.map((name) => {
						const tool = available.get(name);
						if (!tool)
							throw new Error("local Pi bridge selected tool unavailable");
						return tool;
					});
					await configure(tx, id, { tools });
				}
				return !busy;
			}, BACKGROUND_CONTEXT);
			if (idle) {
				this.piCatalogPending.delete(id);
				this.localPiBridge?.pruneCatalog();
			}
		});
		const settled = work
			.catch(() => this.reportPiCatalogFailure())
			.finally(() => {
				this.piCatalogWork.delete(id);
				if (this.piCatalogAgain.delete(id) && this.piCatalogWatches.has(id))
					this.schedulePiCatalog(id);
			});
		this.piCatalogWork.set(id, settled);
	}

	ensureRun(
		input: EnsureRunInput,
		managedAdmission = false,
	): Promise<{ conversationId: string }> {
		if (this.closing) return Promise.reject(new Error("host is shutting down"));
		const pending = this.ensuringRuns.get(input.runId);
		if (pending) return pending;
		// Duplicate/replayed run requests converge; distinct runs that reuse one
		// role are ordered through live-record installation, not only the commit.
		const previous = this.ensuringRoles.get(input.name) ?? Promise.resolve();
		const operation = previous.then(() =>
			this.ensureRunOnce(input, managedAdmission),
		);
		this.ensuringRuns.set(input.runId, operation);
		const settled = operation.then(
			() => {},
			() => {},
		);
		this.ensuringRoles.set(input.name, settled);
		void settled.then(() => {
			if (this.ensuringRuns.get(input.runId) === operation)
				this.ensuringRuns.delete(input.runId);
			if (this.ensuringRoles.get(input.name) === settled)
				this.ensuringRoles.delete(input.name);
		});
		return operation;
	}

	private async ensureRunOnce(
		input: EnsureRunInput,
		managedAdmission: boolean,
	): Promise<{ conversationId: string }> {
		const context = BACKGROUND_CONTEXT;
		const key = input.name;
		// The run's environment is read before the tool selection: the `debug`
		// role is what withholds the delegated debug request tools, and it is
		// named in the environment, not in the ensure request.
		let envVars: Record<string, string> = {};
		try {
			envVars = parseRunEnvFile(fs.readFileSync(input.runEnvPath, "utf8"));
		} catch {
			/* a run without a readable run.env still launches, with an empty environment */
		}
		if (
			envVars.HERDR_WORKFLOW_ID &&
			!managedAdmission &&
			input.expectedConversationId === undefined
		)
			throw new Error(
				"Managed launch requires server-verified admission; legacy unfenced ensure refused",
			);
		if (!managedAdmission && input.expectedConversationId === undefined) {
			const fence = await this.harness.snapshot(
				launchFenceDoc("role", input.name),
				context,
			);
			if (fence?.runId)
				throw new Error(
					"Managed role requires server-verified admission; legacy role takeover refused",
				);
		}
		const ownership = await this.harness.snapshot(
			associationDoc("run", input.runId),
			context,
		);
		const role = ownership?.conversationId
			? undefined
			: await this.harness.snapshot(associationDoc("role", key), context);
		const existingId = ownership?.conversationId || role?.conversationId;
		if (
			input.expectedConversationId !== undefined &&
			String(existingId) !== input.expectedConversationId
		)
			throw new Error("run recovery conversation ownership mismatch");
		let conversation: Conversation | undefined = existingId
			? await this.harness.conversation(existingId as ConversationId, context)
			: undefined;
		if (input.expectedConversationId !== undefined && !conversation)
			throw new Error("run recovery conversation is missing");
		if (input.expectedConversationId !== undefined) {
			for (const [runId, record] of this.runs) {
				if (
					runId !== input.runId &&
					record.conversationId === existingId &&
					this.ownsConversation(runId, record.conversationId)
				)
					throw new Error(
						"run recovery refused: conversation has another live owner",
					);
			}
		}
		const readOnly = input.toolPolicy === "read-only";
		const debugRun = envVars.HERDR_ROLE === "debug";
		const initialToolSelection = this.toolSelectionFor(
			input.toolPolicy,
			debugRun,
		);
		// Whether this run is the one the conversation was made for, which is what
		// separates a `created` session window from an `adopted` one.
		let createdConversation = false;
		if (!conversation) {
			conversation = await this.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: {
						...(input.model ? { model: parseModelRef(input.model) } : {}),
						...(input.thinking
							? { thinkingLevel: input.thinking as never }
							: {}),
						cwd: input.cwd,
						...(initialToolSelection ? { tools: initialToolSelection } : {}),
					},
				},
				context,
			);
			createdConversation = true;
		}
		// Commit just this role and run's keyed associations before returning the
		// handle. Historical ownership stays addressable without a growing map.
		const conversationId = conversation.id as unknown as number;
		await this.harness.commit(async (tx) => {
			if (createdConversation) {
				const role = await tx.doc(associationDoc("role", key));
				role.conversationId = conversationId;
			}
			const issued = await tx.doc(associationDoc("run", input.runId));
			issued.conversationId = conversationId;
		}, context);
		const runContext: DurableRunContext = {
			runId: input.runId,
			toolPolicy: input.toolPolicy,
			cwd: input.cwd,
			env: envVars,
			lastDeveloperMessage: () =>
				this.answeredDeveloperMessage(conversation.id),
			...(readJevBinding(envVars) ? { jev: readJevBinding(envVars) } : {}),
		};
		this.contexts.set(conversation.id, runContext);
		this.runContexts.set(input.runId, runContext);
		try {
			await this.localPiBridge?.ensureConversation(conversation.id, input.cwd);
		} catch {
			this.log("local Pi bridge session initialization failed");
		}
		const toolSelection = this.toolSelectionFor(
			input.toolPolicy,
			debugRun,
			conversation.id,
		);
		if (toolSelection)
			await conversation.configure(
				{ tools: toolSelection, cwd: input.cwd },
				context,
			);
		else await conversation.configure({ cwd: input.cwd }, context);
		const model =
			(await this.conversationModelRef(conversation)) ?? input.model;
		this.runs.set(input.runId, {
			conversationId: conversation.id,
			readOnly,
			...(envVars.HERDR_ROLE ? { role: envVars.HERDR_ROLE } : {}),
			...(model ? { model } : {}),
		});
		await this.watchPiCatalog(conversation.id);
		const identity: TelemetryIdentity = {
			workflowId: envVars.HERDR_WORKFLOW_ID,
			runId: envVars.HERDR_RUN_ID,
			stepId: envVars.HERDR_STEP_ID,
			role: envVars.HERDR_ROLE,
			profile: envVars.HERDR_PROFILE,
			generation: Number.isFinite(Number(envVars.HERDR_RUN_GENERATION))
				? Number(envVars.HERDR_RUN_GENERATION)
				: undefined,
			telemetryPath: envVars.HERDR_TELEMETRY_PATH,
			captureContent: envVars.HERDR_CAPTURE_CONTENT === "1",
		};
		// The ceiling's own envelopes go to the same file as the run's, including
		// for a conversation whose telemetry stream could not be attached.
		this.telemetryIdentities.set(conversation.id, identity);
		// The conversation's session window: bind it to this run and state the move
		// (efficiency backlog item 20). Pure observation — it writes no workflow
		// state, and a failure to emit never fails the run.
		await this.recordSessionWindow(
			conversation.id,
			identity,
			createdConversation,
		);
		// The dead-surface monitor of this run, or none for a session the rule
		// leaves alone (no run id, or an exempt role such as `env-setup`).
		const monitor = toolSurfaceMonitorFor(envVars);
		if (!this.telemetry.has(conversation.id)) {
			const conversationId = conversation.id;
			try {
				const stop = await attachTelemetry(
					this.harness,
					conversationId,
					context,
					// The binding, not this run's identity: the stream outlives the run it
					// was attached for, and a later run of the same step and role must
					// record its own turns instead of the creating run's.
					() => this.sessionBindingOf(conversationId)?.identity ?? identity,
					{
						onTiming: (entryId, timing) => {
							const existing = this.timings.get(conversation.id) ?? {};
							this.timings.set(conversation.id, {
								...existing,
								[entryId]: timing,
							});
							for (const listener of this.timingListeners.get(
								conversation.id,
							) ?? [])
								listener();
						},
						// The measured context of one committed turn is also the cost
						// ceiling's input, so one event stream serves both and the ceiling
						// is decided between turns, never inside a tool call. The ceiling is
						// resolved for the run the measurement was recorded under, so a run
						// reusing a conversation is judged by its own window and profile.
						onMeasuredContext: ({ promptTokens, turnIndex }, measured) =>
							this.observeContext(
								measured.runId ??
									this.boundRunId(conversationId) ??
									input.runId,
								promptTokens,
								turnIndex,
							),
						compactionKind: (taskId) => {
							const pending = this.ceilingPending.get(conversation.id) ?? 0;
							if (pending > 0) {
								this.ceilingPending.set(conversation.id, pending - 1);
								this.ceilingCompactions.add(taskId);
								return "auto-ceiling";
							}
							return this.ceilingCompactions.has(taskId)
								? "auto-ceiling"
								: undefined;
						},
						// The dead-surface rule observes every finished tool call, charged to
						// the run that started the call: a late failure of an earlier run's
						// call must never stop the run now bound to the conversation.
						onToolOutcome: (observation: ToolOutcomeObservation, owner) =>
							this.onToolOutcome(
								owner.runId ?? this.boundRunId(conversationId) ?? input.runId,
								conversationId,
								observation,
							),
					},
				);
				this.telemetry.set(conversationId, stop);
			} catch {
				/* telemetry is observational only; a failed attach never fails the run */
			}
		}
		// The dead-surface monitor is per conversation but belongs to the run
		// serving it: a run that reuses an already-attached conversation still
		// installs its own monitor (the hook installed with the stream reads it at
		// call time), and a run the rule exempts installs none.
		if (monitor) this.toolSurfaces.set(conversation.id, monitor);
		const activeRun = this.runs.get(input.runId);
		if (ownership?.conversationId && activeRun) {
			this.log(`ensureRun ${input.runId} -> conversation ${conversation.id}`);
			await this.restoreParkedTaskFailure(input.runId, activeRun);
		}
		return { conversationId: String(conversation.id) };
	}

	/** The conversation's current run binding, or undefined for a session that
	 * never carried a run id (an orchestrator session records no window). */
	private sessionBindingOf(
		conversationId: ConversationId,
	): SessionBinding | undefined {
		return this.sessionBindings.get(conversationId);
	}

	private boundRunId(conversationId: ConversationId): string | undefined {
		return this.sessionBindings.get(conversationId)?.runId;
	}

	/** Whether this run still owns the conversation's own state: true while the
	 * binding still names it (or the conversation never carried a run id), false once
	 * a successor was bound. Every conversation-keyed delete goes through it, so the
	 * guard cannot drift between call sites. */
	private ownsConversation(
		runId: string,
		conversationId: ConversationId,
	): boolean {
		const bound = this.sessionBindingOf(conversationId)?.runId;
		return bound === undefined || bound === runId;
	}

	/** Bind one conversation to the run that is about to work on it and state the
	 * move as the session window (efficiency backlog item 20). A conversation
	 * bound to a different run first closes that run's window (`closed`, naming
	 * the run now bound) and then opens this one's (`opened`, reason `rebound`);
	 * a conversation made for this run opens with `created`, one whose previous
	 * run this host cannot name (a restart) with `adopted`, and one bound to the
	 * same run again (an abort, then a resume) with `resumed`.
	 *
	 * Best-effort and observational, like every envelope: it writes no workflow
	 * state, changes no conversation, and a failed emission leaves the run and the
	 * workflow exactly as they would be without the record. Nothing is recorded
	 * for a conversation with no run id in its environment.
	 *
	 * Two ordering rules make the record trustworthy rather than lucky:
	 * - the stream is drained before the binding moves, because pi-durable
	 *   publishes a commit's events synchronously and delivers them one microtask
	 *   later: without the wait, a batch already committed under the leaving run
	 *   would resolve the *new* identity and re-stamp that run's turns;
	 * - a `closed` record that could not be written (an unwritable telemetry path,
	 *   a removed workspace) is retried in the same transition, into the binding
	 *   that now holds the conversation, and on the conversation's next binding if
	 *   that fails too, because its absence is what a reader treats as a defect.
	 *
	 * The transition is serialized per conversation: reading the previous binding,
	 * draining, writing the new one and emitting are one step, so two overlapping
	 * rebindings can neither close the same run twice nor name a successor that
	 * never held the conversation. */
	private recordSessionWindow(
		conversationId: ConversationId,
		identity: TelemetryIdentity,
		createdConversation: boolean,
	): Promise<void> {
		const prior =
			this.sessionWindowChain.get(conversationId) ?? Promise.resolve();
		const record = prior.then(() =>
			this.applySessionWindow(conversationId, identity, createdConversation),
		);
		// The chain keeps its place even when one record fails, and is dropped once it
		// is the last one, so a long-lived conversation does not accumulate entries.
		const tail = record.catch(() => undefined);
		this.sessionWindowChain.set(conversationId, tail);
		void tail.then(() => {
			if (this.sessionWindowChain.get(conversationId) === tail)
				this.sessionWindowChain.delete(conversationId);
		});
		return tail;
	}

	/** One session-window transition: the previous binding, the drain, the new
	 * binding and its two envelopes. Called only through
	 * {@link recordSessionWindow}, which serializes it per conversation. */
	private async applySessionWindow(
		conversationId: ConversationId,
		identity: TelemetryIdentity,
		createdConversation: boolean,
	): Promise<void> {
		const runId = identity.runId;
		if (runId === undefined) return;
		const previous = this.sessionBindings.get(conversationId);
		const rebinding = previous !== undefined && previous.runId !== runId;
		if (rebinding) {
			// One macrotask turn: every frame the leaving run already committed is
			// delivered first (a delivery is scheduled as a microtask), so it is
			// stamped with the identity that produced it.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		this.sessionBindings.set(conversationId, { runId, identity });
		try {
			if (previous !== undefined && rebinding) {
				const written = emitSessionWindow(
					conversationId,
					"runtime.session_window.closed",
					previous.identity,
					{ "herdr.session.rebound_to": runId },
				);
				// A close nobody wrote is a tail nobody can explain: keep it and write it
				// here, into the binding that now holds the conversation (the path that
				// failed is the leaving run's, which is what made the write fail), or on
				// the conversation's next binding if that fails too.
				if (!written)
					this.enqueueSessionClose(conversationId, previous.identity, runId);
				this.flushPendingSessionCloses(conversationId, identity);
				emitSessionWindow(
					conversationId,
					"runtime.session_window.opened",
					identity,
					{
						"herdr.session.reason": "rebound" satisfies SessionWindowReason,
						"herdr.session.previous_run_id": previous.runId,
					},
				);
				return;
			}
			// A binding that closes nothing still carries the retry: a close an earlier
			// move could not write is written into this binding's own file.
			this.flushPendingSessionCloses(conversationId, identity);
			const reason: SessionWindowReason =
				previous !== undefined
					? "resumed"
					: createdConversation
						? "created"
						: "adopted";
			emitSessionWindow(
				conversationId,
				"runtime.session_window.opened",
				identity,
				{ "herdr.session.reason": reason },
			);
		} catch {
			/* the session window is an observation; it never fails the run */
		}
	}

	/** Keep a `closed` record that could not be written, so the conversation's next
	 * binding can write it into its own run's telemetry file. */
	private enqueueSessionClose(
		conversationId: ConversationId,
		identity: TelemetryIdentity,
		reboundTo: string,
	): void {
		const pending = this.pendingSessionCloses.get(conversationId) ?? [];
		pending.push({ identity, reboundTo });
		while (pending.length > MAX_PENDING_SESSION_CLOSES) pending.shift();
		this.pendingSessionCloses.set(conversationId, pending);
	}

	/** Retry every close the recording still owes, into this binding's own telemetry
	 * file — the path that failed was the leaving run's, which is what made the
	 * write fail — and drop each one only once it landed. */
	private flushPendingSessionCloses(
		conversationId: ConversationId,
		sink: TelemetryIdentity,
	): void {
		const pending = this.pendingSessionCloses.get(conversationId);
		if (pending === undefined || pending.length === 0) return;
		const kept: PendingSessionClose[] = [];
		for (const close of pending) {
			const written = emitSessionWindow(
				conversationId,
				"runtime.session_window.closed",
				{ ...close.identity, telemetryPath: sink.telemetryPath },
				{ "herdr.session.rebound_to": close.reboundTo },
			);
			if (!written) kept.push(close);
		}
		if (kept.length === 0) this.pendingSessionCloses.delete(conversationId);
		else this.pendingSessionCloses.set(conversationId, kept);
	}

	/** The explicit tool list for a policy, or undefined for the full default
	 * selection. A policy the host's mode cannot serve is refused, so a workflow
	 * run never lands on an orchestrator host or the other way around. */
	private toolSelectionFor(
		policy: ToolPolicy,
		debugRun = false,
		conversationId?: ConversationId,
	) {
		const imported = conversationId
			? (this.localPiBridge?.toolsForPolicy(conversationId, policy) ?? [])
			: [];
		const withImported = (
			base: readonly ToolRegistration[],
		): readonly ToolRegistration[] => [...base, ...imported];
		const withToolSearch = (
			base: readonly ToolRegistration[],
		): readonly ToolRegistration[] => {
			if (!this.localPiBridge) return base;
			const searchTool = this.registry
				.snapshot()
				.tools()
				.find(({ tool }) => tool.name === TOOL_SEARCH_TOOL_NAME)?.tool;
			return searchTool ? [...base, searchTool] : base;
		};
		const allNativeTools = () =>
			this.registry
				.snapshot()
				.tools()
				.filter(({ tool }) => !this.localPiBridge?.isBridgeToolName(tool.name))
				.map(({ tool }) => tool);
		if (this.orchestratorExtension) {
			if (policy !== "orchestrator")
				throw new Error("this host only serves the orchestrator session");
			// The orchestrator decides for itself whether a request is a direct edit
			// or a workflow: it gets the full coding tools (read/write/edit/bash)
			// alongside workflow management and operational tools, not a read-only subset.
			return withImported(
				withToolSearch([
					...codingTools(false),
					...(this.orchestratorExtension.tools ?? []),
					...this.workflowTools,
					...(this.codemodeTool ? [this.codemodeTool] : []),
				]),
			);
		}
		if (this.options.session) {
			if (policy !== "default")
				throw new Error("this host only serves the coding session");
			// The session's default selection is exactly the coding tools plus the
			// search extension, prompt context and any configured codemode: the
			// host installed nothing else. When the bridge is enabled, name that
			// native set explicitly so another conversation's imported tools cannot
			// leak through the registry-wide default.
			return this.localPiBridge ? withImported(allNativeTools()) : undefined;
		}
		if (policy === "orchestrator")
			throw new Error("the orchestrator policy needs an orchestrator host");
		if (policy === "read-only")
			return withImported(withToolSearch(this.readOnlyToolSelection(debugRun)));
		// A debug run's tool list is explicit for one reason: the default
		// selection would offer the delegated debug request tools, and a debug
		// run must not delegate another request.
		if (!debugRun)
			return this.localPiBridge ? withImported(allNativeTools()) : undefined;
		return withImported(
			withToolSearch([
				...codingTools(false),
				...withoutDebugRequestTools(this.workflowTools),
				...(this.codemodeTool ? [this.codemodeTool] : []),
			]),
		);
	}

	private readOnlyToolSelection(debugRun = false) {
		// codemode stays offered to a read-only run (its script can only reach the
		// tools this selection names, so `write`/`edit` remain unreachable), and
		// with it the search and in-session judgment tools a verifier's review
		// leans on.
		return [
			...codingTools(true),
			...(debugRun
				? withoutDebugRequestTools(this.readOnlyTools)
				: this.readOnlyTools),
			...(this.codemodeTool ? [this.codemodeTool] : []),
		];
	}

	/** Test-only: the description of every tool this host installed, by tool
	 * name (the last install of a name wins, as it does for a run). Not part of
	 * the control protocol; focused tests use this to confirm that a description
	 * names only the tools a run of this host actually has — the host resolves
	 * the tool surface once, so the registration and the descriptions can never
	 * disagree (efficiency backlog item 14). */
	toolDescriptionsForTest(): Record<string, string> {
		const descriptions: Record<string, string> = {};
		for (const { tool } of this.registry.snapshot().tools()) {
			const name = (tool as { readonly name?: unknown }).name;
			const description = (tool as { readonly description?: unknown })
				.description;
			if (typeof name === "string" && typeof description === "string")
				descriptions[name] = description;
		}
		return descriptions;
	}

	/** Test-only: the committed transcript entries of one run's conversation.
	 * Not part of the control protocol; focused tests use this to confirm what a
	 * tool call actually produced (durable-agent-host: "Per-run execution
	 * environment"). */
	async entriesForTest(runId: string): Promise<readonly unknown[]> {
		const record = this.runs.get(runId);
		if (!record) return [];
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return [];
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		const entries = state.value.entries;
		state.dispose();
		return entries;
	}

	/** Test-only: the policy `pi-durable` resolves right now, and the reference
	 * window a percentage resolves against. Not part of the control protocol;
	 * focused tests use these to confirm the live getter and the window
	 * resolution (durable-agent-compaction). */
	compactionPolicyForTest(model?: string): CompactionPolicy {
		return model
			? resolveCompactionPolicy(
					compactionConfigForModel(this.compactionConfig(), model),
					this.modelWindow(model),
				)
			: this.compactionPolicy();
	}

	referenceWindowForTest(model?: string): number | undefined {
		return model ? this.modelWindow(model) : undefined;
	}

	private requireConversation(runId: string): RunRecord {
		const found = this.runs.get(runId);
		if (!found) throw new Error(`unknown run: ${runId}`);
		return found;
	}

	private async restoreParkedTaskFailure(
		runId: string,
		run: RunRecord,
	): Promise<void> {
		try {
			const stored = await this.harness.snapshot(
				runtimeFailureDoc(run.conversationId),
				BACKGROUND_CONTEXT,
			);
			if (
				stored?.active &&
				stored.runId === runId &&
				stored.kind === "task_parked" &&
				stored.reason === "restart_limit"
			)
				return;
			const parkedTaskId = await this.parkedTaskForRestore(run.conversationId);
			if (!parkedTaskId) return;
			await this.observeHarnessReport({
				kind: "task_parked",
				domain: "task",
				taskId: parkedTaskId,
				reason: "restart_limit",
				error: "HarnessError",
				conversationId: run.conversationId,
			});
		} catch {
			this.log("parked task state could not be restored after host reopen");
		}
	}

	/** A paged, conversation-scoped lookup, never Harness.inspect(): that also
	 * materializes unrelated tasks and queued submissions for the entire host. */
	private async parkedTaskForRestore(
		conversationId: ConversationId,
	): Promise<string | undefined> {
		return this.harness.commit(async (tx) => {
			let cursor: Cursor | undefined;
			do {
				const page = await tx.scanTasks(
					{ conversationId, status: "pending" },
					64,
					cursor,
				);
				for (const task of page.items) {
					if (isRestartLimitParked(task))
						return safeFailureMessage(String(task.id), 128);
				}
				cursor = page.next;
			} while (cursor !== undefined);
			return undefined;
		}, BACKGROUND_CONTEXT);
	}

	private async persistRuntimeFailure(
		report: HarnessFailureReport,
		runId: string,
		conversationId: ConversationId,
	): Promise<void> {
		const doc = runtimeFailureDoc(conversationId);
		let taskRestarts: number | undefined;
		const nativeTaskId = parseTaskId(report.taskId ?? "");
		if (report.kind === "task_parked" && nativeTaskId !== undefined) {
			try {
				const task = await this.harness.getTask(
					nativeTaskId,
					BACKGROUND_CONTEXT,
				);
				// A delayed duplicate callback cannot revive an episode after native
				// retry cleared its restart counter or the task made progress.
				if (task && !isRestartLimitParked(task)) {
					this.notifyRuntimeFailure(conversationId);
					return;
				}
				taskRestarts = taskRestartCount(task);
			} catch {
				// Failure persistence remains best effort if native state is unavailable.
			}
		}
		const value: RuntimeFailureDoc = {
			active: true,
			runId,
			conversationId,
			generation: 0,
			retryAcceptedGeneration: -1,
			retryAcceptedRestarts: -1,
			kind: report.kind,
			domain: report.domain,
			taskId: report.taskId ?? "",
			reason:
				report.reason ?? (report.kind === "task_parked" ? "restart_limit" : ""),
			error: report.error ?? "",
		};
		try {
			await this.harness.commit(async (tx) => {
				const current = await tx.doc(doc);
				const currentGeneration =
					Number.isSafeInteger(current.generation) && current.generation >= 0
						? current.generation
						: 0;
				const sameFailure =
					current.active &&
					current.runId === value.runId &&
					current.conversationId === value.conversationId &&
					current.kind === value.kind &&
					current.domain === value.domain &&
					current.taskId === value.taskId &&
					current.reason === value.reason;
				const retryAccepted =
					current.retryAcceptedGeneration === currentGeneration;
				const reparkedAfterAcceptance =
					retryAccepted &&
					taskRestarts !== undefined &&
					current.retryAcceptedRestarts >= 0 &&
					taskRestarts > current.retryAcceptedRestarts;
				const sameEpisode = sameFailure && !reparkedAfterAcceptance;
				const generation = sameEpisode
					? currentGeneration
					: currentGeneration + 1;
				Object.assign(current, value, {
					generation,
					retryAcceptedGeneration: sameEpisode
						? current.retryAcceptedGeneration
						: -1,
					retryAcceptedRestarts: sameEpisode
						? current.retryAcceptedRestarts
						: -1,
				});
			}, BACKGROUND_CONTEXT);
		} catch (error) {
			this.enqueueRuntimeFailureLog(
				`runtime failure report could not be retained (${error instanceof Error ? "HarnessError" : "UnknownError"})`,
			);
		}
		this.notifyRuntimeFailure(conversationId);
	}

	private async clearRuntimeFailure(
		conversationId: ConversationId,
		generation: number,
	): Promise<void> {
		try {
			await this.harness.commit(async (tx) => {
				const current = await tx.doc(runtimeFailureDoc(conversationId));
				if ((current.generation ?? 0) !== generation) return;
				current.active = false;
				current.runId = "";
				current.taskId = "";
				current.reason = "";
				current.error = "";
			}, BACKGROUND_CONTEXT);
		} catch {
			/* clearing an expired synthetic view is best effort; native task state wins */
		}
		this.notifyRuntimeFailure(conversationId);
	}

	private notifyRuntimeFailure(conversationId: ConversationId): void {
		for (const notify of this.runtimeFailureListeners.get(conversationId) ??
			[]) {
			try {
				notify();
			} catch {
				/* observers cannot affect the host's report path */
			}
		}
	}

	private async markRuntimeFailureRetryAccepted(
		runId: string,
		conversationId: ConversationId,
		taskId: string,
		generation: number,
		taskRestarts: number | undefined,
	): Promise<boolean> {
		let marked = false;
		try {
			await this.harness.commit(async (tx) => {
				const current = await tx.doc(runtimeFailureDoc(conversationId));
				if (
					!current?.active ||
					current.runId !== runId ||
					current.conversationId !== conversationId ||
					current.kind !== "task_parked" ||
					current.taskId !== taskId ||
					current.reason !== "restart_limit" ||
					(current.generation ?? 0) !== generation ||
					current.retryAcceptedGeneration === generation
				)
					return;
				current.retryAcceptedGeneration = generation;
				current.retryAcceptedRestarts = taskRestarts ?? -1;
				marked = true;
			}, BACKGROUND_CONTEXT);
		} catch {
			return false;
		}
		return marked;
	}

	private async runtimeFailureFor(
		runId: string,
		record: RunRecord,
	): Promise<RuntimeFailure | undefined> {
		let stored: Readonly<RuntimeFailureDoc> | undefined;
		try {
			stored = await this.harness.snapshot(
				runtimeFailureDoc(record.conversationId),
				BACKGROUND_CONTEXT,
			);
		} catch {
			return undefined;
		}
		if (
			!stored?.active ||
			stored.runId !== runId ||
			stored.conversationId !== record.conversationId
		)
			return undefined;
		const nativeTaskId = parseTaskId(stored.taskId);
		if (stored.taskId && nativeTaskId !== undefined) {
			let task: unknown;
			try {
				task = await this.harness.getTask(nativeTaskId, BACKGROUND_CONTEXT);
			} catch {
				// Keep the bounded report visible if the native task is temporarily
				// unavailable; retry still re-reads and fails closed.
			}
			if (stored.kind === "task_parked") {
				const state = taskState(task);
				const hasCurrentState = task !== undefined;
				const parked = task !== undefined && isRestartLimitParked(task);
				if (hasCurrentState && !parked && state.status !== undefined) {
					await this.clearRuntimeFailure(
						record.conversationId,
						stored.generation ?? 0,
					);
					return undefined;
				}
			}
			if (
				stored.kind === "task_faulted" &&
				taskState(task).status === "running"
			) {
				await this.clearRuntimeFailure(
					record.conversationId,
					stored.generation ?? 0,
				);
				return undefined;
			}
		}
		return {
			kind: stored.kind,
			domain: stored.domain,
			generation: stored.generation ?? 0,
			...(stored.taskId ? { taskId: stored.taskId } : {}),
			...(stored.reason ? { reason: stored.reason } : {}),
			...(stored.error ? { error: stored.error } : {}),
		};
	}

	private async observeHarnessReport(
		report: HarnessFailureReport,
	): Promise<void> {
		const conversationId =
			report.conversationId !== undefined
				? (report.conversationId as ConversationId)
				: undefined;
		let owner: { runId: string; record: RunRecord } | undefined;
		if (conversationId !== undefined) {
			const runId = this.boundRunId(conversationId);
			const record = runId ? this.runs.get(runId) : undefined;
			if (
				runId &&
				record?.conversationId === conversationId &&
				this.ownsConversation(runId, record.conversationId)
			)
				owner = { runId, record };
		}
		const identity = owner
			? this.telemetryIdentities.get(owner.record.conversationId)
			: undefined;
		try {
			if (identity)
				emitRuntimeEnvelope(identity, "runtime.failure", {
					"pi.failure.kind": report.kind,
					"pi.failure.domain": report.domain,
					...(report.taskId ? { "pi.task.id": report.taskId } : {}),
					...(report.reason ? { "pi.failure.reason": report.reason } : {}),
					...(report.error ? { "pi.failure.error": report.error } : {}),
				});
		} catch {
			/* telemetry is observational; retain the durable status regardless */
		}
		this.enqueueRuntimeFailureLog(
			`harness ${report.kind}${report.taskId ? ` task=${report.taskId}` : ""}${report.reason ? ` reason=${report.reason}` : ""}${report.error ? ` error=${report.error}` : ""}`,
		);
		if (
			owner &&
			owner.record.conversationId ===
				(conversationId ?? owner.record.conversationId)
		)
			await this.persistRuntimeFailure(
				report,
				owner.runId,
				owner.record.conversationId,
			);
	}

	/** One conversation's current model ref, from `pi.agent`: the document both
	 * `ensureRun`'s model and a live `/model` override write. */
	private async conversationModelRef(
		conversation: Conversation,
	): Promise<string | undefined> {
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		try {
			const agent = state.value.docs["pi.agent"] as
				| { model?: { provider?: unknown; modelId?: unknown } }
				| undefined;
			const model = agent?.model;
			if (
				!model ||
				typeof model.provider !== "string" ||
				typeof model.modelId !== "string"
			)
				return undefined;
			return `${model.provider}/${model.modelId}`;
		} finally {
			state.dispose();
		}
	}

	/** A model ref's context window from the host's catalog; cached because the
	 * compaction policy is resolved on pi-durable's Session line. */
	private modelWindow(ref: string): number | undefined {
		if (this.modelWindows.has(ref)) return this.modelWindows.get(ref);
		const separator = ref.indexOf("/");
		const provider = separator < 0 ? ref : ref.slice(0, separator);
		const id = separator < 0 ? "" : ref.slice(separator + 1);
		let window: number | undefined;
		for (const model of this.models?.getModels(provider) ?? []) {
			if (model.id !== id) continue;
			if (typeof model.contextWindow === "number") window = model.contextWindow;
			break;
		}
		this.modelWindows.set(ref, window);
		return window;
	}

	/** The effective compaction section, re-read at every resolution (design D4). */
	private compactionConfig(): CompactionConfig {
		return (
			this.options.compaction?.() ?? this.options.settings.compaction ?? {}
		);
	}

	/** The no-model fallback. Native exact policies are built by the live getter. */
	private compactionPolicy(): CompactionPolicy {
		return resolveCompactionPolicy(
			compactionConfigForModel(this.compactionConfig()),
		);
	}

	/** The cost ceiling of one run: resolved against that run's own model window
	 * (the window its conversation actually has), using absolute defaults when
	 * its model is unknown. Other conversations never supply a fallback window. */
	private resolveRunCeiling(record: RunRecord): CompactionCeiling {
		const window = record.model ? this.modelWindow(record.model) : undefined;
		const config = compactionConfigForModel(
			this.compactionConfig(),
			record.model,
		);
		if (record.role !== "stage-tester")
			return resolveCompactionCeiling(config, window);
		const resolved = resolveCompactionCeiling(config, window);
		const ceilingTokens = Math.min(
			resolved.ceilingTokens,
			STAGE_TESTER_COMPACTION_CEILING_TOKENS,
		);
		return resolveCompactionCeiling({ ...config, ceilingTokens }, window);
	}

	/**
	 * Measure one committed turn against the cost ceiling (efficiency backlog
	 * item 6). The measurement arrives at an assistant message boundary, so the
	 * compaction it admits is placed at the next turn boundary: pi-durable writes
	 * a conversation-owned summary through a submission and never interrupts a
	 * tool call. Every path is best-effort and reports through telemetry; a
	 * ceiling that cannot be evaluated must never fail the run.
	 */
	private observeContext(
		runId: string,
		promptTokens: number,
		turnIndex: number,
	): void {
		const record = this.runs.get(runId);
		if (!record) return;
		const ceiling = this.resolveRunCeiling(record);
		const state =
			this.ceilings.get(record.conversationId) ??
			({ turnIndex, compactionTurns: [] } satisfies CeilingRecord);
		state.turnIndex = Math.max(state.turnIndex, turnIndex);
		this.ceilings.set(record.conversationId, state);
		const identity = this.telemetryIdentities.get(record.conversationId);
		if (state.awaitingBaseline) {
			// The first measurement after an admitted compaction is the reduced
			// context: the base the token floor counts new context from.
			state.baselineTokens = promptTokens;
			state.awaitingBaseline = false;
		}
		if (!ceiling.active) {
			// The ceiling is a lower trigger than the overflow guard by definition. On
			// a small window the guard is already the tighter one, so the ceiling is
			// reported once as ignored instead of compacting twice in a row.
			if (
				ceiling.inactive === "above-overflow" &&
				!state.warnedAboveOverflow &&
				identity
			) {
				state.warnedAboveOverflow = true;
				emitRuntimeEnvelope(identity, "runtime.compaction_ceiling", {
					status: "ignored",
					reason: "above-overflow",
					ceilingTokens: ceiling.ceilingTokens,
					...(ceiling.overflowTokens !== undefined
						? { overflowTokens: ceiling.overflowTokens }
						: {}),
					contextTokens: promptTokens,
				});
			}
			return;
		}
		const decision = evaluateCompactionCeiling({
			ceiling,
			contextTokens: promptTokens,
			state: {
				...state,
				...(state.baselineTokens !== undefined
					? { lastCompactionTokens: state.baselineTokens }
					: {}),
			},
		});
		if (decision.kind === "compact") {
			void this.admitCeilingCompaction(
				runId,
				record,
				state,
				ceiling,
				promptTokens,
			);
			return;
		}
		if (decision.reason === "loop-guard" && !state.suspended) {
			// A visible warning, not a silent stop: three compactions inside ten turns
			// means the ceiling cannot keep the context down, so ceiling compaction
			// ends for this conversation and the developer is told.
			state.suspended = true;
			if (identity)
				emitRuntimeEnvelope(identity, "runtime.compaction_ceiling", {
					status: "suspended",
					reason: "loop-guard",
					ceilingTokens: ceiling.ceilingTokens,
					contextTokens: promptTokens,
					compactionsInWindow: state.compactionTurns.filter(
						(turn) => state.turnIndex - turn < ceiling.loopTurns,
					).length,
					windowTurns: ceiling.loopTurns,
					loopLimit: ceiling.loopLimit,
				});
		}
	}

	/** Admit one ceiling compaction, serially with the conversation's other
	 * mutations, at most one per conversation. */
	private async admitCeilingCompaction(
		runId: string,
		record: RunRecord,
		state: CeilingRecord,
		ceiling: CompactionCeiling,
		contextTokens: number,
	): Promise<void> {
		try {
			await this.serialized(record, async () => {
				const conversation = await this.harness.conversation(
					record.conversationId,
					BACKGROUND_CONTEXT,
				);
				if (!conversation) return;
				// A summarizer already in flight is summarizing the same context.
				if ((await this.liveCompactions(conversation)).length > 0) return;
				// No instructions on purpose: the ceiling path runs exactly the summarizer
				// the overflow path runs (same prompt, same head retention), so a worker's
				// assignment and a verifier's plan/finding references survive a proactive
				// compaction the way they survive a forced one.
				const pending = this.ceilingPending.get(record.conversationId) ?? 0;
				// The kind is claimed before the call: pi-durable publishes
				// `compaction_start` while `compact()` is still in flight.
				this.ceilingPending.set(record.conversationId, pending + 1);
				let taskId: Awaited<ReturnType<typeof conversation.compact>>;
				try {
					taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
				} finally {
					// A task that never started (nothing to compact) must not leave a claim
					// behind for a later manual compaction to inherit.
					this.ceilingPending.set(record.conversationId, pending);
				}
				this.ceilingCompactions.add(String(taskId));
				state.compactionTurns.push(state.turnIndex);
				state.lastCompactionTurn = state.turnIndex;
				state.lastCompactionTokens = contextTokens;
				// The reduced context is measured by the next turn's request, which is
				// where the token floor starts counting again.
				state.awaitingBaseline = true;
				const identity = this.telemetryIdentities.get(record.conversationId);
				if (identity)
					emitRuntimeEnvelope(identity, "runtime.compaction_ceiling", {
						status: "compact",
						ceilingTokens: ceiling.ceilingTokens,
						contextTokens,
						turnIndex: state.turnIndex,
						floorTurns: ceiling.floorTurns,
						floorTokens: ceiling.floorTokens,
						taskId: String(taskId),
					});
			});
		} catch (error) {
			this.log(
				`run ${runId}: cost-ceiling compaction not admitted: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	/** Test-only: the cost ceiling resolved for one run, and what the host has
	 * decided about it so far. Not part of the control protocol. */
	ceilingForTest(runId: string): CompactionCeiling | undefined {
		const record = this.runs.get(runId);
		return record ? this.resolveRunCeiling(record) : undefined;
	}

	ceilingStateForTest(runId: string): CeilingRecord | undefined {
		const record = this.runs.get(runId);
		return record ? this.ceilings.get(record.conversationId) : undefined;
	}

	/**
	 * Admit one manual compaction for a run (durable-agent-compaction: "Manual
	 * compaction outcomes"). At most one compaction is admitted per conversation:
	 * a compaction already listed in `pi.live.compactions` is reported instead of
	 * starting a second summarizer. `pi-durable` completes a compaction that can
	 * select no range immediately and never lists it, so "nothing to compact" is
	 * the absence of the task after admission — best-effort by construction, and
	 * worded that way on every surface.
	 *
	 * A read-only run is served like any other: compaction rewrites conversation
	 * context, never the repository. A run this host does not track (a finished
	 * run, or one only a recovered watch still knows) is refused with the
	 * `unknown run` error the protocol maps to `unknown-run`.
	 */
	async compactRun(
		runId: string,
		instructions?: string,
	): Promise<CompactRunResult> {
		this.assertOpen();
		const record = this.requireConversation(runId);
		const text = instructions?.trim();
		if (text && text.length > COMPACTION_MAX_INSTRUCTIONS)
			throw new Error(
				`invalid request: compaction instructions exceed ${COMPACTION_MAX_INSTRUCTIONS} characters`,
			);
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		const before = await this.liveCompactions(conversation);
		if (before.length > 0) {
			const reason = before[0]?.reason;
			return {
				status: "already-compacting",
				...(reason ? { reason } : {}),
			};
		}
		const taskId = await conversation.compact(
			text || undefined,
			BACKGROUND_CONTEXT,
		);
		// Give a task with nothing to summarize the moment it needs to finish and
		// disappear: its absence plus a summary-less receipt is "nothing to
		// compact", and anything else was genuinely admitted.
		const deadline = Date.now() + COMPACTION_SETTLE_MS;
		let listed = true;
		while (Date.now() < deadline) {
			await sleep(COMPACTION_SETTLE_POLL_MS);
			listed = (await this.liveCompactions(conversation)).some(
				(entry) => entry.taskId === String(taskId),
			);
			if (!listed) break;
		}
		if (listed) return { status: "started", taskId: String(taskId) };
		return (await this.compactionPlacedSummary(taskId))
			? { status: "started", taskId: String(taskId) }
			: { status: "nothing-to-compact" };
	}

	/** Whether a finished compaction task actually placed a summary. pi-durable's
	 * receipt carries an `entryId` (a blocking compaction's summary) or a
	 * `submissionId` (a conversation-owned one); both absent means it selected no
	 * range at all. Anything that failed or was aborted still counts as admitted,
	 * because its outcome is reported by the transcript and the telemetry
	 * envelope, not by the admission answer. */
	private async compactionPlacedSummary(
		taskId: TaskId<CompactionResult>,
	): Promise<boolean> {
		try {
			const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);
			const state = task?.state;
			if (state?.status !== "terminal") return true;
			const outcome = state.outcome;
			if (outcome.status !== "completed") return true;
			const result = outcome.result as
				| { entryId?: unknown; submissionId?: unknown }
				| undefined;
			return (
				result?.entryId !== undefined || result?.submissionId !== undefined
			);
		} catch {
			// A task the harness cannot read was admitted; never claim nothing was.
			return true;
		}
	}

	/** The live compactions of one conversation, as `pi.live.compactions`
	 * publishes them. */
	async liveCompactionCountForTest(runId: string): Promise<number> {
		const record = this.requireConversation(runId);
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		return conversation ? (await this.liveCompactions(conversation)).length : 0;
	}

	private async liveCompactions(
		conversation: Conversation,
	): Promise<Array<{ taskId: string; reason: string }>> {
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		try {
			const live = state.value.docs["pi.live"] as
				| { compactions?: Array<{ taskId?: unknown; reason?: unknown }> }
				| undefined;
			const list = Array.isArray(live?.compactions) ? live.compactions : [];
			return list.map((entry) => ({
				taskId: String(entry?.taskId ?? ""),
				reason: typeof entry?.reason === "string" ? entry.reason : "",
			}));
		} finally {
			state.dispose();
		}
	}

	async scheduledIdentity(): Promise<string> {
		return this.harness.commit(async (tx) => {
			const identity = await tx.doc(
				defineDoc<{ id: string }>({
					kind: "agentic.scheduling-host-identity",
					version: 1,
					scope: "session",
					checkpointWhen: () => false,
					initial: () => ({ id: randomUUID() }),
				}),
			);
			return identity.id;
		}, BACKGROUND_CONTEXT);
	}

	async scheduledAdmission(
		operation: "reserve" | "activate" | "query",
		envelope: ScheduledEnvelope,
		fence: number,
	) {
		this.assertOpen();
		if (envelope.expectedHostId !== (await this.scheduledIdentity()))
			throw new Error("scheduled host identity mismatch");
		const conversationId = parseConversationId(envelope.expectedConversationId);
		if (conversationId === undefined)
			throw new Error("invalid scheduled conversation identity");
		const issued = await this.harness.snapshot(
			associationDoc("run", envelope.runId),
			BACKGROUND_CONTEXT,
		);
		if (
			issued?.identity !== envelope.runId ||
			issued.conversationId !== conversationId
		)
			throw new Error("scheduled destination is missing or rebound");
		const conversation = await this.harness.conversation(
			conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error("scheduled conversation is unavailable");
		if (operation === "reserve")
			return reserveScheduled(conversation, envelope);
		if (operation === "activate")
			return activateScheduled(conversation, envelope, fence);
		return queryScheduled(conversation, envelope.occurrenceId, envelope.digest);
	}

	async submit(
		runId: string,
		text: string,
		requestId: string,
		whenBusy = "followUp",
		managedAdmission = false,
	): Promise<{
		submissionId: string;
		workflowState?: SubmitWorkflowState;
		workflowNote?: string;
	}> {
		this.assertOpen();
		const record = this.requireConversation(runId);
		// The mode is normalized, never rejected: `steer`/`overwrite` interrupt
		// the running turn, everything else queues behind it, and an idle
		// conversation starts the next turn either way (normalizeSubmitMode).
		const mode = normalizeSubmitMode(whenBusy);
		return this.serialized(record, async () => {
			if (!this.ownsConversation(runId, record.conversationId))
				throw new Error("Run no longer owns this conversation");
			if (
				this.runContexts.get(runId)?.env.HERDR_WORKFLOW_ID &&
				!managedAdmission
			) {
				const fence = await this.harness.snapshot(
					launchFenceDoc("run", runId),
					BACKGROUND_CONTEXT,
				);
				if (fence?.state !== "admitted")
					throw new Error(
						"Managed launch has no durable admission; inspect workflow status",
					);
			}
			// The workflow follows the session: a run parked by a developer abort is
			// reopened before the message lands, and a run that already finished is
			// reported instead of being reopened.
			const reconciled = await this.reconcileRunState(runId);
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
			const submission = await conversation.submit(
				{ type: "input", content: text, requestId, whenBusy: mode },
				BACKGROUND_CONTEXT,
			);
			// The developer's own message is what a `taskRef.previousMessage` start
			// substitutes; a monitor note and an abort marker are not.
			this.recordDeveloperMessage(record.conversationId, text, mode);
			// A message admitted now may have released the one that was queued
			// ahead of it; a turn already running keeps its own.
			await this.promoteDequeuedMessages(record.conversationId);
			return {
				submissionId: String(submission.id),
				...(reconciled
					? {
							workflowState: reconciled.state,
							...(reconciled.reason ? { workflowNote: reconciled.reason } : {}),
						}
					: {}),
			};
		});
	}

	/** The developer message the conversation's running turn is answering.
	 *
	 * A message admitted while a run was already live waits in the queue, and
	 * becomes the answered message once the turn ahead of it has taken it out of
	 * the inbox. Promotion is therefore lazy — at the next admission and at the
	 * next read — because the only turn boundary the host sees is a model call,
	 * which happens several times inside one developer turn. */
	private async answeredDeveloperMessage(
		conversationId: ConversationId,
	): Promise<string | undefined> {
		await this.promoteDequeuedMessages(conversationId);
		return this.turnDeveloperMessages.get(conversationId);
	}

	/** Promote every queued message the inbox no longer holds: a message that
	 * left the inbox is the one the running turn is answering. The count is what
	 * makes this safe — a message still waiting behind the running turn stays
	 * queued, so the turn in flight keeps the message it started with. A
	 * conversation the host cannot read promotes nothing. */
	private async promoteDequeuedMessages(
		conversationId: ConversationId,
	): Promise<void> {
		const queued = this.queuedDeveloperMessages.get(conversationId);
		if (!queued || queued.length === 0) return;
		const conversation = await this.harness.conversation(
			conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return;
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		let waiting: number;
		try {
			const inbox = state.value.docs["pi.inbox"] as
				| { items?: unknown[] }
				| undefined;
			waiting = inbox?.items?.length ?? 0;
		} finally {
			state.dispose();
		}
		while (queued.length > waiting) {
			const next = queued.shift();
			if (next !== undefined)
				this.turnDeveloperMessages.set(conversationId, next);
		}
		if (queued.length === 0)
			this.queuedDeveloperMessages.delete(conversationId);
	}

	/** Bind an admitted message to the turn that will answer it. The first
	 * message of a conversation is answered immediately; a message that
	 * interrupts the running turn (`steer`) replaces the answered one; a
	 * `followUp` behind a running turn waits in the queue, so the turn in flight
	 * keeps the message it started with. */
	private recordDeveloperMessage(
		conversationId: ConversationId,
		text: string,
		mode: "steer" | "followUp",
	): void {
		if (!developerMessage(text)) return;
		if (mode === "steer" || !this.turnDeveloperMessages.has(conversationId)) {
			this.turnDeveloperMessages.set(conversationId, text);
			return;
		}
		const queued = this.queuedDeveloperMessages.get(conversationId) ?? [];
		queued.push(text);
		this.queuedDeveloperMessages.set(conversationId, queued);
	}

	/** Serialize one conversation's mutating operations. A prompt that arrives
	 * while the developer's abort is still tearing its turn down used to race
	 * pi-durable's `abort`, which withdraws a queued input: the prompt vanished
	 * with no visible error. Chaining makes it land after the abort settled,
	 * where it is queued (or starts the next turn) exactly like any other
	 * prompt. */
	private serialized<T>(
		record: RunRecord,
		operation: () => Promise<T>,
	): Promise<T> {
		const key = String(record.conversationId);
		const previous = this.operations.get(key) ?? Promise.resolve();
		const next = previous.then(operation, operation);
		const settled = next.then(
			() => undefined,
			() => undefined,
		);
		this.operations.set(key, settled);
		void settled.then(() => {
			if (this.operations.get(key) === settled) this.operations.delete(key);
		});
		return next;
	}

	/** Reconcile one run's workflow state before a prompt is delivered. A fresh
	 * run is never parked, so the engine is asked once per run per host
	 * generation and again after this host aborts that run; a reconcile that
	 * cannot reach the engine never blocks the prompt - the developer's message
	 * is the developer's, and the recorded state stays for a later attempt. */
	private async reconcileRunState(
		runId: string,
	): Promise<ResumedRunState | undefined> {
		if (!this.abortedRuns.has(runId) && this.reconciledRuns.has(runId))
			return undefined;
		// The run's own environment, not the conversation's: a rebinding must not make
		// this run reconcile its workflow state under another run's token.
		const context = this.runContexts.get(runId);
		if (!context) return undefined;
		let state: ResumedRunState;
		try {
			state = await recordResumedRunHandoff(context);
		} catch (error) {
			this.log(
				`run ${runId} workflow state not reconciled: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return undefined;
		}
		this.abortedRuns.delete(runId);
		this.reconciledRuns.add(runId);
		if (state.state !== "active")
			this.log(
				`run ${runId} workflow state ${state.state}${
					state.reason ? `: ${state.reason}` : ""
				}`,
			);
		return state;
	}

	async status(runId: string): Promise<{
		status: RunStatus;
		lastError?: string;
		runtimeFailure?: RuntimeFailure;
	}> {
		const record = this.runs.get(runId);
		if (!record) return { status: "unknown" };
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return { status: "unknown" };
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		let status: RunStatus;
		try {
			const live = state.value.docs["pi.live"] as
				| { run?: unknown; tools?: Array<{ name: string; status: string }> }
				| undefined;
			const inbox = state.value.docs["pi.inbox"] as
				| { items?: unknown[] }
				| undefined;
			if (!live?.run) status = inbox?.items?.length ? "working" : "idle";
			else {
				const blockedOnQuestion = (live.tools ?? []).some(
					(slot) =>
						slot.status === "running" &&
						(slot.name === "developer_question" || slot.name === "agent_ask"),
				);
				status = blockedOnQuestion ? "blocked" : "working";
			}
		} finally {
			state.dispose();
		}
		const runtimeFailure = await this.runtimeFailureFor(runId, record);
		return { status, ...(runtimeFailure ? { runtimeFailure } : {}) };
	}

	/** Explicit recovery for one native task parked at pi-durable's restart
	 * limit. This validates the host's persisted run/conversation association,
	 * current task state and workflow gate before asking the native harness to
	 * retry. It does not promise exactly-once external effects. */
	async retryParkedTask(
		runId: string,
		conversationIdValue: string,
		taskIdValue: string,
		generationValue: number,
	): Promise<{ status: RetryTaskStatus; reason?: string }> {
		if (
			typeof runId !== "string" ||
			typeof conversationIdValue !== "string" ||
			typeof taskIdValue !== "string" ||
			!Number.isSafeInteger(generationValue) ||
			generationValue < 1
		)
			return { status: "refused", reason: "invalid task identity" };
		const conversationId = parseConversationId(conversationIdValue);
		const taskId = safeFailureMessage(taskIdValue, 128);
		const nativeTaskId = parseTaskId(taskIdValue);
		if (
			!conversationId ||
			!Number.isSafeInteger(conversationId) ||
			!taskId ||
			nativeTaskId === undefined ||
			taskId !== taskIdValue.trim()
		)
			return { status: "refused", reason: "invalid task identity" };
		const initial = this.runs.get(runId);
		if (!initial || initial.conversationId !== conversationId)
			return {
				status: "refused",
				reason: "run/conversation ownership mismatch",
			};
		const lockKey = `${runId}:${conversationId}:${taskId}`;
		if (this.retryingTasks.has(lockKey))
			return { status: "already-in-progress" };
		this.retryingTasks.add(lockKey);
		try {
			return await this.serialized(initial, async () => {
				const current = this.runs.get(runId);
				if (
					!current ||
					current.conversationId !== conversationId ||
					this.boundRunId(conversationId) !== runId
				)
					return { status: "refused", reason: "run is no longer active" };
				const stored = await this.harness.snapshot(
					runtimeFailureDoc(conversationId),
					BACKGROUND_CONTEXT,
				);
				if (
					!stored?.active ||
					stored.runId !== runId ||
					stored.conversationId !== conversationId ||
					stored.kind !== "task_parked" ||
					stored.taskId !== taskId ||
					stored.reason !== "restart_limit" ||
					stored.generation !== generationValue
				)
					return {
						status: "stale",
						reason: "task is not the reported parked task",
					};

				let task: unknown;
				try {
					task = await this.harness.getTask(nativeTaskId, BACKGROUND_CONTEXT);
				} catch {
					return { status: "stale", reason: "task is no longer available" };
				}
				if (!task)
					return { status: "stale", reason: "task is no longer available" };
				const state = taskState(task);
				if (state.status === "running" || state.status === "ready")
					return { status: "already-in-progress" };
				if (!isRestartLimitParked(task))
					return {
						status: "stale",
						reason: "task is no longer parked at restart_limit",
					};
				const ownerConversationId = taskConversationId(task);
				if (ownerConversationId !== conversationId)
					return {
						status: "refused",
						reason: "task belongs to another conversation",
					};
				const context = this.runContexts.get(runId);
				if (!context)
					return { status: "refused", reason: "run context is unavailable" };
				let workflowState: ResumedRunState;
				try {
					workflowState = await recordResumedRunHandoff(context);
				} catch {
					return {
						status: "refused",
						reason: "workflow state could not be verified",
					};
				}
				if (
					workflowState.state !== "active" &&
					workflowState.state !== "resumed"
				)
					return {
						status: "refused",
						reason: `workflow is ${workflowState.state}`,
					};
				if (
					this.runs.get(runId)?.conversationId !== conversationId ||
					this.boundRunId(conversationId) !== runId
				)
					return {
						status: "refused",
						reason: "run ownership changed during validation",
					};
				if (stored.retryAcceptedGeneration === (stored.generation ?? 0))
					return { status: "already-in-progress" };
				const accepted = await this.markRuntimeFailureRetryAccepted(
					runId,
					conversationId,
					taskId,
					generationValue,
					taskRestartCount(task),
				);
				if (!accepted)
					return {
						status: "stale",
						reason: "parked task episode changed during validation",
					};
				try {
					await this.harness.retryTask(nativeTaskId, BACKGROUND_CONTEXT);
					// Native retry resets restarts to zero. Retain the post-retry
					// baseline so another crash loop reaching the same limit is a new
					// episode even if no status reader saw the intervening progress.
					try {
						const resumed = await this.harness.getTask(
							nativeTaskId,
							BACKGROUND_CONTEXT,
						);
						const restarts = taskRestartCount(resumed);
						if (restarts !== undefined)
							await this.harness.commit(async (tx) => {
								const report = await tx.doc(runtimeFailureDoc(conversationId));
								if (
									report.generation === generationValue &&
									report.retryAcceptedGeneration === generationValue
								)
									report.retryAcceptedRestarts = restarts;
							}, BACKGROUND_CONTEXT);
					} catch {
						// Keep the durable uncertain acceptance, never admit a duplicate.
					}
					return { status: "retried" };
				} catch {
					// The durable acceptance precedes the native call so a host crash
					// cannot admit a duplicate. Its outcome is therefore uncertain.
					return {
						status: "already-in-progress",
						reason: "native retry outcome is uncertain; do not resubmit",
					};
				}
			});
		} finally {
			this.retryingTasks.delete(lockKey);
		}
	}

	/** Apply a live model / thinking override to one run's conversation
	 * (dashboard \`/model\` and \`/thinking\`). The change lands in \`pi.agent\`, so the
	 * next generation uses it and every watcher sees it. */
	async configureRun(
		runId: string,
		change: { model?: string; thinking?: string },
	): Promise<void> {
		this.assertOpen();
		const record = this.requireConversation(runId);
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		await conversation.configure(
			{
				...(change.model ? { model: parseModelRef(change.model) } : {}),
				...(change.thinking ? { thinkingLevel: change.thinking as never } : {}),
			},
			BACKGROUND_CONTEXT,
		);
		// Track this run's actual model for its independent cost-ceiling policy.
		const model =
			change.model ??
			(await this.conversationModelRef(conversation)) ??
			record.model;
		if (model && model !== record.model)
			this.runs.set(runId, { ...record, model });
	}

	/** Every chat model this host can run for the user's *configured*
	 * providers, as `provider/modelId`, plus each of those models' context
	 * windows so a client can show a context meter. Availability is resolved in
	 * process from the live global-pi credentials (`configured-models.ts`) — no
	 * `pi` executable is involved — so the dashboard `/model` picker offers the
	 * configured providers' models instead of pi-ai's full generated catalog.
	 *
	 * The walk is per provider: one availability check per provider, then only
	 * the configured providers' models are enumerated. Nothing here reads the
	 * whole catalog, and the response carries a context window only for a model
	 * it actually offers. Fails open: a collection whose auth cannot be resolved
	 * keeps the unfiltered catalog and records the reason, so a picker is never
	 * silently emptied. */
	async catalog(): Promise<{
		models: string[];
		thinkingLevels: string[];
		contextWindows: Record<string, number>;
	}> {
		// Availability first, so only the configured providers' models are ever
		// read: the generated catalog of an unconfigured provider costs nothing to
		// skip, and the response below carries exactly the offered models.
		const configured = await this.configuredProviderIds();
		const models = new Set<string>();
		const contextWindows: Record<string, number> = {};
		for (const provider of this.models?.getProviders() ?? []) {
			if (configured && !configured.has(provider.id)) continue;
			for (const model of this.models?.getModels(provider.id) ?? []) {
				const id = `${model.provider}/${model.id}`;
				models.add(id);
				if (typeof model.contextWindow === "number")
					contextWindows[id] = model.contextWindow;
			}
		}
		return {
			models: [...models].sort(),
			thinkingLevels: [...DurableHost.THINKING_LEVELS],
			contextWindows,
		};
	}

	/** The providers this host can authenticate with, or `undefined` when that
	 * cannot be resolved. */
	private async configuredProviderIds(): Promise<Set<string> | undefined> {
		if (!this.models) return undefined;
		try {
			return await configuredProviderIds(this.models);
		} catch (error) {
			this.log(
				`catalog: configured-provider models unavailable (${
					error instanceof Error ? error.message : String(error)
				})`,
			);
			return undefined;
		}
	}

	async abort(runId: string): Promise<void> {
		this.assertOpen();
		const record = this.requireConversation(runId);
		// The next message to this run reconciles its workflow state, so the run
		// the developer aborted is the run that can be reopened.
		this.abortedRuns.add(runId);
		await this.serialized(record, () => this.stopConversation(runId, true));
	}

	/** One finished tool call of a run, fed to that run's dead-surface monitor.
	 * The monitor's decision is the only thing that acts, and it acts outside
	 * the event stream it was derived from: this method never blocks the
	 * telemetry handler. */
	private onToolOutcome(
		runId: string,
		conversationId: ConversationId,
		observation: ToolOutcomeObservation,
	): void {
		// Only a live run may act on its own tool outcomes: a call of a run the
		// engine retired can finish after the conversation was rebound, and its
		// failure must be recorded against that run — never charged to the run now
		// bound, which would stop an unrelated run (or block the workflow for it).
		if (!this.runs.has(runId)) return;
		const monitor = this.toolSurfaces.get(conversationId);
		if (!monitor) return;
		const decision = monitor.observe(observation);
		if (!decision) return;
		void this.handleFailFast(runId, conversationId, decision).catch((error) => {
			this.log(
				`fail-fast for ${runId} did not complete: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		});
	}

	/** Act on one dead-surface decision (efficiency backlog item 3): first the
	 * one cheap re-probe of the run's tool host, which grants the run one more
	 * turn, and then — when a call fails again — the run's own `blocked`
	 * handoff naming the tool, the failure kinds, the count and one short error
	 * line. Every decision is emitted as the `run.fail-fast` envelope, and the
	 * handoff message is what the engine turns into the developer-visible
	 * attention line. */
	private async handleFailFast(
		runId: string,
		conversationId: ConversationId,
		decision: FailFastDecision,
	): Promise<void> {
		const context = this.runContexts.get(runId);
		if (!context) return;
		const env = context.env;
		const facts = decision.facts;
		const fields = {
			"herdr.fail_fast.decision": decision.action,
			"pi.tool.name": facts.tool,
			"pi.tool.failure_kinds": facts.failureKinds.join(",") || "(unrecorded)",
			"pi.tool.consecutive_failures": facts.consecutiveFailures,
			"pi.tool.successes": facts.successes,
			"pi.turn.count": facts.turns,
		};
		// The decision belongs to this run only while it still holds the conversation:
		// aborting the shared conversation would kill the successor's turn, and the
		// handoff would run under the successor's run token and park a workflow for a
		// tool surface it never touched. A decision of a superseded run is recorded
		// against that run (its own environment) and acted on by nobody.
		if (this.boundRunId(conversationId) !== runId) {
			emitToolTelemetry(env, "run.fail-fast", {
				...fields,
				probed: false,
				"herdr.fail_fast.scope": "owner-rebound",
			});
			this.log(
				`run ${runId} tool surface looks dead, but the conversation is bound to another run now: recorded and not acted on`,
			);
			return;
		}
		if (decision.action === "probe") {
			const probe = this.options.probeToolHost ?? reprobeToolHost;
			const probed = await probe(env).catch(() => false);
			this.toolProbes.set(conversationId, probed);
			emitToolTelemetry(env, "run.fail-fast", { ...fields, probed });
			this.log(
				`run ${runId} tool surface looks dead (${facts.consecutiveFailures} consecutive failed ${facts.tool} calls, no success); re-probed the tool host: ${probed ? "reachable" : "no mechanism"}`,
			);
			return;
		}
		const probed = this.toolProbes.get(conversationId) ?? false;
		this.toolProbes.delete(conversationId);
		emitToolTelemetry(env, "run.fail-fast", { ...fields, probed });
		this.log(`run ${runId} stopped: ${decision.message}`);
		await this.stopRunForDeadToolSurface(
			runId,
			conversationId,
			decision.message,
		);
	}

	/** Stop a run whose tool surface never worked: abort the conversation so no
	 * further turn is taken, then record the run's own `blocked` handoff.
	 * Deliberately *not* the developer abort's path: the run is not parked for a
	 * reopen, its block is its outcome, so a later message reports the run
	 * finished instead of resuming it. Best-effort like every host-side state
	 * change — the conversation is aborted whatever the handoff does. */
	private async stopRunForDeadToolSurface(
		runId: string,
		conversationId: ConversationId,
		message: string,
	): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		const context = this.runContexts.get(runId);
		if (!context) return;
		// Only while this run still holds the conversation, tested again inside the
		// serialized section below: a rebinding that lands during the abort must not
		// leave a `blocked` handoff under the successor's token.
		if (this.boundRunId(conversationId) !== runId) return;
		this.toolSurfaces.delete(conversationId);
		this.toolProbes.delete(conversationId);
		await this.serialized(record, async () => {
			if (this.boundRunId(record.conversationId) !== runId) return;
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			await conversation?.abort(BACKGROUND_CONTEXT);
			try {
				await recordFailFastRunHandoff(context, message);
			} catch (error) {
				this.log(
					`fail-fast handoff not recorded for ${runId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		});
	}

	/** Abort a run's conversation. A developer-initiated abort (`recordBlocked`)
	 * also records the run's `blocked` handoff, because the aborted turn can no
	 * longer hand off itself and the engine would otherwise keep the run
	 * `working` forever; a teardown (`shutdown`) records nothing. */
	private async stopConversation(
		runId: string,
		recordBlocked: boolean,
	): Promise<void> {
		const tracked = this.runs.get(runId);
		if (!tracked) return;
		const conversation = await this.harness.conversation(
			tracked.conversationId,
			BACKGROUND_CONTEXT,
		);
		const context = this.runContexts.get(runId);
		if (
			conversation &&
			!recordBlocked &&
			(await hasQueuedScheduled(this.harness, conversation))
		)
			return;
		await conversation?.abort(BACKGROUND_CONTEXT);
		if (!recordBlocked || !context) return;
		try {
			await recordAbortedRunHandoff(context);
		} catch (error) {
			// Best-effort: a run that already handed off, or an engine that
			// rejects the handoff, must not fail the abort the developer asked for.
			this.log(
				`abort handoff not recorded for ${runId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	async inspectLaunch(
		runId: string,
	): Promise<import("../contracts/launch.ts").LaunchObservation> {
		this.assertOpen();
		return this.managedOperation(runId, async () => {
			const fence = await this.harness.snapshot(
				launchFenceDoc("run", runId),
				BACKGROUND_CONTEXT,
			);
			if (!fence?.runId) {
				const legacy = await this.harness.snapshot(
					associationDoc("run", runId),
					BACKGROUND_CONTEXT,
				);
				return {
					runId,
					state: "absent",
					activity: legacy?.conversationId ? "unknown" : "absent",
				};
			}
			if (fence.state === "stopped")
				return {
					runId,
					state: "stopped",
					activity: "absent",
					...(fence.requestId ? { requestId: fence.requestId } : {}),
				};
			// Role rebind/stop and this observation must see one ownership epoch.
			// Historical run associations alone cannot describe a successor's work.
			return this.managedOperation(`role:${fence.name}`, async () => {
				const role = await this.harness.snapshot(
					launchFenceDoc("role", fence.name),
					BACKGROUND_CONTEXT,
				);
				const unknown = {
					runId,
					state: fence.state,
					activity: "unknown" as const,
					...(fence.requestId ? { requestId: fence.requestId } : {}),
				};
				if (role?.runId !== runId) return unknown;
				const issued = await this.harness.snapshot(
					associationDoc("run", runId),
					BACKGROUND_CONTEXT,
				);
				if (
					issued?.conversationId &&
					!this.ownsConversation(runId, issued.conversationId as ConversationId)
				)
					return unknown;
				const conversation = issued?.conversationId
					? await this.harness.conversation(
							issued.conversationId as ConversationId,
							BACKGROUND_CONTEXT,
						)
					: undefined;
				let activity: import("../contracts/launch.ts").LaunchObservation["activity"] =
					"absent";
				if (conversation) {
					const state = await conversation.viewState(BACKGROUND_CONTEXT);
					try {
						const live = state.value.docs["pi.live"] as
							| {
									run?: unknown;
									tools?: Array<{ name: string; status: string }>;
							  }
							| undefined;
						const inbox = state.value.docs["pi.inbox"] as
							| { items?: unknown[] }
							| undefined;
						activity = live?.run
							? (live.tools ?? []).some(
									(tool) =>
										tool.status === "running" &&
										["developer_question", "agent_ask"].includes(tool.name),
								)
								? "blocked"
								: "working"
							: inbox?.items?.length
								? "working"
								: "idle";
					} finally {
						state.dispose();
					}
				}
				if (fence.state === "stopping") activity = "unknown";
				return {
					runId,
					state: fence.state,
					activity,
					...(fence.requestId ? { requestId: fence.requestId } : {}),
				};
			});
		});
	}

	async fenceStoppedRun(
		claim: import("../contracts/launch.ts").LaunchClaim,
	): Promise<void> {
		this.assertOpen();
		return this.managedOperation(claim.runId, async () => {
			const { verifyWorkflowLaunch } = await import("./launch-verifier.ts");
			const permit = await verifyWorkflowLaunch({ ...claim, intent: "stop" });
			if (
				path.resolve(permit.hostRoot) !== path.resolve(this.options.layout.root)
			)
				throw new Error("Cancellation belongs to another host");
			return this.managedOperation(`role:${permit.name}`, async () => {
				const role = await this.harness.snapshot(
					launchFenceDoc("role", permit.name),
					BACKGROUND_CONTEXT,
				);
				if (!role?.runId && !this.runs.has(claim.runId)) {
					const legacy = await this.harness.snapshot(
						associationDoc("run", claim.runId),
						BACKGROUND_CONTEXT,
					);
					if (legacy?.conversationId)
						throw new Error(
							"Legacy admission ownership is unknown; inspect the native session before reconciliation",
						);
				}
				await this.harness.commit(async (tx) => {
					const fence = await tx.doc(launchFenceDoc("run", claim.runId));
					fence.runId = claim.runId;
					fence.name = permit.name;
					fence.state = "stopping";
					fence.revision = permit.revision;
					fence.claimAttempt = permit.claimAttempt;
					const roleFence = await tx.doc(launchFenceDoc("role", permit.name));
					if (!roleFence.runId || roleFence.runId === claim.runId)
						Object.assign(roleFence, fence);
					const barriers = await tx.doc(StopBarriersDoc);
					const record = this.runs.get(claim.runId);
					const issued = await tx.doc(associationDoc("run", claim.runId));
					barriers.runs[claim.runId] = {
						name: permit.name,
						conversationId:
							role?.runId === claim.runId
								? issued.conversationId
								: record &&
										this.ownsConversation(claim.runId, record.conversationId)
									? record.conversationId
									: 0,
					};
				}, BACKGROUND_CONTEXT);
				await this.finishStopBarrier(claim.runId);
			});
		});
	}
	private async finishStopBarrier(runId: string): Promise<void> {
		const barriers = await this.harness.snapshot(
			StopBarriersDoc,
			BACKGROUND_CONTEXT,
		);
		const barrier = barriers?.runs[runId];
		if (!barrier) return;
		const role = await this.harness.snapshot(
			launchFenceDoc("role", barrier.name),
			BACKGROUND_CONTEXT,
		);
		if (
			!this.runs.has(runId) &&
			role?.runId === runId &&
			barrier.conversationId
		) {
			const conversation = await this.harness.conversation(
				barrier.conversationId as ConversationId,
				BACKGROUND_CONTEXT,
			);
			await conversation?.abort(BACKGROUND_CONTEXT);
		}
		await this.stopRunOnce(runId);
		await this.harness.commit(async (tx) => {
			const fence = await tx.doc(launchFenceDoc("run", runId));
			fence.state = "stopped";
			const roleFence = await tx.doc(launchFenceDoc("role", barrier.name));
			if (roleFence.runId === runId) roleFence.state = "stopped";
			const pending = await tx.doc(StopBarriersDoc);
			delete pending.runs[runId];
		}, BACKGROUND_CONTEXT);
	}
	async stopRun(runId: string): Promise<void> {
		this.assertOpen();
		// Legacy control can stop only a tracked conversation. It cannot advance
		// a durable fence for an arbitrary/unseen workflow run.
		return this.managedOperation(runId, () => this.stopRunOnce(runId));
	}
	private async stopRunOnce(runId: string): Promise<void> {
		this.assertOpen();
		const record = this.runs.get(runId);
		if (!record) return;
		this.abortedRuns.delete(runId);
		this.reconciledRuns.delete(runId);
		// The dead-surface monitor and probe belong to the run serving the
		// conversation, not to the conversation itself: a successor ensured while this
		// teardown is in flight installed its own, and dropping them here would turn
		// the rule off for every later run silently.
		if (this.ownsConversation(runId, record.conversationId)) {
			this.toolSurfaces.delete(record.conversationId);
			this.toolProbes.delete(record.conversationId);
		}
		await this.serialized(record, async () => {
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			if (this.ownsConversation(runId, record.conversationId))
				await conversation?.abort(BACKGROUND_CONTEXT);
			this.runs.delete(runId);
			this.runContexts.delete(runId);
			// The conversation-keyed state belongs to whatever is bound to it *now*: a
			// successor run of the same step and role can be ensured while this abort
			// is in flight, and the context, timing, ceiling state and telemetry
			// identity it just wrote are not this run's to drop (the binding is what
			// says whose they are).
			if (this.ownsConversation(runId, record.conversationId)) {
				// The developer's messages are keyed by conversation, and the
				// conversation outlives the run: the next `ensureRun` re-opens the one
				// `RunMapDoc` recorded, and a `previousMessage` start still answers with
				// the message that session last sent.
				this.contexts.delete(record.conversationId);
				this.timings.delete(record.conversationId);
				// The ceiling's bookkeeping is per conversation and dies with it.
				this.ceilings.delete(record.conversationId);
				this.telemetryIdentities.delete(record.conversationId);
				this.ceilingPending.delete(record.conversationId);
			}
			// The session binding is *not* deleted: the conversation outlives the run,
			// and a later run of the same step and role recording a rebinding has to
			// name the run it left (efficiency backlog item 20). The telemetry stream
			// stays attached for the same reason, so it can attribute the new run's
			// turns to that run.
		});
	}

	async watchRun(
		runId: string,
		onValue: (value: unknown) => void,
		recoveredConversationId?: string,
		view: "docs" | undefined = undefined,
		options: {
			readonly patches?: boolean;
			readonly onPatch?: (patch: WatchPatch) => void;
		} = {},
	): Promise<() => void> {
		// A recovery hint is not ownership evidence. Both full and docs/patch
		// watches verify the pair before acquiring or publishing any view. Recovery
		// stays observational: it never registers a run for submit/abort/control.
		const record = this.runs.get(runId);
		const requestedId = parseConversationId(recoveredConversationId);
		let conversationId = record?.conversationId;
		if (record) {
			if (
				recoveredConversationId !== undefined &&
				requestedId !== record.conversationId
			)
				throw new Error(`unverified conversation for run: ${runId}`);
		} else {
			if (requestedId === undefined) throw new Error(`unknown run: ${runId}`);
			const issued = await this.harness.snapshot(
				associationDoc("run", runId),
				BACKGROUND_CONTEXT,
			);
			if (issued?.identity !== runId || issued.conversationId !== requestedId)
				throw new Error(`unverified conversation for run: ${runId}`);
			conversationId = requestedId;
		}
		if (conversationId === undefined) throw new Error(`unknown run: ${runId}`);
		const conversation = await this.harness.conversation(
			conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		// `watch` gives the acquisition snapshot and every later revision's
		// operations. The dashboard's session page applies those operations to the
		// snapshot it already holds, so only the changed paths cross the socket
		// instead of a fresh conversation view per token-rate frame.
		const watch = await conversation.watch(BACKGROUND_CONTEXT);
		const measuredTimings = () =>
			this.timings.get(conversationId) ?? NO_TIMINGS;
		let latestValue: unknown = watch.value;
		let currentFailure = await this.runtimeFailureFor(runId, {
			conversationId,
			readOnly: false,
		});
		let watchClosed = false;
		// The measured timings and synthetic Harness report travel with the
		// conversation view. Docs-only watchers still receive no transcript.
		const augment = (
			value: unknown,
			timings: Record<string, EntryTiming> = measuredTimings(),
		) => {
			const record = sanitizeWatchValue(value);
			const base =
				view === "docs"
					? { docs: record?.docs ?? {} }
					: { ...(record ?? {}), timings };
			return {
				...base,
				...(currentFailure ? { runtimeFailure: currentFailure } : {}),
			};
		};
		const refreshFailure = () => {
			void this.runtimeFailureFor(runId, { conversationId, readOnly: false })
				.then((failure) => {
					if (watchClosed) return;
					currentFailure = failure;
					onValue(augment(latestValue));
				})
				.catch(() => {
					/* runtime diagnostics never interrupt the conversation watch */
				});
		};
		const failureListeners =
			this.runtimeFailureListeners.get(conversationId) ?? new Set<() => void>();
		failureListeners.add(refreshFailure);
		this.runtimeFailureListeners.set(conversationId, failureListeners);
		// Capture the initial timings and publish them together, so the patch
		// baseline is exactly what the watcher received (a timing committed
		// between the two reads must not be mistaken for "already delivered").
		const initialTimings = measuredTimings();
		onValue(augment(watch.value, initialTimings));
		if (options.patches !== true || options.onPatch === undefined) {
			// Coalesce what follows: a generating model changes this state at token
			// rate, and every frame crosses the socket and rebuilds the watcher's
			// whole transcript. The initial frame above is delivered directly,
			// because a watcher's handshake resolves on it.
			const frames = createFrameThrottle<unknown>({
				windowMs: STATE_FRAME_COALESCE_MS,
				deliver: (value) => onValue(value),
			});
			watch.start(async (value) => {
				latestValue = value;
				frames.push(augment(value));
			});
			return () => {
				watchClosed = true;
				frames.dispose();
				failureListeners.delete(refreshFailure);
				if (failureListeners.size === 0)
					this.runtimeFailureListeners.delete(conversationId);
				void watch.stop();
			};
		}

		const onPatch = options.onPatch;
		let lastTimings = initialTimings;
		// A docs-only watcher sees only paths under `docs`; an overflow root
		// replacement is narrowed to the docs it carries. Ops for the committed
		// transcript are dropped before they are queued, so they never take up a
		// patch slot.
		const projectOps = (ops: readonly Op[]): Op[] => {
			const projected: Op[] = [];
			let liveChanged = false;
			for (const op of ops) {
				if (op[0] === "r") {
					const record = sanitizeWatchValue(op[1]);
					projected.push(
						view === "docs"
							? ["r", { docs: (record?.docs ?? {}) as JsonValue } as JsonValue]
							: ["r", (record ?? op[1]) as JsonValue],
					);
					continue;
				}
				const path = op[1];
				if (view === "docs" && path[0] !== "docs") continue;
				if (path.length === 1 && path[0] === "docs" && op[0] === "s") {
					const docs = asRecord(op[2]);
					projected.push([
						"s",
						["docs"],
						docs?.["pi.live"] === undefined
							? (op[2] as JsonValue)
							: ({
									...docs,
									"pi.live": sanitizePiLiveDiagnostics(docs["pi.live"]),
								} as JsonValue),
					]);
					continue;
				}
				if (path[0] === "docs" && path[1] === "pi.live") {
					liveChanged = true;
					continue;
				}
				projected.push(op);
			}
			if (liveChanged) {
				const docs = asRecord(asRecord(latestValue)?.docs);
				if (docs?.["pi.live"] !== undefined)
					projected.push([
						"s",
						["docs", "pi.live"],
						sanitizePiLiveDiagnostics(docs["pi.live"]) as JsonValue,
					]);
				else projected.push(["d", ["docs", "pi.live"]]);
			}
			return projected;
		};
		// Ordered batches: every operation builds on the previous one, so unlike a
		// full-snapshot frame none can be dropped. A burst is concatenated and
		// delivered once at the window boundary.
		const frames = createBatchThrottle<Op>({
			windowMs: PATCH_FRAME_COALESCE_MS,
			deliver: (ops) => {
				const timings = measuredTimings();
				const timingsChanged = timings !== lastTimings;
				if (ops.length === 0 && !timingsChanged) return;
				lastTimings = timings;
				onPatch({
					ops,
					...(timingsChanged ? { timings } : {}),
				});
			},
		});
		// Timing arrives after the conversation operation that produced it, and
		// it is not part of the view's delta. Wake the patch queue so a duration
		// can advance without waiting for the next token.
		const wake = () => frames.wake();
		const listeners =
			this.timingListeners.get(conversationId) ?? new Set<() => void>();
		listeners.add(wake);
		this.timingListeners.set(conversationId, listeners);
		watch.start(async (value, ops) => {
			latestValue = value;
			const projected = projectOps(ops);
			if (projected.length > 0) frames.push(projected);
		});
		return () => {
			watchClosed = true;
			frames.dispose();
			listeners.delete(wake);
			if (listeners.size === 0) this.timingListeners.delete(conversationId);
			failureListeners.delete(refreshFailure);
			if (failureListeners.size === 0)
				this.runtimeFailureListeners.delete(conversationId);
			void watch.stop();
		};
	}

	prepareRestartForReattachment(): "ready" | "busy" {
		if (
			this.closing ||
			this.operations.size > 0 ||
			this.retryingTasks.size > 0 ||
			this.ensuringRuns.size > 0 ||
			this.activeRequests.size > 0
		)
			return "busy";
		try {
			// Scheduler memory includes unbound conversations and background work;
			// a parked task is inactive, but running/ready/sleeping work is not.
			const wake = this.harness.wake();
			return wake.active || wake.at !== undefined ? "busy" : "ready";
		} catch {
			return "busy";
		}
	}

	shutdown(): Promise<void> {
		if (this.shutdownPromise) return this.shutdownPromise;
		this.closing = true;
		this.shutdownPromise = this.shutdownOnce();
		return this.shutdownPromise;
	}

	private async shutdownOnce(): Promise<void> {
		this.server?.close();
		this.authenticatedServer?.close();
		for (const stop of this.telemetry.values()) {
			try {
				stop();
			} catch {
				/* best-effort teardown */
			}
		}
		this.toolSurfaces.clear();
		this.toolProbes.clear();
		// The closing fence prevents new request dispatch and ensureRun admission.
		// Drain work accepted before it before stopping conversations or closing the
		// harness, so a late ensure cannot publish a run after the stop pass.
		await Promise.allSettled([
			...this.activeRequests,
			...this.ensuringRuns.values(),
			...this.ensuringRoles.values(),
		]);
		for (const [socket, cleanups] of this.watchers) {
			for (const cleanup of cleanups) {
				try {
					cleanup();
				} catch {
					/* best-effort watcher teardown */
				}
			}
			cleanups.clear();
			socket.destroy();
		}
		this.watchers.clear();
		this.authenticatedSockets.clear();
		for (const runId of [...this.runs.keys()]) {
			try {
				await this.stopConversation(runId, false);
			} catch {
				/* best-effort drain before close */
			}
		}

		await Promise.all(
			[...this.piCatalogWatches.keys()].map((id) =>
				this.closePiCatalogWatch(id),
			),
		);
		await Promise.allSettled([...this.piCatalogWork.values()]);
		let shutdownError: unknown;
		try {
			await this.localPiBridge?.closeAll();
			await this.harness.close(BACKGROUND_CONTEXT);
		} catch (error) {
			shutdownError = error;
		} finally {
			try {
				await this.closeCodemode?.();
			} catch {
				/* best-effort worker termination after the harness has drained */
			}
			try {
				fs.rmSync(this.options.layout.socketPath, { force: true });
				const identity = hostIdentityPaths(this.options.layout.socketPath);
				fs.rmSync(identity.socket, { force: true });
				fs.rmSync(identity.certificate, { force: true });
				fs.rmSync(this.options.layout.lockPath, { force: true });
			} catch {
				/* best-effort cleanup */
			}
		}
		if (shutdownError !== undefined) throw shutdownError;
	}

	/** Serve the control socket. Rejects with EADDRINUSE-shaped errors when
	 * another live host already owns the lock (duplicate-start exit path,
	 * durable-agent-host: "Concurrent host start"). */
	async listen(): Promise<void> {
		const { socketPath, lockPath } = this.options.layout;
		if (fs.existsSync(lockPath) && (await isLockLive(lockPath))) {
			throw new Error(
				`agent host already running for this workflow (lock: ${lockPath})`,
			);
		}
		try {
			fs.rmSync(socketPath, { force: true });
		} catch {
			/* stale socket from an unclean previous shutdown */
		}
		const paths = hostIdentityPaths(socketPath);
		fs.rmSync(paths.socket, { force: true });
		fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
		const identity = createHostIdentity();
		const authenticated = tls.createServer(
			{ key: identity.key, cert: identity.cert, minVersion: "TLSv1.3" },
			(socket) => this.handleConnection(socket),
		);
		this.authenticatedServer = authenticated;
		authenticated.on("connection", (socket) => {
			this.authenticatedSockets.add(socket);
			socket.once("close", () => this.authenticatedSockets.delete(socket));
		});
		const server = net.createServer((socket) => this.handleConnection(socket));
		this.server = server;
		try {
			for (const [listener, file] of [
				[server, socketPath],
				[authenticated, paths.socket],
			] as const) {
				await new Promise<void>((resolve, reject) => {
					listener.once("error", reject);
					listener.listen(file, () => {
						try {
							fs.chmodSync(file, 0o600);
							resolve();
						} catch (error) {
							reject(error);
						}
					});
				});
			}
			// Publish only the public certificate, atomically, after both listeners
			// are ready. The private key exists only in this host instance's memory.
			const temporary = `${paths.certificate}.${randomUUID()}`;
			try {
				fs.writeFileSync(temporary, identity.cert, { flag: "wx", mode: 0o600 });
				fs.renameSync(temporary, paths.certificate);
			} finally {
				fs.rmSync(temporary, { force: true });
			}
		} catch (error) {
			server.close();
			authenticated.close();
			for (const file of [
				socketPath,
				paths.socket,
				paths.certificate,
				lockPath,
			])
				fs.rmSync(file, { force: true });
			throw error;
		}
	}

	private handleConnection(socket: net.Socket): void {
		const reader = new FrameReader();
		const cleanups = new Set<() => void>();
		this.watchers.set(socket, cleanups);
		socket.setEncoding("utf8");
		const send = (response: HostResponse) => {
			try {
				socket.write(encodeFrame(response));
			} catch {
				/* the peer is gone; nothing to deliver to */
			}
		};
		socket.on("data", (chunk: string) => {
			for (const line of reader.push(chunk)) {
				const decoded = decodeFrame(line);
				if (!decoded.ok) {
					send(decoded.error);
					continue;
				}
				const request = this.handleRequest(
					decoded.value as HostRequest,
					send,
					socket,
					cleanups,
				);
				this.activeRequests.add(request);
				void request.then(
					() => this.activeRequests.delete(request),
					() => this.activeRequests.delete(request),
				);
			}
		});
		const closed = () => {
			this.watchers.delete(socket);
			for (const cleanup of cleanups) cleanup();
			cleanups.clear();
		};
		socket.on("close", closed);
		socket.on("error", closed);
	}

	private retryCapabilityMatches(supplied: unknown): boolean {
		const expected = this.options.retryCapability;
		if (
			!expected ||
			typeof supplied !== "string" ||
			!/^[a-f0-9]{64}$/.test(supplied) ||
			expected.length !== supplied.length
		)
			return false;
		return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
	}

	private async handleRequest(
		request: HostRequest,
		send: (response: HostResponse) => void,
		socket: net.Socket,
		cleanups: Set<() => void>,
	): Promise<void> {
		if (this.closing && request.type !== "shutdown") {
			send({
				type: "error",
				code: "invalid-request",
				message: "agent host is shutting down",
			});
			return;
		}
		try {
			switch (request.type) {
				case "scheduledIdentity":
					send({
						type: "scheduledIdentity",
						hostId: await this.scheduledIdentity(),
					});
					return;
				case "scheduledAdmission":
					send({
						type: "scheduledAdmission",
						receipt: await this.scheduledAdmission(
							request.operation,
							request.envelope,
							request.fence,
						),
					});
					return;
				case "hello":
					if (request.protocolVersion !== PROTOCOL_VERSION) {
						send({
							type: "error",
							code: "version-mismatch",
							message: `host speaks protocol ${PROTOCOL_VERSION}`,
						});
						return;
					}
					send({
						type: "hello",
						protocolVersion: PROTOCOL_VERSION,
						hostId: this.options.layout.root,
					});
					return;
				case "inspectLaunch": {
					const observation = await this.inspectLaunch(request.runId);
					send({ type: "launchObservation", ...observation });
					return;
				}
				case "fenceStoppedRun": {
					await this.fenceStoppedRun(request.claim);
					send({ type: "ok" });
					return;
				}
				case "admitWorkflowRun": {
					const result = await this.admitWorkflowRun(request);
					send({
						type: "ensureRun",
						runId: request.runId,
						conversationId: result.conversationId,
					});
					return;
				}
				case "recoverRun":
				case "ensureRun": {
					if (
						request.type === "recoverRun" &&
						(typeof request.expectedConversationId !== "string" ||
							!request.expectedConversationId)
					)
						throw new Error("run recovery requires a conversation identity");
					const result = await this.ensureRun({
						runId: request.runId,
						name: request.name,
						expectedConversationId: request.expectedConversationId,
						cwd: request.cwd,
						runEnvPath: request.runEnvPath,
						toolPolicy: request.toolPolicy,
						model: request.model,
						thinking: request.thinking,
					});
					send({
						type: "ensureRun",
						runId: request.runId,
						conversationId: result.conversationId,
					});
					return;
				}
				case "submit": {
					const result = await this.submit(
						request.runId,
						request.text,
						request.requestId,
						request.whenBusy,
					);
					send({
						type: "submit",
						runId: request.runId,
						submissionId: result.submissionId,
						...(result.workflowState
							? { workflowState: result.workflowState }
							: {}),
						...(result.workflowNote
							? { workflowNote: result.workflowNote }
							: {}),
					});
					return;
				}
				case "status": {
					const result = await this.status(request.runId);
					send({ type: "status", runId: request.runId, ...result });
					return;
				}
				case "configureRun":
					await this.configureRun(request.runId, {
						...(request.model ? { model: request.model } : {}),
						...(request.thinking ? { thinking: request.thinking } : {}),
					});
					send({ type: "ok" });
					return;
				case "compactRun": {
					const result = await this.compactRun(
						request.runId,
						request.instructions,
					);
					send({ type: "compactRun", runId: request.runId, ...result });
					return;
				}
				case "retryTask": {
					if (!this.retryCapabilityMatches(request.recoveryCapability)) {
						send({
							type: "retryTask",
							runId: safeFailureMessage(request.runId, 128),
							taskId: safeFailureMessage(request.taskId, 128),
							status: "refused",
							reason: "operator recovery authority required",
						});
						return;
					}
					const result = await this.retryParkedTask(
						request.runId,
						request.conversationId,
						request.taskId,
						request.generation,
					);
					send({
						type: "retryTask",
						runId: safeFailureMessage(request.runId, 128),
						taskId: safeFailureMessage(request.taskId, 128),
						...result,
					});
					return;
				}
				case "catalog": {
					const catalog = await this.catalog();
					send({
						type: "catalog",
						models: catalog.models,
						thinkingLevels: catalog.thinkingLevels,
						contextWindows: catalog.contextWindows,
					});
					return;
				}
				case "abort":
					await this.abort(request.runId);
					send({ type: "ok" });
					return;
				case "stopRun":
					await this.stopRun(request.runId);
					send({ type: "ok" });
					return;
				case "prepareRestartForReattachment": {
					// No await between the idle check and shutdown's admission fence.
					const status = this.prepareRestartForReattachment();
					send({ type: "prepareRestartForReattachment", status });
					if (status === "ready") void this.shutdown();
					return;
				}
				case "shutdown":
					send({ type: "ok" });
					void this.shutdown();
					return;
				case "watch": {
					const stop = await this.watchRun(
						request.runId,
						(value) => {
							send({ type: "watchFrame", runId: request.runId, value });
						},
						request.conversationId,
						request.view,
						{
							patches: request.patch === true,
							onPatch: (patch) => {
								send({ type: "watchFrame", runId: request.runId, patch });
							},
						},
					);
					// Close/error may have drained the set while acquisition awaited
					// durable storage. Never strand a late subscription without a peer.
					if (socket.destroyed || this.watchers.get(socket) !== cleanups)
						stop();
					else cleanups.add(stop);
					return;
				}
				default:
					send({
						type: "error",
						code: "invalid-request",
						message: `unknown request type: ${(request as { type?: string }).type}`,
					});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code =
				error instanceof LaunchVerificationError
					? error.kind === "unavailable"
						? "launch-verifier-unavailable"
						: "launch-claim-refused"
					: message.startsWith("unknown run")
						? "unknown-run"
						: message.startsWith("invalid request")
							? "invalid-request"
							: "internal";
			send({ type: "error", code, message });
		}
	}
}

function parseModelRef(model: string): { provider: string; modelId: string } {
	const [provider, ...rest] = model.split("/");
	return { provider: provider ?? model, modelId: rest.join("/") || model };
}

/** A conversation id as a client sent it, or undefined when it is not one. */
function parseConversationId(
	value: string | undefined,
): ConversationId | undefined {
	if (value === undefined || !/^\d+$/.test(value)) return undefined;
	return Number(value) as unknown as ConversationId;
}

/** Best-effort liveness check of a lock file's PID: a stale lock from an
 * unclean shutdown must not permanently block a workflow's host from ever
 * restarting. */
async function isLockLive(lockPath: string): Promise<boolean> {
	try {
		const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
		if (!Number.isFinite(pid) || pid <= 0) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

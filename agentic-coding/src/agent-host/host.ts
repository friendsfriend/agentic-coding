import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
	CompactionResult,
	Storage,
	TaskId,
} from "@earendil-works/pi-durable";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	type Extension,
	Harness,
	type JsonObject,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ClassifierDecisionInput } from "../contracts/workflow.ts";
import {
	CHECKPOINT_RECORD_LIMIT,
	DEVELOPER_ABORT_MESSAGE,
} from "../contracts/workflow.ts";
import {
	checkpointThresholdsForClass,
	type ResolvedCheckpointConfig,
	resolveCheckpointConfig,
} from "../workflow/checkpoint.ts";
import {
	COMPACTION_MAX_INSTRUCTIONS,
	type CompactionCeiling,
	type CompactionConfig,
	type CompactionPolicy,
	evaluateCompactionCeiling,
	resolveCompactionCeiling,
	resolveCompactionPolicy,
} from "../workflow/compaction.ts";
import { boundedCodingTools } from "./bash-tool.ts";
import { createBrowserExtension } from "./browser-tools.ts";
import type { CheckpointSampleInput } from "./checkpoint-sample.ts";
import { sampleCheckpoint } from "./checkpoint-sample.ts";
import { createDurableCodemode } from "./codemode.ts";
import { configuredProviderIds } from "./configured-models.ts";
import { PiAuthCredentialStore } from "./credentials.ts";
import { createDebugExtension } from "./debug-tools.ts";
import {
	ENVIRONMENT_URL_ENV,
	ensureEnvironmentServer,
} from "./environment-capability.ts";
import { createEnvironmentExtension } from "./environment-tools.ts";
import {
	type FailFastDecision,
	failFastEligibleRole,
	type ToolSurfaceMonitor,
	toolSurfaceMonitorFor,
} from "./fail-fast.ts";
import { createFrameThrottle } from "./frame-throttle.ts";
import type { HostLayout } from "./layout.ts";
import { createOrchestratorExtension } from "./orchestrator.ts";
import {
	CHECKPOINT_ACTION_SUMMARY,
	CHECKPOINT_ACTIONS,
	CHECKPOINT_DECIDER,
	CHECKPOINT_INTEGRATION,
	CHECKPOINT_QUESTION_OPTION,
	type CheckpointDecision,
	type CheckpointDigest,
	type CheckpointRuleId,
	type CheckpointSample,
	type CheckpointTrigger,
	checkpointAnswer,
	checkpointAnswerMessage,
	checkpointClassOf,
	checkpointDigestInput,
	checkpointQuestion,
	checkpointSignalState,
	checkpointSteerMessage,
	decideCheckpoint,
	ProgressCheckpoint,
} from "./progress-checkpoint.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	type HostResponse,
	normalizeSubmitMode,
	PROTOCOL_VERSION,
	type RunStatus,
	type SubmitWorkflowState,
	type ToolPolicy,
} from "./protocol.ts";
import type { AgentHostSettings } from "./settings.ts";
import { createStageExtension } from "./stage-tools.ts";
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
	resolveSearchRegistered,
	type ToolSurfaceOptions,
} from "./tool-surface.ts";
import {
	type CheckpointQuestionReply,
	codingTools,
	createAskJevExtension,
	createDebugRequestExtension,
	createPromptExtension,
	createSearchExtension,
	createWorkflowDialogueExtension,
	type DurableRunContext,
	fileCheckpointQuestion,
	type ResumedRunState,
	type RunContextLookup,
	recordAbortedRunHandoff,
	recordCheckpointDecision,
	recordCheckpointRunHandoff,
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

/** One line for a log: an Error's message, or the thrown value as a string. */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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
	runs: Record<string, { conversationId: number }>;
}
const RunMapDoc = defineDoc<RunMapState>({
	kind: "agentic.runs",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {} }),
});

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

function parseRunEnvFile(contents: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of contents.split("\n")) {
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!match) continue;
		const [, key, raw] = match;
		if (!key || raw === undefined) continue;
		env[key] = raw.replace(/^'|'$/g, "").replace(/'\\'''/g, "'");
	}
	return env;
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
/** One live run's run-progress checkpoint: the accumulator, the section's
 * `steer` switch resolved for this run, its step id (the record's `phase`) and
 * how many escalations it has filed (the `runtime.settled` counter). */
interface RunCheckpointState {
	readonly accumulator: ProgressCheckpoint;
	readonly steer: boolean;
	readonly stepId: string;
	readonly role: string;
	escalations: number;
}

/** What filing one escalation's question said about it: the closed outcome the
 * dataset counts, the question it created, and the attention line the record
 * carries, so "the developer was asked" and "the question could not be filed"
 * never read the same. */
interface CheckpointEscalationSummary {
	readonly outcome:
		| "answered"
		| "cancelled"
		| "pending-parked"
		| "filing-failed";
	readonly questionId?: string;
	readonly attention: string;
}

/** A filed question, kept by the caller until the record is written and only
 * then settled: a record never states an intended question as a filed one. */
interface CheckpointEscalationFiling {
	readonly summary: CheckpointEscalationSummary;
	readonly reply: CheckpointQuestionReply;
}

/** What applying one decision did, for the record and the envelope: whether an
 * action was taken, why not when it was not, and the bounded error class of a
 * fail-open path. */
interface CheckpointApplied {
	readonly applied: boolean;
	readonly attention?: string;
	readonly errorClass?: string;
}

/** One checkpoint record's fate: whether the workflow's decision history took
 * it, and whether the command itself failed (an error, unlike a refusal). */
interface CheckpointRecording {
	readonly recorded: boolean;
	readonly failed: boolean;
}

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
	/** The effective `[agents.checkpoint]` section, read at every run start
	 * (efficiency backlog item 19): `host-main.ts` supplies a file-backed
	 * accessor, tests supply a constant. Absent, the documented defaults apply —
	 * enabled, steering on, the pinned class thresholds. */
	readonly checkpoint?: () => ResolvedCheckpointConfig;
	/** Test-only injection for the checkpoint's bounded worktree sample (`git`
	 * diff numbers, `HEAD`, ticked tasks). Production leaves it unset, and the
	 * fixture under `checkpoint-sample.ts` runs with its own 2 s bound. */
	readonly checkpointSample?: (
		input: CheckpointSampleInput,
	) => Promise<CheckpointSample>;
	readonly globalAgentDir: string;
	readonly credentialsPath?: string;
	/** Orchestrator mode (`--orchestrator`): the host installs only the coding
	 * tools and the orchestrator extension, and serves the `orchestrator` tool
	 * policy instead of workflow runs. */
	readonly orchestrator?: boolean;
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
	/** Each live run's run-progress checkpoint accumulator and what the host has
	 * decided about it (efficiency backlog item 19). Keyed by run id, never by
	 * conversation: a checkpoint belongs to the run that earned it, and a run
	 * that reuses a conversation starts a fresh one. */
	private readonly checkpoints = new Map<string, RunCheckpointState>();
	/** Which evaluation of a run's checkpoint is the current one. One runs at a
	 * time per run (which is also what keeps at most one checkpoint question
	 * open), and the *token* is what decides whether the one still running may
	 * write anything: a run that was stopped, or whose checkpoint state was
	 * re-installed, bumps the token, so the evaluation that started earlier can
	 * neither park the successor run nor spend its question. */
	private readonly checkpointEvals = new Map<
		string,
		{ token: number; running: boolean }
	>();
	/** The highest checkpoint ordinal each run id ever reached. A run id can be
	 * ensured again after a stop or a retried launch, and its ordinal must never
	 * restart: `checkpoint:<run>:<ordinal>` is the record's idempotency key, so a
	 * repeated ordinal would be dropped as a duplicate of a decision that has
	 * nothing to do with the new one. The table is bounded — a host process serves
	 * a repository for weeks — and evicting the oldest entry only means a run that
	 * has not been seen for that many other runs restarts its numbering. */
	private readonly checkpointOrdinals = new Map<string, number>();
	/** Compaction tasks a checkpoint's `compact` decision admitted, per
	 * conversation: a task's attribution belongs to the conversation whose
	 * summarizer ran, so one conversation's teardown never rewrites another's. */
	private readonly checkpointCompactions = new Map<
		ConversationId,
		Set<string>
	>();
	private readonly checkpointPending = new Map<ConversationId, number>();
	/** The published tool names, read once: the digest may name a tool only when
	 * it is one the run's surface really registered. */
	private registeredToolNamesCache: ReadonlySet<string> | undefined;
	/** What the one tool-host re-probe of a run answered, so the run's own
	 * `blocked` event reports the mechanism honestly instead of assuming one. */
	private readonly toolProbes = new Map<ConversationId, boolean>();
	/** Measured wall-clock timing per committed assistant entry, keyed by
	 * conversation then entry id. In-memory: a host restart loses it. */
	private readonly timings = new Map<
		ConversationId,
		Record<string, EntryTiming>
	>();
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
	private closing = false;

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
	) {}

	/** The workflow-run extensions: dialogue tools, `ask_jev`, `grep`, the
	 * environment tools, and the workflow system prompt. Never installed in
	 * orchestrator mode. */
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

	private log(line: string): void {
		try {
			fs.appendFileSync(
				this.options.layout.logPath,
				`${new Date().toISOString()} ${line}\n`,
			);
		} catch {
			/* best-effort diagnostics only */
		}
		this.options.log?.(line);
	}

	static async open(options: DurableHostOptions): Promise<DurableHost> {
		fs.mkdirSync(options.layout.root, { recursive: true, mode: 0o700 });
		fs.mkdirSync(options.layout.runEnvDir, { recursive: true, mode: 0o700 });
		const registry = createRegistry();
		const host: { instance?: DurableHost } = {};
		// Whether this host's runs get `codemode` at all, resolved once and before
		// the coding tools are installed: the same flag decides whether the tool is
		// registered below and whether the `read`/`grep`/`bash` descriptions and
		// the assignments name it (tool-surface.ts). A run is never told about a
		// tool its tool set does not contain.
		// The same resolution decides whether `grep` is named: orchestrator mode
		// installs the coding tools but never the search extension.
		const surface: ToolSurfaceOptions = {
			codemodeRegistered: resolveCodemodeRegistered(
				options.globalAgentDir,
				options.orchestrator === true,
			),
			searchRegistered: resolveSearchRegistered(options.orchestrator === true),
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
			? createOrchestratorExtension(lookup)
			: undefined;
		if (orchestrator) registry.install(orchestrator);
		const workflowTools = orchestrator
			? { readOnlyTools: [], workflowTools: [] }
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
		const models =
			options.models ??
			withDurableSession(
				builtinModels({
					credentials: new PiAuthCredentialStore(
						options.credentialsPath,
					) as never,
				}),
			);
		const storage =
			options.storage ??
			(await openNodeSqliteStorage(options.layout.storagePath));
		const context: Context = BACKGROUND_CONTEXT;
		const fallbackCompaction = resolveCompactionPolicy(
			options.compaction?.() ?? options.settings.compaction ?? {},
		);
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: {
					// A getter, not a snapshot: `HarnessSettings` are "read at every
					// resolution and never copied", so a saved configuration change reaches a
					// *running* conversation without a host restart (design D4). The
					// fallback keeps our documented defaults in place during `resume()`,
					// before the run map exists.
					get compaction() {
						return host.instance?.compactionPolicy() ?? fallbackCompaction;
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
		harness.resume();
		const instance = new DurableHost(
			harness,
			options,
			models,
			codemode?.tool,
			workflowTools.readOnlyTools,
			workflowTools.workflowTools,
			orchestrator,
			registry,
		);
		host.instance = instance;
		return instance;
	}

	async ensureRun(input: EnsureRunInput): Promise<{ conversationId: string }> {
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
		const map = await this.harness.snapshot(RunMapDoc, context);
		const existingId = map?.runs[key]?.conversationId;
		let conversation: Conversation | undefined = existingId
			? await this.harness.conversation(existingId as ConversationId, context)
			: undefined;
		const readOnly = input.toolPolicy === "read-only";
		const debugRun = envVars.HERDR_ROLE === "debug";
		const toolSelection = this.toolSelectionFor(input.toolPolicy, debugRun);
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
						...(toolSelection ? { tools: toolSelection } : {}),
					},
				},
				context,
			);
			await this.harness.commit(async (tx) => {
				const doc = await tx.doc(RunMapDoc);
				doc.runs[key] = {
					conversationId: conversation?.id as unknown as number,
				};
			}, context);
			createdConversation = true;
		} else if (toolSelection) {
			await conversation.configure(
				{ tools: toolSelection, cwd: input.cwd },
				context,
			);
		} else {
			await conversation.configure({ cwd: input.cwd }, context);
		}
		const runContext: DurableRunContext = {
			runId: input.runId,
			cwd: input.cwd,
			env: envVars,
			lastDeveloperMessage: () =>
				this.answeredDeveloperMessage(conversation.id),
			...(readJevBinding(envVars) ? { jev: readJevBinding(envVars) } : {}),
		};
		this.contexts.set(conversation.id, runContext);
		this.runContexts.set(input.runId, runContext);
		const model =
			(await this.conversationModelRef(conversation)) ?? input.model;
		this.runs.set(input.runId, {
			conversationId: conversation.id,
			readOnly,
			...(model ? { model } : {}),
		});
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
		// The run-progress checkpoint of this run, or none for the same sessions
		// (plus a configuration that switched the feature off).
		this.installCheckpoint(input.runId, envVars, readOnly);
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
						},
						// The measured context of one committed turn is also the cost
						// ceiling's input, so one event stream serves both and the ceiling
						// is decided between turns, never inside a tool call. The ceiling is
						// resolved for the run the measurement was recorded under, so a run
						// reusing a conversation is judged by its own window and profile.
						onMeasuredContext: (
							{ promptTokens, turnIndex, costUnits },
							measured,
						) => {
							const measuredRunId =
								measured.runId ??
								this.boundRunId(conversationId) ??
								input.runId;
							this.observeContext(measuredRunId, promptTokens, turnIndex);
							// The same measured turn is the checkpoint's turn: one event stream
							// feeds both supervisors, and the checkpoint's own evaluation runs
							// detached from this handler.
							this.observeCheckpointTurn(
								measuredRunId,
								turnIndex,
								promptTokens,
								costUnits,
							);
						},
						compactionKind: (taskId) => {
							const pendingCheckpoint =
								this.checkpointPending.get(conversation.id) ?? 0;
							if (pendingCheckpoint > 0) {
								this.checkpointPending.set(
									conversation.id,
									pendingCheckpoint - 1,
								);
								this.checkpointCompactionsFor(conversation.id).add(taskId);
								return "auto-checkpoint";
							}
							const pending = this.ceilingPending.get(conversation.id) ?? 0;
							if (pending > 0) {
								this.ceilingPending.set(conversation.id, pending - 1);
								this.ceilingCompactions.add(taskId);
								return "auto-ceiling";
							}
							if (this.checkpointCompactionsFor(conversation.id).has(taskId))
								return "auto-checkpoint";
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
						// The run's own checkpoint counters travel with its settled envelope,
						// resolved for the run the conversation is bound to now.
						runCounters: () => this.checkpointCounters(conversationId),
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
		this.log(`ensureRun ${input.runId} -> conversation ${conversation.id}`);
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
	private toolSelectionFor(policy: ToolPolicy, debugRun = false) {
		if (this.orchestratorExtension) {
			if (policy !== "orchestrator")
				throw new Error("this host only serves the orchestrator session");
			// The orchestrator decides for itself whether a request is a direct edit
			// or a workflow: it gets the full coding tools (read/write/edit/bash)
			// alongside its own workflow-management tools, not a read-only subset.
			return [
				...codingTools(false),
				...(this.orchestratorExtension.tools ?? []),
			];
		}
		if (policy === "orchestrator")
			throw new Error("the orchestrator policy needs an orchestrator host");
		if (policy === "read-only") return this.readOnlyToolSelection(debugRun);
		// A debug run's tool list is explicit for one reason: the default
		// selection would offer the delegated debug request tools, and a debug
		// run must not delegate another request.
		if (!debugRun) return undefined;
		return [
			...codingTools(false),
			...withoutDebugRequestTools(this.workflowTools),
			...(this.codemodeTool ? [this.codemodeTool] : []),
		];
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
	compactionPolicyForTest(): CompactionPolicy {
		return this.compactionPolicy();
	}

	referenceWindowForTest(): number | undefined {
		return this.referenceWindow();
	}

	private requireConversation(runId: string): RunRecord {
		const found = this.runs.get(runId);
		if (!found) throw new Error(`unknown run: ${runId}`);
		return found;
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

	/** The smallest context window among the models the host's tracked runs use
	 * (design D3). One harness-wide policy must stay safe for the smallest window
	 * in play, so a percentage resolves against that one; `undefined` when no
	 * tracked run names a model the catalog knows, which makes a percentage fall
	 * back to its documented absolute default. */
	private referenceWindow(): number | undefined {
		let smallest: number | undefined;
		for (const record of this.runs.values()) {
			if (!record.model) continue;
			const window = this.modelWindow(record.model);
			if (window === undefined) continue;
			if (smallest === undefined || window < smallest) smallest = window;
		}
		return smallest;
	}

	/** The effective compaction section, re-read at every resolution (design D4). */
	private compactionConfig(): CompactionConfig {
		return (
			this.options.compaction?.() ?? this.options.settings.compaction ?? {}
		);
	}

	/** The policy pi-durable receives, resolved at every read: the effective
	 * configuration section against the current reference window. */
	private compactionPolicy(): CompactionPolicy {
		return resolveCompactionPolicy(
			this.compactionConfig(),
			this.referenceWindow(),
		);
	}

	/** The cost ceiling of one run: resolved against that run's own model window
	 * (the window its conversation actually has), falling back to the smallest
	 * window in play when its model is unknown. */
	private resolveRunCeiling(record: RunRecord): CompactionCeiling {
		const window =
			(record.model ? this.modelWindow(record.model) : undefined) ??
			this.referenceWindow();
		return resolveCompactionCeiling(this.compactionConfig(), window);
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
			void this.admitCompaction(
				runId,
				record,
				state,
				ceiling,
				promptTokens,
				"auto-ceiling",
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

	/** Admit one compaction, serially with the conversation's other mutations, at
	 * most one per conversation. `kind` names what decided it: the cost ceiling or
	 * a run-progress checkpoint's `compact`, which is the same summarizer under a
	 * different reason and so lands in its own telemetry counter. */
	private async admitCompaction(
		runId: string,
		record: RunRecord,
		state: CeilingRecord,
		ceiling: CompactionCeiling,
		contextTokens: number,
		kind: "auto-ceiling" | "auto-checkpoint",
	): Promise<boolean> {
		try {
			return await this.serialized(record, async () => {
				const conversation = await this.harness.conversation(
					record.conversationId,
					BACKGROUND_CONTEXT,
				);
				if (!conversation) return false;
				// A summarizer already in flight is summarizing the same context, so
				// this admission starts nothing and says so: the envelope of the
				// supervisor that did start it carries the kind.
				if ((await this.liveCompactions(conversation)).length > 0) return false;
				// No instructions on purpose: both paths run exactly the summarizer the
				// overflow path runs (same prompt, same head retention), so a worker's
				// assignment and a verifier's plan/finding references survive a proactive
				// compaction the way they survive a forced one.
				const pendingClaims =
					kind === "auto-ceiling"
						? this.ceilingPending
						: this.checkpointPending;
				const claimed =
					kind === "auto-ceiling"
						? this.ceilingCompactions
						: this.checkpointCompactionsFor(record.conversationId);
				const pending = pendingClaims.get(record.conversationId) ?? 0;
				// The kind is claimed before the call: pi-durable publishes
				// `compaction_start` while `compact()` is still in flight.
				pendingClaims.set(record.conversationId, pending + 1);
				let taskId: Awaited<ReturnType<typeof conversation.compact>>;
				try {
					taskId = await conversation.compact(undefined, BACKGROUND_CONTEXT);
				} finally {
					// A task that never started (nothing to compact) must not leave a claim
					// behind for a later manual compaction to inherit.
					pendingClaims.set(record.conversationId, pending);
				}
				claimed.add(String(taskId));
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
						kind,
						ceilingTokens: ceiling.ceilingTokens,
						contextTokens,
						turnIndex: state.turnIndex,
						floorTurns: ceiling.floorTurns,
						floorTokens: ceiling.floorTokens,
						taskId: String(taskId),
					});
				return true;
			});
		} catch (error) {
			this.log(
				`run ${runId}: ${kind} compaction not admitted: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return false;
		}
	}

	// ---- run-progress checkpoint (efficiency backlog item 19) --------------
	//
	// One supervisor per run, fed by the telemetry stream the host already
	// consumes, deciding over a fixed vocabulary every N turns and at a stall.
	// Two rules hold the whole feature together and are enforced here rather
	// than by any caller:
	//
	//  1. A turn count never stops or blocks a run. The only stop in this
	//     section is reached after a developer question was recorded and is
	//     still unanswered or was cancelled — never from a threshold alone.
	//  2. Every step fails open. An exception, a sample that fails, a record the
	//     workflow refuses or a question that cannot be filed leaves the run
	//     running and marks only the checkpoint's own envelope `status: error`.

	/** The effective `[agents.checkpoint]` section: a constant in tests, the
	 * configuration file read per run start in production. */
	private checkpointConfig(): ResolvedCheckpointConfig {
		return this.options.checkpoint?.() ?? resolveCheckpointConfig(undefined);
	}

	/** The published tool names, read once: the digest may name a tool only when
	 * the run's own surface registered it. */
	private registeredToolNames(): ReadonlySet<string> {
		if (this.registeredToolNamesCache === undefined) {
			const names = new Set<string>();
			for (const { tool } of this.registry.snapshot().tools()) {
				const name = (tool as { readonly name?: unknown }).name;
				if (typeof name === "string") names.add(name);
			}
			this.registeredToolNamesCache = names;
		}
		return this.registeredToolNamesCache;
	}

	/** Give one run its checkpoint, or none when the feature leaves it alone: a
	 * session without a run id (the orchestrator's own), a host in orchestrator
	 * mode, or a configuration with the feature off. */
	private installCheckpoint(
		runId: string,
		env: Readonly<Record<string, string>>,
		readOnly: boolean,
	): void {
		const previous = this.checkpoints.get(runId);
		this.checkpoints.delete(runId);
		const config = this.checkpointConfig();
		if (!config.enabled || this.options.orchestrator === true) {
			// Dropping the state is enough to retire a running evaluation (it compares
			// state identity), and the feature is off: nothing else is kept for this
			// run, so a disabled host retains no checkpoint entry at all.
			this.checkpointEvals.delete(runId);
			return;
		}
		if (!env.HERDR_RUN_ID) {
			this.checkpointEvals.delete(runId);
			return;
		}
		// Whatever was evaluating this run's previous checkpoint is now stale.
		this.invalidateCheckpointEval(runId);
		const checkpointClass = checkpointClassOf(env.HERDR_CHECKPOINT_CLASS);
		this.checkpoints.set(runId, {
			// A re-installed run is the same run: its ordinal continues where it was,
			// so two checkpoints of one run can never both be recorded as
			// `checkpoint:<run>:1`, and its escalation count still reaches
			// `runtime.settled`.
			accumulator:
				previous?.accumulator ??
				new ProgressCheckpoint({
					checkpointClass,
					// A stopped run's ordinal is remembered, so a re-issued run id continues
					// the numbering instead of re-issuing a record id it already used.
					ordinal: this.checkpointOrdinals.get(runId) ?? 0,
					thresholds: checkpointThresholdsForClass(config, checkpointClass),
					contextTokens: config.contextTokens,
					readOnly,
					// The fail-fast monitor owns a dead surface, so its exempt roles never
					// report the failing-tool signal here either.
					failingToolEligible: failFastEligibleRole(env.HERDR_ROLE),
					isRegisteredTool: (tool) => this.registeredToolNames().has(tool),
				}),
			steer: config.steer,
			stepId: env.HERDR_STEP_ID ?? "",
			role: env.HERDR_ROLE ?? "",
			escalations: previous?.escalations ?? 0,
		});
	}

	/** One conversation's checkpoint-compaction task ids, created on first use. */
	private checkpointCompactionsFor(
		conversationId: ConversationId,
	): Set<string> {
		const existing = this.checkpointCompactions.get(conversationId);
		if (existing) return existing;
		const created = new Set<string>();
		this.checkpointCompactions.set(conversationId, created);
		return created;
	}

	/** One committed turn for the run's checkpoint. Feeds the accumulator and
	 * starts a due evaluation detached from the telemetry handler: a checkpoint
	 * never delays the turn that triggered it. */
	private observeCheckpointTurn(
		runId: string,
		turnIndex: number,
		contextTokens: number,
		costUnits: number,
	): void {
		const state = this.checkpoints.get(runId);
		if (!state || !this.runs.has(runId)) return;
		try {
			state.accumulator.observeTurn({
				turn: Math.max(1, turnIndex + 1),
				contextTokens,
				costUnits,
			});
		} catch (error) {
			// An accumulator that cannot observe a turn must not break the turn.
			this.log(
				`run ${runId}: checkpoint observation failed: ${messageOf(error)}`,
			);
			return;
		}
		void this.maybeCheckpoint(runId).catch(() => undefined);
	}

	/** One finished tool call, which is the checkpoint's progress evidence. */
	private observeCheckpointTool(
		runId: string,
		observation: ToolOutcomeObservation,
	): void {
		const state = this.checkpoints.get(runId);
		if (!state) return;
		try {
			state.accumulator.observeTool({
				tool: observation.tool,
				ok: observation.ok,
				...(observation.argsHash !== undefined
					? { argsHash: observation.argsHash }
					: {}),
			});
		} catch (error) {
			this.log(
				`run ${runId}: checkpoint tool observation failed: ${messageOf(error)}`,
			);
		}
	}

	/** The counters the run's `runtime.settled` envelope carries. */
	private checkpointCounters(conversationId: ConversationId): {
		checkpoints: number;
		checkpointEscalations: number;
	} {
		const runId = this.boundRunId(conversationId);
		const state = runId === undefined ? undefined : this.checkpoints.get(runId);
		if (!state) return { checkpoints: 0, checkpointEscalations: 0 };
		return {
			checkpoints: state.accumulator.checkpoints,
			checkpointEscalations: state.escalations,
		};
	}

	/** Evaluate one checkpoint when one is due. One at a time per run, and the
	 * whole body is fail-open: nothing here may throw into the conversation. */
	private async maybeCheckpoint(runId: string): Promise<void> {
		const state = this.checkpoints.get(runId);
		if (!state || this.checkpointEvals.get(runId)?.running === true) return;
		if (!state.accumulator.due()) return;
		const token = (this.checkpointEvals.get(runId)?.token ?? 0) + 1;
		this.checkpointEvals.set(runId, { token, running: true });
		const startedAt = Date.now();
		// Every wait below may outlive the run that started it: `stopped` says so,
		// and the evaluation writes nothing once it is true.
		const stopped = () =>
			this.checkpointEvals.get(runId)?.token !== token ||
			this.checkpoints.get(runId) !== state;
		// Which checkpoint this attempt took, once it took one: a failure *after*
		// the digest was taken is reported on the decision's own envelope (or its
		// escalation's), never as a second, decision-less `runtime.checkpoint`.
		let taken: number | undefined;
		let trigger: CheckpointTrigger = "soft";
		try {
			// The sample is only taken at a boundary: no run pays for a `git` call on
			// a turn it does not checkpoint.
			const { sample, errorClass } = await this.checkpointSampleFor(runId);
			if (stopped()) return;
			const due = state.accumulator.due();
			if (!due) return;
			trigger = due;
			state.accumulator.noteSample(sample);
			taken = await this.evaluateCheckpoint(
				runId,
				state,
				trigger,
				startedAt,
				errorClass,
				stopped,
			);
		} catch (error) {
			this.checkpointErrored(
				runId,
				"evaluate",
				error,
				trigger,
				startedAt,
				taken,
			);
		} finally {
			if (this.checkpointEvals.get(runId)?.token === token)
				this.checkpointEvals.set(runId, { token, running: false });
		}
	}

	/** Retire whatever evaluation is running for one run's checkpoint, so the
	 * evaluation that started earlier writes nothing after its next await. The
	 * token only moves forward, so a later evaluation can never be confused with
	 * the one it replaced. */
	private invalidateCheckpointEval(runId: string): void {
		const token = this.checkpointEvals.get(runId)?.token ?? 0;
		this.checkpointEvals.set(runId, { token: token + 1, running: false });
	}

	/** How many run ids the ordinal high-water table remembers. One entry is a run
	 * id and a number, and the table only has to cover runs a host may re-issue. */
	private static readonly CHECKPOINT_ORDINAL_MEMORY = 256;

	private rememberCheckpointOrdinal(
		runId: string,
		state: RunCheckpointState,
	): void {
		const ordinal = Math.max(
			this.checkpointOrdinals.get(runId) ?? 0,
			state.accumulator.checkpoints,
		);
		if (ordinal <= 0) return;
		this.checkpointOrdinals.delete(runId);
		this.checkpointOrdinals.set(runId, ordinal);
		while (
			this.checkpointOrdinals.size > DurableHost.CHECKPOINT_ORDINAL_MEMORY
		) {
			const oldest = this.checkpointOrdinals.keys().next().value;
			if (oldest === undefined) break;
			this.checkpointOrdinals.delete(oldest);
		}
	}

	/** The bounded worktree sample of one checkpoint. A sampler that fails is a
	 * missing measurement: the checkpoint still evaluates on what it has, and the
	 * failure is stated as its bounded error class rather than delaying the run. */
	private async checkpointSampleFor(runId: string): Promise<{
		sample: CheckpointSample;
		errorClass?: string;
	}> {
		const context = this.runContexts.get(runId);
		if (!context) return { sample: {} };
		const sample = this.options.checkpointSample ?? sampleCheckpoint;
		try {
			return {
				sample: await sample({
					cwd: context.cwd,
					...(context.env.HERDR_CHANGE_ID === undefined
						? {}
						: { changeId: context.env.HERDR_CHANGE_ID }),
				}),
			};
		} catch (error) {
			this.log(`run ${runId}: checkpoint sample failed: ${messageOf(error)}`);
			return { sample: {}, errorClass: "sample" };
		}
	}

	/** Decide, apply, file and record one checkpoint, then report it. `escalate`
	 * files its developer question before the record is written, so the record
	 * states what happened to the question (filed and answered, filed and
	 * unanswered, or not filed at all) instead of what was intended — and only
	 * after that may the run stop. One checkpoint exports exactly one
	 * `runtime.checkpoint` envelope; the question's fate has its own
	 * `runtime.checkpoint_escalation` envelope. */
	private async evaluateCheckpoint(
		runId: string,
		state: RunCheckpointState,
		trigger: CheckpointTrigger,
		startedAt: number,
		sampleErrorClass: string | undefined,
		stopped: () => boolean,
	): Promise<number | undefined> {
		const context = this.runContexts.get(runId);
		if (!context || !this.runs.has(runId) || stopped()) return undefined;
		const preview = state.accumulator.digestPreview();
		const digest = state.accumulator.takeDigest(trigger, {
			compactionAdmissible: this.checkpointCompactionAdmissible(
				runId,
				preview.contextTokens,
			),
		});
		const decision = decideCheckpoint(digest, { steer: state.steer });
		// The digest advanced the schedule; a run that was stopped or re-installed
		// meanwhile gets no action, no question and no envelope from this attempt.
		if (stopped()) return digest.ordinal;
		const applied = await this.applyCheckpointDecision(runId, digest, decision);
		// What the next digest reads is what happened, not what was decided: a
		// steer the harness refused was never delivered, so the signal it was meant
		// to answer stays open and the next checkpoint may nudge again instead of
		// escalating it as `steer-ignored`.
		state.accumulator.noteDecision(decision, digest, {
			applied: applied.applied,
		});
		// Filing and recording are the two subprocess waits of this evaluation, and
		// either may outlive the run: a superseded attempt must then neither file a
		// question nor write a record for a run that is no longer its own.
		if (decision.action === "escalate" && stopped()) return digest.ordinal;
		const filed =
			decision.action === "escalate"
				? await this.fileCheckpointEscalation(
						context,
						digest,
						decision.rule,
						state,
					)
				: undefined;
		if (stopped()) {
			// The decision envelope belongs to whoever owns the run now, but a question
			// the developer can see is owed its fate: exactly one escalation envelope
			// per filed question, and never a park for a run that is no longer ours.
			if (filed) this.emitFiledFate(context, digest, decision.rule, filed);
			return digest.ordinal;
		}
		const recording = await this.recordCheckpoint(
			context,
			state,
			digest,
			decision,
			applied,
			filed?.summary,
		);
		// The record command has no timeout, so this is the longest wait of the
		// whole evaluation.
		if (stopped()) {
			if (filed) this.emitFiledFate(context, digest, decision.rule, filed);
			return digest.ordinal;
		}
		this.emitCheckpoint(context, digest, decision, applied, recording, {
			startedAt,
			...(sampleErrorClass === undefined ? {} : { sampleErrorClass }),
		});
		if (filed) {
			// The envelope above is this checkpoint's one decision record. Settling is
			// the only part that can still fail (a submission the harness refuses, a
			// handoff record the engine rejects), and its own escalation envelope was
			// already written, so a failure here is logged and never re-reported as a
			// second checkpoint.
			try {
				await this.settleCheckpointEscalation(
					runId,
					state,
					digest,
					decision.rule,
					filed,
					stopped,
				);
			} catch (error) {
				this.log(
					`run ${runId}: checkpoint escalation not settled: ${messageOf(error)}`,
				);
			}
		}
		return digest.ordinal;
	}

	/** Whether the cost ceiling's floor and loop guard admit a compaction now, so
	 * the decider can only pick `compact` when the summarizer would run. The
	 * context is the digest's own — the one number the decision and the admission
	 * both use — so a plan can never say `compact` about a context the admission
	 * then evaluates differently. */
	private checkpointCompactionAdmissible(
		runId: string,
		contextTokens: number,
	): boolean {
		const record = this.runs.get(runId);
		if (!record) return false;
		const ceiling = this.resolveRunCeiling(record);
		const ceilingState = this.ceilings.get(record.conversationId);
		if (!ceiling.active || !ceilingState) return false;
		// A compaction the ceiling (or an earlier checkpoint) already admitted is
		// summarizing exactly this context, and one whose reduced context has not
		// been measured yet is still in effect: a second admission would summarize
		// the same context twice, so the context rule falls through to the signal
		// rules instead of deciding an action that cannot happen.
		if (ceilingState.awaitingBaseline) return false;
		if (
			(this.ceilingPending.get(record.conversationId) ?? 0) > 0 ||
			(this.checkpointPending.get(record.conversationId) ?? 0) > 0
		)
			return false;
		const decision = evaluateCompactionCeiling({
			ceiling,
			contextTokens,
			state: {
				...ceilingState,
				...(ceilingState.baselineTokens !== undefined
					? { lastCompactionTokens: ceilingState.baselineTokens }
					: {}),
			},
		});
		return decision.kind === "compact";
	}

	/** Take the decision's action. `continue` is a no-op, `steer` submits one
	 * catalog message, `compact` runs the ceiling's summarizer under its own
	 * kind, and the two remaining actions act only through the escalation path.
	 * A failed action is reported, never re-thrown. */
	private async applyCheckpointDecision(
		runId: string,
		digest: CheckpointDigest,
		decision: CheckpointDecision,
	): Promise<CheckpointApplied> {
		if (decision.action === "continue") return { applied: true };
		if (decision.action === "steer") {
			if (decision.signal === undefined)
				return { applied: false, attention: "no signal to steer" };
			try {
				await this.submit(
					runId,
					checkpointSteerMessage(decision.signal, digest),
					randomUUID(),
					"steer",
				);
				return { applied: true };
			} catch (error) {
				this.log(
					`run ${runId}: checkpoint steer not delivered: ${messageOf(error)}`,
				);
				return {
					applied: false,
					attention: "steer not delivered",
					errorClass: "steer",
				};
			}
		}
		if (decision.action === "compact") {
			try {
				const admitted = await this.compactForCheckpoint(runId, digest);
				return admitted
					? { applied: true }
					: { applied: false, attention: "compaction not admitted" };
			} catch (error) {
				this.log(
					`run ${runId}: checkpoint compaction failed: ${messageOf(error)}`,
				);
				return {
					applied: false,
					attention: "compaction failed",
					errorClass: "compact",
				};
			}
		}
		if (decision.action === "switch-model")
			// Vocabulary only: no rule selects it, and nothing here would act on it.
			return { applied: false, attention: "switch-model is not enabled" };
		// `escalate` is applied by the escalation path once its question exists;
		// until then nothing about the run has changed.
		return { applied: false };
	}

	/** Run the ceiling's summarizer for a `compact` decision, counted as
	 * `auto-checkpoint` rather than `auto-ceiling`. */
	private async compactForCheckpoint(
		runId: string,
		digest: CheckpointDigest,
	): Promise<boolean> {
		const record = this.runs.get(runId);
		if (!record) return false;
		const ceiling = this.resolveRunCeiling(record);
		const ceilingState = this.ceilings.get(record.conversationId);
		if (!ceiling.active || !ceilingState) return false;
		const decision = evaluateCompactionCeiling({
			ceiling,
			contextTokens: digest.contextTokens,
			state: {
				...ceilingState,
				...(ceilingState.baselineTokens !== undefined
					? { lastCompactionTokens: ceilingState.baselineTokens }
					: {}),
			},
		});
		if (decision.kind !== "compact") return false;
		// The admission may find a summarizer already in flight — the cost ceiling
		// admits the same context on the same measured turn — and then this decision
		// started nothing. Reporting that keeps `applied` honest and the compaction
		// counted once, under the supervisor that really started it.
		return await this.admitCompaction(
			runId,
			record,
			ceilingState,
			ceiling,
			digest.contextTokens,
			"auto-checkpoint",
		);
	}

	/** Write the decision into the workflow's bounded history, up to the caps the
	 * contract declares. A refusal is reported as `recorded: false`; a command
	 * that failed is reported as an error and never ends the run. The attention
	 * line states what the decision did — and, for an escalation, what became of
	 * its question. */
	private async recordCheckpoint(
		context: DurableRunContext,
		state: RunCheckpointState,
		digest: CheckpointDigest,
		decision: CheckpointDecision,
		applied: CheckpointApplied,
		escalation?: CheckpointEscalationSummary,
	): Promise<CheckpointRecording> {
		if (digest.ordinal > CHECKPOINT_RECORD_LIMIT)
			return { recorded: false, failed: false };
		// One attention line, saying what happened: the decider's own note (steering
		// was off, the context was over its limit and the compaction refused) and
		// the applied/filed outcome are both facts a reader needs, and the record
		// boundary accepts up to three closed reasons after the rule id.
		const reasons = [
			...new Set(
				[decision.attention, escalation?.attention ?? applied.attention].filter(
					(reason): reason is string =>
						reason !== undefined && reason.length > 0,
				),
			),
		];
		const attention =
			reasons.length === 0
				? `rule ${decision.rule}`
				: `rule ${decision.rule}; ${reasons.join("; ")}`;
		const record: ClassifierDecisionInput = {
			integration: CHECKPOINT_INTEGRATION,
			phase: state.stepId,
			questionId: `checkpoint:${context.runId}:${digest.ordinal}`,
			model: CHECKPOINT_DECIDER,
			input: checkpointDigestInput(digest),
			options: CHECKPOINT_ACTIONS.map((action) => ({
				label: action,
				profile: action,
				criteria: CHECKPOINT_ACTION_SUMMARY[action],
			})),
			answer: checkpointAnswer(decision),
			result: {
				applied: applied.applied,
				profiles: applied.applied ? [decision.action] : [],
				attention,
			},
		};
		const reply = await recordCheckpointDecision(context, record);
		return { recorded: reply.recorded, failed: reply.failed === true };
	}

	/** Publish one checkpoint's fixed-field envelope. Every field is a number, a
	 * boolean, a closed-vocabulary token or a registered tool name. */
	private emitCheckpoint(
		context: DurableRunContext,
		digest: CheckpointDigest,
		decision: CheckpointDecision,
		applied: CheckpointApplied,
		recording: CheckpointRecording,
		timing: { startedAt: number; sampleErrorClass?: string },
	): void {
		const signals = checkpointSignalState(digest);
		const errorClass =
			applied.errorClass ??
			timing.sampleErrorClass ??
			(recording.failed ? "record" : undefined);
		emitToolTelemetry(context.env, "runtime.checkpoint", {
			"herdr.checkpoint.ordinal": digest.ordinal,
			"herdr.checkpoint.trigger": digest.trigger,
			"herdr.checkpoint.class": digest.checkpointClass,
			"herdr.checkpoint.read_only": digest.readOnly,
			"herdr.checkpoint.turns": digest.turns,
			"herdr.checkpoint.cost_units": digest.costUnits,
			"herdr.checkpoint.context_tokens": digest.contextTokens,
			"herdr.checkpoint.peak_context_tokens": digest.peakContextTokens,
			"herdr.checkpoint.soft_turns": digest.softTurns,
			"herdr.checkpoint.hard_turns": digest.hardTurns,
			"herdr.checkpoint.context_limit": digest.contextLimit,
			"herdr.checkpoint.signals":
				signals.length === 0 ? "none" : signals.join(","),
			"herdr.checkpoint.turns_since_progress": digest.turnsSinceProgress,
			"herdr.checkpoint.repeat_calls": digest.repeatCalls,
			"herdr.checkpoint.window_calls": digest.windowCalls,
			"herdr.checkpoint.failing_tool_streak": digest.failingToolStreak,
			"herdr.checkpoint.cost_rising_ratio": digest.costRisingRatio,
			"herdr.checkpoint.window_turns": digest.window.turns,
			"herdr.checkpoint.window_progress": digest.window.progress,
			"herdr.checkpoint.diff_files": digest.diff?.files ?? -1,
			"herdr.checkpoint.ticked_tasks": digest.tickedTasks ?? -1,
			"herdr.checkpoint.decision": decision.action,
			"herdr.checkpoint.rule": decision.rule,
			"herdr.checkpoint.applied": applied.applied,
			"herdr.checkpoint.decider": CHECKPOINT_DECIDER,
			"herdr.checkpoint.latency_ms": Math.max(0, Date.now() - timing.startedAt),
			"herdr.checkpoint.recorded": recording.recorded,
			"herdr.checkpoint.status": errorClass === undefined ? "ok" : "error",
			...(errorClass === undefined
				? {}
				: { "herdr.checkpoint.error_class": errorClass }),
		});
	}

	/** A checkpoint that failed open before it decided anything: the run keeps
	 * running, and the failure is stated as its own error report. It carries no
	 * decision or rule because none was made — the decision distribution counts
	 * decisions, not failures. */
	private checkpointErrored(
		runId: string,
		errorClass: string,
		error: unknown,
		trigger: CheckpointTrigger,
		startedAt: number,
		/** The ordinal this attempt already took, when it took one: the decision
		 * envelope for that checkpoint is written, so this attempt has nothing
		 * left to report. */
		taken?: number,
	): void {
		this.log(
			`run ${runId}: progress checkpoint failed open (${errorClass}): ${messageOf(error)}`,
		);
		if (taken !== undefined) return;
		const context = this.runContexts.get(runId);
		const state = this.checkpoints.get(runId);
		if (!context || !state) return;
		const preview = state.accumulator.digestPreview();
		emitToolTelemetry(context.env, "runtime.checkpoint", {
			"herdr.checkpoint.ordinal": preview.ordinal,
			"herdr.checkpoint.trigger": trigger,
			"herdr.checkpoint.class": preview.checkpointClass,
			"herdr.checkpoint.turns": preview.turns,
			"herdr.checkpoint.applied": false,
			"herdr.checkpoint.decider": CHECKPOINT_DECIDER,
			"herdr.checkpoint.latency_ms": Math.max(0, Date.now() - startedAt),
			"herdr.checkpoint.recorded": false,
			"herdr.checkpoint.status": "error",
			"herdr.checkpoint.error_class": errorClass,
		});
	}

	/** File the developer question an `escalate` decision asks, without acting on
	 * its answer yet. The caller writes the record from what this returns, and
	 * only then applies the answer — so a run can never stop before both the
	 * question and the record naming it exist. */
	private async fileCheckpointEscalation(
		context: DurableRunContext,
		digest: CheckpointDigest,
		rule: CheckpointRuleId,
		state: RunCheckpointState,
	): Promise<CheckpointEscalationFiling> {
		const text = checkpointQuestion(digest, {
			rule,
			step: state.stepId,
			role: state.role,
		});
		const reply = await fileCheckpointQuestion(context, {
			description: text.description,
			context: text.context,
			options: [
				{
					title: CHECKPOINT_QUESTION_OPTION.label,
					value: CHECKPOINT_QUESTION_OPTION.id,
					recommended: true,
				},
			],
		});
		if (
			reply.failed === true ||
			reply.id === undefined ||
			reply.status === undefined
		)
			// A question that cannot be filed is one of the fail-open outcomes: the
			// run continues, and the escalation's own envelope states the bounded
			// error class.
			return {
				summary: { outcome: "filing-failed", attention: "question not filed" },
				reply,
			};
		const outcome: CheckpointEscalationSummary["outcome"] =
			reply.status === "answered"
				? "answered"
				: reply.status === "pending"
					? "pending-parked"
					: "cancelled";
		return {
			summary: {
				outcome,
				questionId: reply.id,
				attention:
					outcome === "answered"
						? `question ${reply.id} answered`
						: outcome === "pending-parked"
							? `question ${reply.id} unanswered`
							: `question ${reply.id} cancelled`,
			},
			reply,
		};
	}

	/** Apply a filed question's answer. Answered re-arms the run and delivers the
	 * developer's direction; unanswered or cancelled stops it. This is the only
	 * place a checkpoint can stop a run, and the stop always names a question
	 * the durable store holds. */
	private async settleCheckpointEscalation(
		runId: string,
		state: RunCheckpointState,
		digest: CheckpointDigest,
		rule: CheckpointRuleId,
		filed: CheckpointEscalationFiling,
		stopped: () => boolean,
	): Promise<void> {
		const context = this.runContexts.get(runId);
		if (!context) return;
		const { summary, reply } = filed;
		if (summary.outcome === "filing-failed") {
			this.emitCheckpointEscalation(context, digest, rule, {
				...summary,
				errorClass: "question",
				...(reply.reason === undefined ? {} : { reason: reply.reason }),
			});
			return;
		}
		state.escalations += 1;
		if (summary.outcome === "answered" && reply.id !== undefined) {
			const custom =
				reply.answer?.kind === "custom" ? reply.answer.value : undefined;
			try {
				await this.submit(
					runId,
					checkpointAnswerMessage(custom),
					randomUUID(),
					"steer",
				);
			} catch (error) {
				this.log(
					`run ${runId}: checkpoint answer not delivered: ${messageOf(error)}`,
				);
			}
			// The answer resets the baseline: the hard limit moves ahead and the
			// no-progress counter starts again, or the same digest escalates at once.
			state.accumulator.rearmAfterEscalation();
			this.emitCheckpointEscalation(context, digest, rule, summary);
			return;
		}
		// The question exists and was not answered in the grace window: now, and
		// only now, the run stops and the developer is left with the question — and
		// only while this evaluation still owns the run, because a run that was
		// stopped or re-issued meanwhile is not this question's to stop.
		if (stopped()) {
			// The run is no longer this evaluation's to stop, but the question exists:
			// its fate is still published (once), just without the park.
			this.emitCheckpointEscalation(context, digest, rule, summary);
			return;
		}
		const park = summary.outcome === "pending-parked";
		this.emitCheckpointEscalation(context, digest, rule, summary);
		await this.parkForCheckpoint(
			runId,
			park
				? `progress checkpoint: the developer question ${summary.questionId} is still unanswered; the run is stopped and is re-issued when it is answered`
				: `progress checkpoint: developer question ${summary.questionId} was cancelled, so the run is stopped`,
		);
	}

	/** Publish a filed question's fate exactly once, for an evaluation that was
	 * superseded after the question was filed: the dataset must never hold a
	 * developer question whose outcome is missing. A filing failure has no
	 * question to report, and is stated as the escalation's error instead. */
	private emitFiledFate(
		context: DurableRunContext,
		digest: CheckpointDigest,
		rule: CheckpointRuleId,
		filed: CheckpointEscalationFiling,
	): void {
		const { summary, reply } = filed;
		this.emitCheckpointEscalation(
			context,
			digest,
			rule,
			summary.outcome === "filing-failed"
				? {
						...summary,
						errorClass: "question",
						...(reply.reason === undefined ? {} : { reason: reply.reason }),
					}
				: summary,
		);
	}

	/** Publish one escalation's outcome. `outcome` is one of the four the dataset
	 * counts, so the attribute is a closed vocabulary, and a question that could
	 * not be filed is marked `status: "error"` with its bounded error class —
	 * this envelope, not a second decision envelope, is the checkpoint's
	 * fail-open record for that attempt. */
	private emitCheckpointEscalation(
		context: DurableRunContext,
		digest: CheckpointDigest,
		rule: CheckpointRuleId,
		fields: CheckpointEscalationSummary & {
			/** Set only when the question could not be filed: the escalation is
			 * then the checkpoint's fail-open record for that attempt. */
			readonly errorClass?: string;
			readonly reason?: string;
		},
	): void {
		emitToolTelemetry(context.env, "runtime.checkpoint_escalation", {
			"herdr.checkpoint.ordinal": digest.ordinal,
			"herdr.checkpoint.class": digest.checkpointClass,
			"herdr.checkpoint.rule": rule,
			"herdr.checkpoint.turns": digest.turns,
			"herdr.checkpoint.outcome": fields.outcome,
			"herdr.checkpoint.status":
				fields.errorClass === undefined ? "ok" : "error",
			...(fields.errorClass === undefined
				? {}
				: { "herdr.checkpoint.error_class": fields.errorClass }),
			...(fields.questionId === undefined
				? {}
				: { "herdr.checkpoint.question_id": fields.questionId }),
			...(fields.reason === undefined
				? {}
				: { "herdr.checkpoint.reason": fields.reason }),
		});
	}

	/** Stop the run because its own recorded question is unanswered. Mirrors the
	 * fail-fast stop: abort the conversation, then record the `blocked` handoff
	 * that tells the developer what the run is waiting for. */
	private async parkForCheckpoint(
		runId: string,
		message: string,
	): Promise<void> {
		const record = this.runs.get(runId);
		const context = this.runContexts.get(runId);
		if (!record || !context) return;
		if (this.boundRunId(record.conversationId) !== runId) return;
		await this.serialized(record, async () => {
			// The run may have handed off on its own while the question waited: then
			// there is nothing left to stop, and no handoff to overwrite.
			if (this.boundRunId(record.conversationId) !== runId) return;
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			await conversation?.abort(BACKGROUND_CONTEXT);
			try {
				await recordCheckpointRunHandoff(context, message);
			} catch (error) {
				this.log(
					`run ${runId}: checkpoint handoff not recorded: ${messageOf(error)}`,
				);
			}
		});
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

	/** Test-only: run the host's own apply step for one decision, so a fail-open
	 * path a scripted run cannot produce — a submission the harness refuses
	 * because the run is already gone — is still asserted where it is
	 * implemented. `runGone` drops the run record first, which is exactly the
	 * race the paths guard against. Not part of the control protocol. */
	async applyCheckpointForTest(
		runId: string,
		decision: CheckpointDecision,
		options: {
			readonly runGone?: boolean;
			/** The digest fields the scenario is about, when the accumulator's own
			 * preview cannot state them (its context is the last measured turn, and
			 * only a measured context can be admissible). */
			readonly digest?: Partial<CheckpointDigest>;
		} = {},
	): Promise<CheckpointApplied> {
		const state = this.checkpoints.get(runId);
		if (!state) return { applied: false };
		if (options.runGone) this.runs.delete(runId);
		return await this.applyCheckpointDecision(
			runId,
			{ ...state.accumulator.digestPreview(), ...options.digest },
			decision,
		);
	}

	/** Test-only: publish one checkpoint's envelope for a decision whose action
	 * was applied out of band, so the two post-decision fail-open classes
	 * (`steer`, `compact`) are asserted where they are emitted. The digest is the
	 * accumulator's own preview; nothing is recorded and nothing is stopped. Not
	 * part of the control protocol. */
	/** The checkpoint ordinal this run id owns: the live accumulator's when it is
	 * installed, the remembered high-water mark when the run was stopped. A
	 * re-issued run id must answer a number that is not `0` again. */
	checkpointOrdinalForTest(runId: string): number {
		return (
			this.checkpoints.get(runId)?.accumulator.checkpoints ??
			this.checkpointOrdinals.get(runId) ??
			0
		);
	}

	emitCheckpointForTest(
		runId: string,
		applied: CheckpointApplied,
		options: {
			readonly decision?: CheckpointDecision;
			readonly recording?: CheckpointRecording;
		} = {},
	): boolean {
		const context = this.runContexts.get(runId);
		const state = this.checkpoints.get(runId);
		if (!context || !state) return false;
		this.emitCheckpoint(
			context,
			state.accumulator.digestPreview(),
			options.decision ?? {
				action: "steer",
				rule: "no-progress",
				signal: "no-progress",
			},
			applied,
			options.recording ?? { recorded: true, failed: false },
			{ startedAt: Date.now() },
		);
		return true;
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

	async submit(
		runId: string,
		text: string,
		requestId: string,
		whenBusy = "followUp",
	): Promise<{
		submissionId: string;
		workflowState?: SubmitWorkflowState;
		workflowNote?: string;
	}> {
		const record = this.requireConversation(runId);
		// The mode is normalized, never rejected: `steer`/`overwrite` interrupt
		// the running turn, everything else queues behind it, and an idle
		// conversation starts the next turn either way (normalizeSubmitMode).
		const mode = normalizeSubmitMode(whenBusy);
		return this.serialized(record, async () => {
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

	async status(
		runId: string,
	): Promise<{ status: RunStatus; lastError?: string }> {
		const record = this.runs.get(runId);
		if (!record) return { status: "unknown" };
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) return { status: "unknown" };
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		try {
			const live = state.value.docs["pi.live"] as
				| { run?: unknown; tools?: Array<{ name: string; status: string }> }
				| undefined;
			const inbox = state.value.docs["pi.inbox"] as
				| { items?: unknown[] }
				| undefined;
			if (!live?.run) {
				if (inbox?.items?.length) return { status: "working" };
				return { status: "idle" };
			}
			const blockedOnQuestion = (live.tools ?? []).some(
				(slot) =>
					slot.status === "running" &&
					(slot.name === "developer_question" || slot.name === "agent_ask"),
			);
			return { status: blockedOnQuestion ? "blocked" : "working" };
		} finally {
			state.dispose();
		}
	}

	/** Apply a live model / thinking override to one run's conversation
	 * (dashboard \`/model\` and \`/thinking\`). The change lands in \`pi.agent\`, so the
	 * next generation uses it and every watcher sees it. */
	async configureRun(
		runId: string,
		change: { model?: string; thinking?: string },
	): Promise<void> {
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
		// Track the model this run now uses, so a percentage threshold resolves
		// against the smallest window actually in play (design D3).
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
		// The checkpoint sees every finished call, whatever its monitor decided: a
		// failing streak is one of its stall signals, and a successful `edit` is its
		// clearest progress event.
		this.observeCheckpointTool(runId, observation);
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

	async stopRun(runId: string): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		this.abortedRuns.delete(runId);
		this.reconciledRuns.delete(runId);
		// The checkpoint belongs to this run alone, so it is dropped with it rather
		// than with the conversation the run happened to hold. Its ordinal survives
		// as a high-water mark: a re-issued run id must not re-issue a question id
		// that already names a stored decision.
		const checkpoint = this.checkpoints.get(runId);
		if (checkpoint) this.rememberCheckpointOrdinal(runId, checkpoint);
		this.checkpoints.delete(runId);
		this.invalidateCheckpointEval(runId);
		// A missing entry already reads as a mismatched token, so the run's slot goes
		// with the run instead of being retained for the life of the process.
		this.checkpointEvals.delete(runId);
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
				this.checkpointPending.delete(record.conversationId);
				// Only this conversation's compaction attribution dies with it.
				this.checkpointCompactions.delete(record.conversationId);
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
	): Promise<() => void> {
		// A host that restarted no longer tracks the runs it served before, and the
		// run id lives only in that in-memory map. The conversation is durable, so a
		// watcher that still holds it keeps reading the transcript the run wrote;
		// mutations keep refusing an unknown run id (they resolve runs, never
		// conversations).
		const record = this.runs.get(runId);
		const conversationId = record
			? record.conversationId
			: parseConversationId(recoveredConversationId);
		if (conversationId === undefined) throw new Error(`unknown run: ${runId}`);
		const conversation = await this.harness.conversation(
			conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		// The measured timings travel with the conversation view, the only place
		// the dashboard can read them (pi-durable stores no timing itself). A
		// docs-only watcher reads the live documents and nothing else, so the
		// committed transcript never crosses the socket for it.
		const augment = (value: unknown) => {
			const record = value as Record<string, unknown> | undefined;
			if (view === "docs") return { docs: record?.docs ?? {} };
			return {
				...(record ?? {}),
				timings: this.timings.get(conversationId) ?? {},
			};
		};
		onValue(augment(state.value));
		// Coalesce what follows: a generating model changes this state at token
		// rate, and every frame crosses the socket and rebuilds the watcher's whole
		// transcript. The initial frame above is delivered directly, because a
		// watcher's handshake resolves on it.
		const frames = createFrameThrottle<unknown>({
			windowMs: STATE_FRAME_COALESCE_MS,
			deliver: (value) => onValue(value),
		});
		const unsubscribe = state.subscribe((value) => frames.push(augment(value)));
		return () => {
			unsubscribe();
			frames.dispose();
			state.dispose();
		};
	}

	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.server?.close();
		for (const stop of this.telemetry.values()) {
			try {
				stop();
			} catch {
				/* best-effort teardown */
			}
		}
		this.toolSurfaces.clear();
		this.toolProbes.clear();
		for (const runId of [...this.runs.keys()]) {
			try {
				await this.stopConversation(runId, false);
			} catch {
				/* best-effort drain before close */
			}
		}
		await this.harness.close(BACKGROUND_CONTEXT);
		try {
			fs.rmSync(this.options.layout.socketPath, { force: true });
			fs.rmSync(this.options.layout.lockPath, { force: true });
		} catch {
			/* best-effort cleanup */
		}
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
		fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
		const server = net.createServer((socket) => this.handleConnection(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				try {
					fs.chmodSync(socketPath, 0o600);
				} catch {
					/* best-effort permission tightening */
				}
				resolve();
			});
		});
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
				void this.handleRequest(
					decoded.value as HostRequest,
					send,
					socket,
					cleanups,
				);
			}
		});
		socket.on("close", () => {
			for (const cleanup of cleanups) cleanup();
			this.watchers.delete(socket);
		});
		socket.on("error", () => {
			for (const cleanup of cleanups) cleanup();
		});
	}

	private async handleRequest(
		request: HostRequest,
		send: (response: HostResponse) => void,
		_socket: net.Socket,
		cleanups: Set<() => void>,
	): Promise<void> {
		try {
			switch (request.type) {
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
				case "ensureRun": {
					const result = await this.ensureRun({
						runId: request.runId,
						name: request.name,
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
					);
					cleanups.add(stop);
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
			const code = message.startsWith("unknown run")
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

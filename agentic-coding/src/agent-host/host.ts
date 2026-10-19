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
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	COMPACTION_MAX_INSTRUCTIONS,
	type CompactionCeiling,
	type CompactionConfig,
	type CompactionPolicy,
	evaluateCompactionCeiling,
	resolveCompactionCeiling,
	resolveCompactionPolicy,
} from "../workflow/compaction.ts";
import { globalPiTools, piSettingsPath } from "../workflow/pi-tools.ts";
import { boundedCodingTools } from "./bash-tool.ts";
import { createBrowserExtension } from "./browser-tools.ts";
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
	type ToolSurfaceMonitor,
	toolSurfaceMonitorFor,
} from "./fail-fast.ts";
import { createFrameThrottle } from "./frame-throttle.ts";
import type { HostLayout } from "./layout.ts";
import { createOrchestratorExtension } from "./orchestrator.ts";
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
	emitToolTelemetry,
	type TelemetryIdentity,
	type ToolOutcomeObservation,
} from "./telemetry.ts";
import { suggestingCodingTools } from "./tool-suggestions.ts";
import {
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
	) {}

	/** The workflow-run extensions: dialogue tools, `ask_jev`, `grep`, the
	 * environment tools, and the workflow system prompt. Never installed in
	 * orchestrator mode. */
	private static installWorkflowExtensions(
		registry: ReturnType<typeof createRegistry>,
		lookup: RunContextLookup,
		options: DurableHostOptions,
		codemodeRegistered: boolean,
	): {
		readonly readOnlyTools: readonly ToolRegistration[];
		readonly workflowTools: readonly ToolRegistration[];
	} {
		const dialogue = createWorkflowDialogueExtension(lookup);
		registry.install(dialogue);
		const jev = createAskJevExtension(lookup);
		registry.install(jev);
		const search = createSearchExtension({ codemodeRegistered });
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
		const codemodeRegistered =
			!options.orchestrator &&
			globalPiTools(piSettingsPath(options.globalAgentDir)).some(
				(tool) => tool.tool === "codemode",
			);
		// pi-durable's coding tools with the bounded `bash` in place of its own
		// (bash-tool.ts): every runtime this host serves gets the same default
		// wall-clock bound, whoever selects the tool by name.
		registry.install(boundedCodingTools({ codemodeRegistered }));
		// …and `read`/`edit` with the self-correcting failure hints
		// (tool-suggestions.ts). Installed after the coding tools so its
		// registration of each of those names is the one a run selects; a
		// suggestion-only failure never replaces the tool's own error text.
		registry.install(suggestingCodingTools({ codemodeRegistered }));
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
					codemodeRegistered,
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
			...(readJevBinding(envVars) ? { jev: readJevBinding(envVars) } : {}),
		};
		this.contexts.set(conversation.id, runContext);
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
		if (!this.telemetry.has(conversation.id)) {
			const conversationId = conversation.id;
			// The dead-surface monitor of this run, or none for a session the rule
			// leaves alone (no run id, or an exempt role such as `env-setup`).
			const monitor = toolSurfaceMonitorFor(envVars);
			try {
				const stop = await attachTelemetry(
					this.harness,
					conversationId,
					context,
					identity,
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
						// is decided between turns, never inside a tool call.
						onMeasuredContext: ({ promptTokens, turnIndex }) =>
							this.observeContext(input.runId, promptTokens, turnIndex),
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
						// The dead-surface rule observes every finished tool call of a run
						// the rule applies to.
						...(monitor
							? {
									onToolOutcome: (observation: ToolOutcomeObservation) =>
										this.onToolOutcome(
											input.runId,
											conversationId,
											observation,
										),
								}
							: {}),
					},
				);
				this.telemetry.set(conversationId, stop);
				if (monitor) this.toolSurfaces.set(conversationId, monitor);
			} catch {
				/* telemetry is observational only; a failed attach never fails the run */
			}
		}
		this.log(`ensureRun ${input.runId} -> conversation ${conversation.id}`);
		return { conversationId: String(conversation.id) };
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
			const reconciled = await this.reconcileRunState(runId, record);
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
			const submission = await conversation.submit(
				{ type: "input", content: text, requestId, whenBusy: mode },
				BACKGROUND_CONTEXT,
			);
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
		record: RunRecord,
	): Promise<ResumedRunState | undefined> {
		if (!this.abortedRuns.has(runId) && this.reconciledRuns.has(runId))
			return undefined;
		const context = this.contexts.get(record.conversationId);
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
		const context = this.contexts.get(conversationId);
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
		this.toolSurfaces.delete(conversationId);
		this.toolProbes.delete(conversationId);
		await this.serialized(record, async () => {
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			await conversation?.abort(BACKGROUND_CONTEXT);
			const context = this.contexts.get(record.conversationId);
			if (!context) return;
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
		const context = this.contexts.get(tracked.conversationId);
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
		this.toolSurfaces.delete(record.conversationId);
		this.toolProbes.delete(record.conversationId);
		await this.serialized(record, async () => {
			const conversation = await this.harness.conversation(
				record.conversationId,
				BACKGROUND_CONTEXT,
			);
			await conversation?.abort(BACKGROUND_CONTEXT);
			this.runs.delete(runId);
			this.contexts.delete(record.conversationId);
			this.timings.delete(record.conversationId);
			// The ceiling's bookkeeping is per conversation and dies with it.
			this.ceilings.delete(record.conversationId);
			this.telemetryIdentities.delete(record.conversationId);
			this.ceilingPending.delete(record.conversationId);
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

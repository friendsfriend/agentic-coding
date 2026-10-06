import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, MutableModels, Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Storage } from "@earendil-works/pi-durable";
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
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { globalPiTools, piSettingsPath } from "../workflow/pi-tools.ts";
import { createDurableCodemode } from "./codemode.ts";
import { configuredProviderIds } from "./configured-models.ts";
import { PiAuthCredentialStore } from "./credentials.ts";
import type { HostLayout } from "./layout.ts";
import { createOrchestratorExtension } from "./orchestrator.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	type HostResponse,
	PROTOCOL_VERSION,
	type RunStatus,
	type ToolPolicy,
} from "./protocol.ts";
import type { AgentHostSettings } from "./settings.ts";
import { attachTelemetry, type EntryTiming } from "./telemetry.ts";
import {
	codingTools,
	createAskJevExtension,
	createPromptExtension,
	createWorkflowDialogueExtension,
	type DurableRunContext,
	type RunContextLookup,
} from "./tools.ts";

// pi-ai's default OAuth loaders hide imports from bundlers. Embed/register all
// flows here so compiled hosts can derive auth and refresh without node_modules.
registerBunOAuthFlows();

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

interface RunRecord {
	conversationId: ConversationId;
	readOnly: boolean;
}

export interface DurableHostOptions {
	readonly layout: HostLayout;
	readonly settings: AgentHostSettings;
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
}

/** One open durable harness plus its control socket. Owns exactly the state
 * `durable-agent-host` assigns a host: run bookkeeping, the socket server,
 * and the harness/storage lifecycle. */
export class DurableHost {
	private readonly runs = new Map<string, RunRecord>();
	private readonly contexts = new Map<ConversationId, DurableRunContext>();
	private readonly telemetry = new Map<ConversationId, () => void>();
	/** Measured wall-clock timing per committed assistant entry, keyed by
	 * conversation then entry id. In-memory: a host restart loses it. */
	private readonly timings = new Map<
		ConversationId,
		Record<string, EntryTiming>
	>();
	private readonly watchers = new Map<net.Socket, Set<() => void>>();
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
		/** The orchestrator extension, present only in orchestrator mode. */
		private readonly orchestratorExtension: Extension | undefined,
	) {}

	/** The workflow-run extensions: dialogue tools, `ask_jev`, and the
	 * workflow system prompt. Never installed in orchestrator mode. */
	private static installWorkflowExtensions(
		registry: ReturnType<typeof createRegistry>,
		lookup: RunContextLookup,
		options: DurableHostOptions,
	): void {
		registry.install(createWorkflowDialogueExtension(lookup));
		registry.install(createAskJevExtension(lookup));
		registry.install(createPromptExtension(options.globalAgentDir));
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
		registry.install(CodingTools);
		const lookup = (conversationId: ConversationId) =>
			host.instance?.contexts.get(conversationId);
		const orchestrator = options.orchestrator
			? createOrchestratorExtension(lookup)
			: undefined;
		if (orchestrator) registry.install(orchestrator);
		else DurableHost.installWorkflowExtensions(registry, lookup, options);
		// A durable run gets codemode only when the user's own global pi settings
		// enable it, matching what a managed pane session inherits. It is an
		// additional tool: the run keeps its direct tools either way. The
		// orchestrator never gets it: its tool surface is exactly its own.
		const codemode =
			!orchestrator &&
			globalPiTools(piSettingsPath(options.globalAgentDir)).some(
				(tool) => tool.tool === "codemode",
			)
				? createDurableCodemode()
				: undefined;
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
		const harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: {
					...(options.settings.compaction
						? { compaction: options.settings.compaction }
						: {}),
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
			orchestrator,
		);
		host.instance = instance;
		return instance;
	}

	async ensureRun(input: EnsureRunInput): Promise<{ conversationId: string }> {
		const context = BACKGROUND_CONTEXT;
		const key = input.name;
		const map = await this.harness.snapshot(RunMapDoc, context);
		const existingId = map?.runs[key]?.conversationId;
		let conversation: Conversation | undefined = existingId
			? await this.harness.conversation(existingId as ConversationId, context)
			: undefined;
		const readOnly = input.toolPolicy === "read-only";
		const toolSelection = this.toolSelectionFor(input.toolPolicy);
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
		let envVars: Record<string, string> = {};
		try {
			envVars = parseRunEnvFile(fs.readFileSync(input.runEnvPath, "utf8"));
		} catch {
			/* a run without a readable run.env still launches, with an empty environment */
		}
		const runContext: DurableRunContext = {
			runId: input.runId,
			cwd: input.cwd,
			env: envVars,
			...(readJevBinding(envVars) ? { jev: readJevBinding(envVars) } : {}),
		};
		this.contexts.set(conversation.id, runContext);
		this.runs.set(input.runId, { conversationId: conversation.id, readOnly });
		if (!this.telemetry.has(conversation.id)) {
			try {
				const stop = await attachTelemetry(
					this.harness,
					conversation.id,
					context,
					{
						workflowId: envVars.HERDR_WORKFLOW_ID,
						runId: envVars.HERDR_RUN_ID,
						stepId: envVars.HERDR_STEP_ID,
						role: envVars.HERDR_ROLE,
						profile: envVars.HERDR_PROFILE,
						telemetryPath: envVars.HERDR_TELEMETRY_PATH,
						captureContent: envVars.HERDR_CAPTURE_CONTENT === "1",
					},
					(entryId, timing) => {
						const existing = this.timings.get(conversation.id) ?? {};
						this.timings.set(conversation.id, {
							...existing,
							[entryId]: timing,
						});
					},
				);
				this.telemetry.set(conversation.id, stop);
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
	private toolSelectionFor(policy: ToolPolicy) {
		if (this.orchestratorExtension) {
			if (policy !== "orchestrator")
				throw new Error("this host only serves the orchestrator session");
			return [
				...(CodingTools.tools ?? []).filter((tool) => tool.name === "read"),
				...(this.orchestratorExtension.tools ?? []),
			];
		}
		if (policy === "orchestrator")
			throw new Error("the orchestrator policy needs an orchestrator host");
		return policy === "read-only" ? this.readOnlyToolSelection() : undefined;
	}

	private readOnlyToolSelection() {
		// codemode stays offered to a read-only run (its script can only reach the
		// tools this selection names, so `write`/`edit` remain unreachable).
		return [
			...codingTools(true),
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

	private requireConversation(runId: string): RunRecord {
		const found = this.runs.get(runId);
		if (!found) throw new Error(`unknown run: ${runId}`);
		return found;
	}

	async submit(
		runId: string,
		text: string,
		requestId: string,
		whenBusy: "steer" | "followUp" = "followUp",
	): Promise<{ submissionId: string }> {
		const record = this.requireConversation(runId);
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		const submission = await conversation.submit(
			{ type: "input", content: text, requestId, whenBusy },
			BACKGROUND_CONTEXT,
		);
		return { submissionId: String(submission.id) };
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
		const record = this.runs.get(runId);
		if (!record) return;
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		await conversation?.abort(BACKGROUND_CONTEXT);
	}

	async stopRun(runId: string): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		await conversation?.abort(BACKGROUND_CONTEXT);
		this.runs.delete(runId);
		this.contexts.delete(record.conversationId);
		this.timings.delete(record.conversationId);
	}

	async watchRun(
		runId: string,
		onValue: (value: unknown) => void,
	): Promise<() => void> {
		const record = this.runs.get(runId);
		if (!record) throw new Error(`unknown run: ${runId}`);
		const conversation = await this.harness.conversation(
			record.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (!conversation) throw new Error(`conversation gone for run: ${runId}`);
		const state = await conversation.viewState(BACKGROUND_CONTEXT);
		// The measured timings travel with the conversation view, the only place
		// the dashboard can read them (pi-durable stores no timing itself).
		const augment = (value: unknown) => ({
			...(value as Record<string, unknown>),
			timings: this.timings.get(record.conversationId) ?? {},
		});
		onValue(augment(state.value));
		const unsubscribe = state.subscribe((value) => onValue(augment(value)));
		return () => {
			unsubscribe();
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
		for (const runId of [...this.runs.keys()]) {
			try {
				await this.abort(runId);
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
					const stop = await this.watchRun(request.runId, (value) => {
						send({ type: "watchFrame", runId: request.runId, value });
					});
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
			const code =
				error instanceof Error && error.message.startsWith("unknown run")
					? "unknown-run"
					: "internal";
			send({
				type: "error",
				code,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function parseModelRef(model: string): { provider: string; modelId: string } {
	const [provider, ...rest] = model.split("/");
	return { provider: provider ?? model, modelId: rest.join("/") || model };
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

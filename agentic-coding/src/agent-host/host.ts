import fs from "node:fs";
import net from "node:net";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Storage } from "@earendil-works/pi-durable";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	defineDoc,
	Harness,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiAuthCredentialStore } from "./credentials.ts";
import type { HostLayout } from "./layout.ts";
import {
	decodeFrame,
	encodeFrame,
	FrameReader,
	type HostRequest,
	type HostResponse,
	PROTOCOL_VERSION,
	type RunStatus,
} from "./protocol.ts";
import type { AgentHostSettings } from "./settings.ts";
import { attachTelemetry } from "./telemetry.ts";
import {
	codingTools,
	createAskJevExtension,
	createPromptExtension,
	createWorkflowDialogueExtension,
	type DurableRunContext,
} from "./tools.ts";

interface RunMapState extends JsonObject {
	runs: Record<string, { conversationId: number }>;
}
const RunMapDoc = defineDoc<RunMapState>({
	kind: "agentic.runs",
	version: 1,
	scope: "session",
	initial: () => ({ runs: {} }),
});

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
	readonly toolPolicy: "default" | "read-only";
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
	private readonly watchers = new Map<net.Socket, Set<() => void>>();
	private server: net.Server | undefined;
	private closing = false;

	private constructor(
		private readonly harness: Harness,
		private readonly options: DurableHostOptions,
	) {}

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
		registry.install(
			createWorkflowDialogueExtension((conversationId) =>
				host.instance?.contexts.get(conversationId),
			),
		);
		registry.install(
			createAskJevExtension((conversationId) =>
				host.instance?.contexts.get(conversationId),
			),
		);
		registry.install(createPromptExtension(options.globalAgentDir));
		const models =
			options.models ??
			builtinModels({
				credentials: new PiAuthCredentialStore(
					options.credentialsPath,
				) as never,
			});
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
		const instance = new DurableHost(harness, options);
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
		const toolSelection = readOnly ? this.readOnlyToolSelection() : undefined;
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
				);
				this.telemetry.set(conversation.id, stop);
			} catch {
				/* telemetry is observational only; a failed attach never fails the run */
			}
		}
		this.log(`ensureRun ${input.runId} -> conversation ${conversation.id}`);
		return { conversationId: String(conversation.id) };
	}

	private readOnlyToolSelection() {
		return [...codingTools(true)];
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
		onValue(state.value);
		const unsubscribe = state.subscribe((value) => onValue(value));
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

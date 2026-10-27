import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import type {
	AgentTool,
	AgentToolCallOutcome,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
	defineTool,
	type Registry,
	type ToolExecutionApi,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { ToolPolicy } from "./protocol.ts";
import type { LocalPiToolsSettings } from "./settings.ts";
import type { DurableRunContext } from "./tools.ts";

type JsonObject = { [key: string]: JsonValue };

const EXTENSION_NAME = "agentic.local-pi-tools";
const MCP_EXTENSION_NAME = "agentic-coding-local-mcp";
const MCP_EXTENSION_PATH = `<inline:${MCP_EXTENSION_NAME}>`;
const MAX_TOOLS_PER_CONVERSATION = 256;
const MAX_BRIDGE_OWNERS = 32;
const MAX_CONTENT_ITEMS = 256;
const MAX_CONTAINER_ENTRIES = 256;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_DETAILS_BYTES = 24 * 1024;
const MAX_NESTED_CALLS = 64;
const MAX_NESTED_DEPTH = 8;
const MAX_PROGRESS_UPDATES = 32;
const MAX_PROGRESS_TEXT = 16_000;
const MCP_STARTUP_WAIT_MS = 5_000;
const allowedLifecycleHooks = new Set(["session_start", "session_shutdown"]);
const unsupportedContextMembers = new Set([
	"abort",
	"compact",
	"getContextUsage",
	"getSystemPrompt",
	"hasPendingMessages",
	"isIdle",
	"model",
	"modelRegistry",
	"scopedModels",
	"sessionManager",
	"shutdown",
	"thinkingLevel",
]);

type PiExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

interface PiToolDefinition {
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly parameters: ToolRegistration["parameters"];
	readonly outputSchema?: ToolRegistration["parameters"];
	readonly prepareArguments?: (args: unknown) => unknown;
	readonly exposure?: PiExposure;
	readonly defaultActive?: boolean;
	readonly namespace?: { readonly name?: string };
	readonly reachesTools?: unknown;
	readonly prepareLoadout?: unknown;
	readonly renderShell?: unknown;
	readonly renderCall?: unknown;
	readonly renderResult?: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
		ctx: unknown,
	) => Promise<AgentToolResult<unknown>>;
}

interface PiSourceInfo {
	readonly path?: string;
	readonly source?: string;
	readonly scope?: string;
	readonly origin?: string;
}

interface PiRegisteredTool {
	readonly definition: PiToolDefinition;
	readonly sourceInfo: PiSourceInfo;
}

interface LoadedExtension {
	readonly path: string;
	readonly sourceInfo?: PiSourceInfo;
	readonly handlers?:
		| ReadonlyMap<string, unknown>
		| Readonly<Record<string, unknown>>;
	readonly commands?: unknown;
	readonly flags?: unknown;
	readonly shortcuts?: unknown;
	readonly messageRenderers?: unknown;
	readonly entryRenderers?: unknown;
	readonly markdownTransformer?: unknown;
	readonly toolRenderers?: unknown;
}

interface LoadedExtensionsResult {
	readonly extensions: readonly LoadedExtension[];
	readonly errors?: readonly { readonly path?: string }[];
	runtime: {
		readonly mcpServers: {
			list(): readonly {
				readonly name: string;
				readonly extensionPath: string;
			}[];
			unregister(name: string, extensionPath: string): void;
		};
		pendingProviderRegistrations: { readonly extensionPath: string }[];
		pendingNativeProviderRegistrations: { readonly extensionPath: string }[];
		pendingVirtualModelRegistrations: { readonly extensionPath: string }[];
	};
}

interface OwnerTool {
	readonly name: string;
	readonly sourceId: string;
	readonly definition: PiToolDefinition;
}

interface BridgeOwner {
	readonly conversationId: ConversationId;
	readonly cwd: string;
	readonly session: import("@earendil-works/pi-coding-agent").AgentSession;
	readonly tools: Map<string, OwnerTool>;
	readonly activeControllers: Set<AbortController>;
	readonly activeCalls: Set<Promise<unknown>>;
	readonly staticToolsByPath: Map<string, Set<string>>;
	lastUsedAt: number;
	closing: boolean;
}

interface BridgeRegistration {
	readonly fingerprint: string;
	readonly registration: ToolRegistration;
	readonly sourceId: string;
}

type StartupFailureClass =
	| "user-config-load-failed"
	| "pi-session-create-failed"
	| "extension-bind-failed"
	| "mcp-startup-failed"
	| "tool-catalog-refresh-failed";

class BridgeStartupFailure extends Error {
	constructor(readonly failureClass: StartupFailureClass) {
		super(failureClass);
		this.name = "BridgeStartupFailure";
	}
}

function startupRecoveryHint(failureClass: StartupFailureClass): string {
	switch (failureClass) {
		case "user-config-load-failed":
			return "check user-level Pi extension and MCP settings";
		case "pi-session-create-failed":
			return "check Pi user-level settings and extension compatibility";
		case "extension-bind-failed":
			return "disable incompatible user-level extensions and retry";
		case "mcp-startup-failed":
			return "check user-level MCP settings or sign in through Pi";
		case "tool-catalog-refresh-failed":
			return "check user-level Pi tool configuration";
	}
}

function mcpNotificationClass(message: unknown): {
	failureClass: string;
	recoveryHint: string;
} {
	const text = typeof message === "string" ? message.slice(0, 512) : "";
	if (/auth|sign[\s_-]?in|login|credential/i.test(text))
		return {
			failureClass: "sign-in-required-use-pi-login",
			recoveryHint: "sign in through Pi, then retry the durable run",
		};
	if (/invalid|malformed|unsupported|config|parse/i.test(text))
		return {
			failureClass: "mcp-configuration-invalid",
			recoveryHint: "check user-level Pi MCP settings",
		};
	if (/unavailable|connect|timeout|failed|error/i.test(text))
		return {
			failureClass: "mcp-server-unavailable",
			recoveryHint: "check the user-level MCP server and retry",
		};
	return {
		failureClass: "extension-notification",
		recoveryHint: "check user-level Pi extension or MCP settings",
	};
}

export interface LocalPiToolBridgeOptions {
	readonly registry: Registry;
	readonly settings: LocalPiToolsSettings;
	readonly globalAgentDir: string;
	readonly contextFor: (
		conversationId: ConversationId,
	) => DurableRunContext | undefined;
	readonly log: (diagnostic: string) => void;
}

/**
 * A user-level Pi extension/MCP adapter. It owns one in-memory Pi session per
 * durable conversation, but its exported tools execute only through the
 * conversation's current durable ToolExecutionApi and policy selection.
 */
export class LocalPiToolBridge {
	private readonly owners = new Map<ConversationId, BridgeOwner>();
	private readonly registrations = new Map<string, BridgeRegistration>();
	private readonly conflictingNames = new Set<string>();
	private readonly reported = new Set<string>();
	private readonly tools: ToolRegistration[] = [];
	private readonly settings: LocalPiToolsSettings;
	private pendingOwnerCreations = 0;
	private readonly ownerCreationWaiters = new Set<() => void>();
	private closed = false;

	constructor(private readonly options: LocalPiToolBridgeOptions) {
		this.settings = options.settings;
		this.publishRegistry();
	}

	isBridgeToolName(name: string): boolean {
		return this.registrations.has(name);
	}

	toolsForPolicy(
		conversationId: ConversationId,
		policy: ToolPolicy,
	): readonly ToolRegistration[] {
		const owner = this.owners.get(conversationId);
		if (!owner || owner.closing) return [];
		owner.lastUsedAt = Date.now();
		const allow =
			policy === "read-only"
				? this.settings.restrictedAllow.readOnly
				: undefined;
		const names = new Set(owner.tools.keys());
		return [...names]
			.filter((name) => {
				if (this.conflictingNames.has(name)) return false;
				return allow
					? allow.includes(name)
					: policy === "default" || policy === "orchestrator";
			})
			.flatMap((name) => {
				const registration = this.registrations.get(name)?.registration;
				return registration ? [registration] : [];
			});
	}

	async ensureConversation(
		conversationId: ConversationId,
		cwd: string,
	): Promise<void> {
		if (this.closed) return;
		const canonicalCwd = path.resolve(cwd);
		const existing = this.owners.get(conversationId);
		if (existing?.cwd === canonicalCwd && !existing.closing) {
			existing.lastUsedAt = Date.now();
			try {
				await this.refreshOwnerTools(existing);
			} catch {
				this.report(
					"bridge",
					"tool-catalog-refresh-failed",
					startupRecoveryHint("tool-catalog-refresh-failed"),
				);
				await this.closeOwner(conversationId, existing);
			}
			return;
		}
		if (existing) await this.closeOwner(conversationId, existing);
		if (!(await this.reserveOwnerSlot())) return;
		let owner: BridgeOwner | undefined;
		try {
			owner = await this.createOwner(conversationId, canonicalCwd);
			if (this.closed) {
				await this.closeOwner(conversationId, owner);
				return;
			}
			this.owners.set(conversationId, owner);
			try {
				await this.refreshOwnerTools(owner);
			} catch {
				throw new BridgeStartupFailure("tool-catalog-refresh-failed");
			}
		} catch (error) {
			if (owner) await this.closeOwner(conversationId, owner);
			const failureClass =
				error instanceof BridgeStartupFailure
					? error.failureClass
					: "pi-session-create-failed";
			this.report("bridge", failureClass, startupRecoveryHint(failureClass));
		} finally {
			this.pendingOwnerCreations -= 1;
			if (this.pendingOwnerCreations === 0) {
				for (const resolve of this.ownerCreationWaiters) resolve();
				this.ownerCreationWaiters.clear();
			}
		}
	}

	private async reserveOwnerSlot(): Promise<boolean> {
		if (this.closed) return false;
		while (this.owners.size + this.pendingOwnerCreations >= MAX_BRIDGE_OWNERS) {
			const idle = [...this.owners.values()]
				.filter(
					(owner) =>
						!owner.closing &&
						owner.activeCalls.size === 0 &&
						owner.activeControllers.size === 0,
				)
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
			if (!idle) {
				this.report(
					"bridge",
					"conversation-owner-limit-reached",
					"finish active runs before starting more Pi-backed conversations",
				);
				return false;
			}
			await this.closeOwner(idle.conversationId, idle);
			if (this.closed) return false;
		}
		this.pendingOwnerCreations += 1;
		return true;
	}

	async closeAll(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.pendingOwnerCreations > 0)
			await new Promise<void>((resolve) =>
				this.ownerCreationWaiters.add(resolve),
			);
		await Promise.allSettled(
			[...this.owners.entries()].map(([conversationId, owner]) =>
				this.closeOwner(conversationId, owner),
			),
		);
		this.options.registry.uninstall({ name: EXTENSION_NAME });
	}

	private async createOwner(
		conversationId: ConversationId,
		cwd: string,
	): Promise<BridgeOwner> {
		const {
			createAgentSession,
			createMcpExtension,
			DefaultResourceLoader,
			SessionManager,
			SettingsManager,
		} = await import("@earendil-works/pi-coding-agent");
		const agentDir = path.resolve(this.options.globalAgentDir);
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		settingsManager.setProjectTrusted(false);
		const resourceLoader = new DefaultResourceLoader({
			cwd: agentDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				{
					name: MCP_EXTENSION_NAME,
					factory: createMcpExtension({
						startupWaitMs: MCP_STARTUP_WAIT_MS,
						openUrl: () => this.report("mcp", "sign-in-required-use-pi-login"),
					}),
					hidden: true,
				},
			],
		});
		try {
			await resourceLoader.reload();
		} catch {
			throw new BridgeStartupFailure("user-config-load-failed");
		}
		const loaded =
			resourceLoader.getExtensions() as unknown as LoadedExtensionsResult;
		const supported = this.filterLoadedExtensions(loaded, agentDir);
		const filteredResult = { ...loaded, extensions: supported };
		const filteredLoader = new Proxy(resourceLoader, {
			get(target, property, receiver) {
				if (property === "getExtensions") return () => filteredResult;
				const value = Reflect.get(target, property, receiver) as unknown;
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as typeof resourceLoader;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
		try {
			({ session } = await createAgentSession({
				cwd,
				agentDir,
				settingsManager,
				resourceLoader: filteredLoader,
				sessionManager: SessionManager.inMemory(cwd),
			}));
		} catch {
			throw new BridgeStartupFailure("pi-session-create-failed");
		}
		const staticToolsByPath = new Map<string, Set<string>>();
		for (const entry of session.extensionRunner.getAllRegisteredTools() as unknown as readonly PiRegisteredTool[]) {
			const sourcePath = entry.sourceInfo.path;
			if (!sourcePath) continue;
			const names = staticToolsByPath.get(sourcePath) ?? new Set<string>();
			names.add(entry.definition.name);
			staticToolsByPath.set(sourcePath, names);
		}
		const owner: BridgeOwner = {
			conversationId,
			cwd,
			session,
			tools: new Map(),
			activeControllers: new Set(),
			activeCalls: new Set(),
			staticToolsByPath,
			lastUsedAt: Date.now(),
			closing: false,
		};
		try {
			await session.bindExtensions({
				uiContext: this.safeUi(session.extensionRunner.getUIContext(), "mcp"),
				onError: () => this.report("extension", "runtime-error"),
			});
		} catch {
			await this.disposeSession(session);
			throw new BridgeStartupFailure("extension-bind-failed");
		}
		try {
			await this.waitForMcpTools(owner, agentDir);
		} catch {
			await this.disposeSession(session);
			throw new BridgeStartupFailure("mcp-startup-failed");
		}
		return owner;
	}

	private filterLoadedExtensions(
		loaded: LoadedExtensionsResult,
		agentDir: string,
	): readonly LoadedExtension[] {
		const unsupportedPaths = new Set<string>();
		const reportUnsupported = (extensionPath: string, reason: string) => {
			unsupportedPaths.add(extensionPath);
			this.report(this.extensionLabel(extensionPath), reason);
		};
		for (const extension of loaded.extensions) {
			const info = extension.sourceInfo;
			const extensionPath = info?.path ?? extension.path;
			if (this.isBridgeMcpExtension(info, extensionPath)) continue;
			if (info?.scope === "project") {
				reportUnsupported(extensionPath, "project-extension-refused");
				continue;
			}
			if (info?.source === "inline" || extensionPath.startsWith("<inline:"))
				continue;
			const hooks =
				extension.handlers instanceof Map
					? [...extension.handlers.keys()]
					: Object.keys(extension.handlers ?? {});
			const unsupportedHooks = hooks.filter(
				(hook) => !allowedLifecycleHooks.has(hook),
			);
			if (unsupportedHooks.length > 0) {
				reportUnsupported(extensionPath, "unsupported-hooks");
				continue;
			}
			if (
				this.hasEntries(extension.commands) ||
				this.hasEntries(extension.flags) ||
				this.hasEntries(extension.shortcuts) ||
				this.hasEntries(extension.messageRenderers) ||
				this.hasEntries(extension.toolRenderers) ||
				this.hasEntries(extension.entryRenderers) ||
				this.hasEntries(extension.markdownTransformer)
			) {
				reportUnsupported(extensionPath, "unsupported-extension-api");
			}
		}
		for (const server of loaded.runtime.mcpServers.list())
			reportUnsupported(server.extensionPath, "extension-mcp-registration");
		for (const collection of [
			loaded.runtime.pendingProviderRegistrations,
			loaded.runtime.pendingNativeProviderRegistrations,
			loaded.runtime.pendingVirtualModelRegistrations,
		]) {
			for (const registration of collection)
				reportUnsupported(
					registration.extensionPath,
					"extension-provider-registration",
				);
		}
		for (const server of loaded.runtime.mcpServers.list())
			loaded.runtime.mcpServers.unregister(server.name, server.extensionPath);
		loaded.runtime.pendingProviderRegistrations = [];
		loaded.runtime.pendingNativeProviderRegistrations = [];
		loaded.runtime.pendingVirtualModelRegistrations = [];
		const allowed = loaded.extensions.filter((extension) => {
			const info = extension.sourceInfo;
			const extensionPath = info?.path ?? extension.path;
			return (
				!unsupportedPaths.has(extensionPath) &&
				info?.source !== "inline" &&
				!extensionPath.startsWith("<inline:") &&
				info?.scope !== "project"
			);
		});
		for (const error of loaded.errors ?? [])
			this.report(
				this.extensionLabel(error.path ?? agentDir),
				"extension-load-failed",
			);
		return [
			...allowed,
			...loaded.extensions.filter(
				(extension) =>
					extension.sourceInfo?.source === "inline" ||
					extension.path.startsWith("<inline:"),
			),
		];
	}

	private async waitForMcpTools(
		owner: BridgeOwner,
		agentDir: string,
	): Promise<void> {
		if (!fs.existsSync(path.join(agentDir, "mcp.json"))) return;
		const deadline = Date.now() + MCP_STARTUP_WAIT_MS;
		let foundAt: number | undefined;
		while (Date.now() < deadline) {
			const found = this.registeredTools(owner).some((entry) =>
				this.isMcpTool(entry),
			);
			if (found) {
				foundAt ??= Date.now();
				if (Date.now() - foundAt >= 500) return;
			} else {
				foundAt = undefined;
			}
			await delay(100);
		}
		if (foundAt === undefined)
			this.report("mcp", "configured-tools-unavailable-at-startup");
	}

	private async refreshOwnerTools(owner: BridgeOwner): Promise<void> {
		if (owner.closing) return;
		const registered = this.registeredTools(owner);
		const next = new Map<string, OwnerTool[]>();
		const activeNames = new Set(owner.session.getActiveToolNames());
		for (const entry of registered) {
			const { definition, sourceInfo } = entry;
			const mcp = this.isMcpTool(entry);
			const sourcePath = sourceInfo.path ?? "";
			const isUserExtension =
				!mcp &&
				sourceInfo.scope !== "project" &&
				sourceInfo.source !== "inline" &&
				!sourcePath.startsWith("<inline:");
			if (!mcp && !isUserExtension) continue;
			if (
				isUserExtension &&
				!owner.staticToolsByPath.get(sourcePath)?.has(definition.name)
			) {
				this.report(this.extensionLabel(sourcePath), "dynamic-tools-disabled");
				continue;
			}
			const exposure = definition.exposure ?? "direct";
			if (exposure === "hidden") continue;
			if (
				(exposure === "direct" || exposure === "model-only") &&
				!activeNames.has(definition.name)
			)
				continue;
			const unsupportedToolApi =
				definition.prepareLoadout !== undefined ||
				(!mcp && definition.reachesTools !== undefined);
			if (unsupportedToolApi) {
				this.report(
					mcp ? "mcp" : this.extensionLabel(sourcePath),
					"unsupported-tool-api",
				);
				continue;
			}
			if (next.size >= MAX_TOOLS_PER_CONVERSATION) {
				this.report("bridge", "tool-limit-reached");
				break;
			}
			const name = mcp
				? definition.name
				: piExtensionToolName(sourcePath, definition.name);
			if (name.length === 0) continue;
			const sourceId = mcp
				? `mcp-${createHash("sha256")
						.update(definition.name.split("__")[1] ?? "server")
						.digest("hex")
						.slice(0, 8)}`
				: `extension-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 8)}`;
			const candidate: OwnerTool = { name, sourceId, definition };
			const group = next.get(name) ?? [];
			group.push(candidate);
			next.set(name, group);
		}
		owner.tools.clear();
		for (const [name, candidates] of next) {
			if (candidates.length > 1) {
				this.disableName(
					name,
					"duplicate-imported-name",
					candidates[0]?.sourceId ?? "bridge",
				);
				continue;
			}
			const candidate = candidates[0];
			if (!candidate) continue;
			const registration = this.registrationFor(candidate);
			if (!registration) continue;
			owner.tools.set(name, candidate);
		}
	}

	private registrationFor(
		candidate: OwnerTool,
	): BridgeRegistration | undefined {
		const fingerprint = this.fingerprint(candidate.definition);
		const existing = this.registrations.get(candidate.name);
		if (existing) {
			if (
				existing.fingerprint !== fingerprint ||
				existing.sourceId !== candidate.sourceId
			) {
				this.disableName(candidate.name, "duplicate-imported-name");
				return undefined;
			}
			return existing;
		}
		const existingTool = this.options.registry
			.snapshot()
			.tools()
			.find(({ tool }) => tool.name === candidate.name);
		if (existingTool) {
			this.report(candidate.sourceId, "native-tool-name-collision");
			return undefined;
		}
		const registration = this.createRegistration(candidate);
		const bridgeRegistration = {
			fingerprint,
			registration,
			sourceId: candidate.sourceId,
		};
		this.registrations.set(candidate.name, bridgeRegistration);
		this.tools.push(registration);
		this.publishRegistry();
		return bridgeRegistration;
	}

	private createRegistration(candidate: OwnerTool): ToolRegistration {
		const { definition, name } = candidate;
		const exposure = definition.exposure ?? "direct";
		const callers =
			exposure === "direct" || exposure === "deferred"
				? (["model", "tools"] as const)
				: exposure === "model-only"
					? (["model"] as const)
					: (["tools"] as const);
		const replaySafe = this.settings.replaySafe.includes(name);
		return defineTool({
			name,
			description: this.descriptionFor(candidate),
			parameters: definition.parameters,
			...(definition.outputSchema
				? { structuredOutputSchema: definition.outputSchema }
				: {}),
			...(definition.prepareArguments
				? {
						prepareArguments: (args: unknown) =>
							definition.prepareArguments?.(args) as never,
					}
				: {}),
			callers,
			...(exposure === "deferred" ? { deferred: true as const } : {}),
			replay: replaySafe ? "safe" : "unsafe",
			outputLimits: { maxBytes: MAX_RESULT_BYTES, retain: "tail" },
			execute: async (
				args: Record<string, unknown>,
				api: ToolExecutionApi,
				context: Context,
			) => this.execute(candidate.name, api, args, context),
		});
	}

	private async execute(
		name: string,
		api: ToolExecutionApi,
		args: Record<string, unknown>,
		context: Context,
	) {
		if (this.conflictingNames.has(name))
			return this.failedResult("This local Pi tool is unavailable.");
		const owner = this.owners.get(api.conversationId);
		const run = this.options.contextFor(api.conversationId);
		const candidate = owner?.tools.get(name);
		if (!owner || owner.closing || !candidate || !run)
			return this.failedResult(
				"This local Pi tool is unavailable for this run.",
			);
		if (!this.isAllowedByPolicy(name, run.toolPolicy)) {
			this.report(candidate.sourceId, "restricted-policy-denied");
			return this.failedResult(
				"This local Pi tool is not allowed by the run policy.",
			);
		}
		owner.lastUsedAt = Date.now();
		const controller = new AbortController();
		const parentSignal = context.abortSignal;
		const abortFromParent = () => controller.abort(parentSignal?.reason);
		if (parentSignal?.aborted) abortFromParent();
		else
			parentSignal?.addEventListener("abort", abortFromParent, { once: true });
		owner.activeControllers.add(controller);
		const call = this.executePiTool(
			owner,
			candidate,
			api,
			args,
			run,
			context,
			controller,
		);
		owner.activeCalls.add(call);
		try {
			return await call;
		} finally {
			parentSignal?.removeEventListener("abort", abortFromParent);
			owner.activeControllers.delete(controller);
			owner.activeCalls.delete(call);
		}
	}

	private async executePiTool(
		owner: BridgeOwner,
		candidate: OwnerTool,
		api: ToolExecutionApi,
		args: Record<string, unknown>,
		run: DurableRunContext,
		context: Context,
		controller: AbortController,
	) {
		const definition = candidate.definition;
		let nestedCalls = 0;
		let progressUpdates = 0;
		let progressCharacters = 0;
		let detailsWork = Promise.resolve();
		let live = true;
		const update = (partial: AgentToolResult<unknown>) => {
			if (!live || controller.signal.aborted) return;
			if (++progressUpdates > MAX_PROGRESS_UPDATES) {
				this.report(candidate.sourceId, "progress-limit-reached");
				return;
			}
			const remainingText = MAX_PROGRESS_TEXT - progressCharacters;
			const progress = contentText(partial.content, Math.max(0, remainingText));
			if (progress.truncated)
				this.report(candidate.sourceId, "progress-content-truncated");
			if (progress.text) {
				progressCharacters += progress.text.length;
				api.output(progress.text);
			}
			const details = toBoundedJson(partial.details, MAX_DETAILS_BYTES, true);
			if (isTruncatedJson(details))
				this.report(candidate.sourceId, "progress-details-truncated");
			if (details !== undefined)
				detailsWork = detailsWork.then(() =>
					api.details(details, context).catch(() => {
						this.report(candidate.sourceId, "progress-update-failed");
					}),
				);
		};
		const toolContext = owner.session.extensionRunner.createToolContext(
			api.callId,
			controller.signal,
		);
		const nested = async (
			name: string,
			toolArgs: unknown,
			options?: {
				readonly signal?: AbortSignal;
				readonly onUpdate?: AgentToolUpdateCallback;
			},
		): Promise<AgentToolCallOutcome> => {
			if (controller.signal.aborted || options?.signal?.aborted)
				return this.nestedError(
					name,
					toolArgs,
					"The nested tool call was cancelled.",
				);
			if (++nestedCalls > MAX_NESTED_CALLS)
				return this.nestedError(
					name,
					toolArgs,
					"Nested tool-call limit reached.",
				);
			if (api.callId.split("/").length >= MAX_NESTED_DEPTH)
				return this.nestedError(
					name,
					toolArgs,
					"Nested tool-call depth limit reached.",
				);
			const nestedContext = options?.signal
				? withAbortSignal(options.signal, context)
				: context;
			const current = await api.agent(nestedContext);
			if (!current.callable.some((tool) => tool.name === name))
				return this.nestedError(
					name,
					toolArgs,
					"The requested tool is not callable by this run.",
				);
			if (!isRecord(toolArgs))
				return this.nestedError(
					name,
					toolArgs,
					"Tool arguments must be an object.",
				);
			const safeArgs = boundedJsonObject(toolArgs);
			if (!safeArgs)
				return this.nestedError(
					name,
					toolArgs,
					"Tool arguments contain unsupported values.",
				);
			try {
				const result = await api.executeTool(name, safeArgs, nestedContext, {
					key: `pi-${nestedCalls}`,
					progress: options?.onUpdate !== undefined,
				});
				const outcome = this.nestedOutcome(name, toolArgs, result);
				options?.onUpdate?.(outcome.result);
				return outcome;
			} catch {
				return this.nestedError(name, toolArgs, "The nested tool call failed.");
			}
		};
		let piTools: readonly AgentTool[] = [];
		const piContext = new Proxy(
			Object.create(toolContext) as typeof toolContext,
			{
				get: (target, property, receiver) => {
					if (property === "cwd") return run.cwd;
					if (property === "signal") return controller.signal;
					if (property === "hasUI") return false;
					if (property === "isProjectTrusted") return () => false;
					if (property === "tools") return piTools;
					if (property === "executeTool") return nested;
					if (property === "ui")
						return this.safeUi(target.ui, candidate.sourceId);
					if (unsupportedContextMembers.has(String(property)))
						throw new Error(
							"This Pi context capability is not available in a durable run.",
						);
					return Reflect.get(target, property, receiver) as unknown;
				},
				ownKeys: () => Reflect.ownKeys(toolContext),
				getOwnPropertyDescriptor: (_target, property) => {
					const descriptor = Reflect.getOwnPropertyDescriptor(
						toolContext,
						property,
					);
					return descriptor ? { ...descriptor, configurable: true } : undefined;
				},
			},
		);
		try {
			if (controller.signal.aborted)
				return this.failedResult("The local Pi tool call was cancelled.");
			const currentAgent = await api.agent(context);
			piTools = currentAgent.callable.map(
				(tool) =>
					({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
						execute: async (
							_toolCallId: string,
							toolArgs: Record<string, unknown>,
						) => {
							const outcome = await nested(tool.name, toolArgs);
							return outcome.result;
						},
					}) as AgentTool,
			);
			const result = await definition.execute(
				api.callId,
				args,
				controller.signal,
				update,
				piContext,
			);
			live = false;
			await detailsWork;
			if (controller.signal.aborted) {
				this.report(candidate.sourceId, "tool-cancelled");
				return this.failedResult("The local Pi tool call was cancelled.");
			}
			if (!isRecord(result) || !Array.isArray(result.content)) {
				this.report(candidate.sourceId, "invalid-tool-result");
				return this.failedResult(
					"The local Pi tool returned an unsupported result.",
				);
			}
			const content = boundContent(result.content);
			if (content === undefined) {
				this.report(candidate.sourceId, "result-limit-exceeded");
				return this.failedResult(
					"The local Pi tool result exceeded the supported size.",
				);
			}
			const details = toBoundedJson(result.details, MAX_DETAILS_BYTES, true);
			if (isTruncatedJson(details))
				this.report(candidate.sourceId, "result-details-truncated");
			const structured = result.structuredContent;
			if (
				definition.outputSchema &&
				structured === undefined &&
				result.isError !== true
			) {
				this.report(candidate.sourceId, "structured-result-missing");
				return this.failedResult(
					"The local Pi tool omitted its structured result.",
				);
			}
			const safeStructured =
				structured === undefined
					? undefined
					: toBoundedJson(structured, MAX_RESULT_BYTES, false);
			if (structured !== undefined && safeStructured === undefined) {
				this.report(candidate.sourceId, "structured-result-invalid");
				return this.failedResult(
					"The local Pi tool returned an unsupported structured result.",
				);
			}
			return {
				output: content as never,
				...(safeStructured !== undefined
					? { structuredOutput: safeStructured }
					: {}),
				...(typeof result.isError === "boolean"
					? { isError: result.isError }
					: {}),
				...(details !== undefined ? { details } : {}),
				...(result.terminate === true
					? { control: { terminate: true as const } }
					: {}),
			};
		} catch {
			live = false;
			await detailsWork;
			this.report(
				candidate.sourceId,
				controller.signal.aborted ? "tool-cancelled" : "tool-execution-failed",
			);
			return this.failedResult(
				controller.signal.aborted
					? "The local Pi tool call was cancelled."
					: "The local Pi tool failed; details were omitted.",
			);
		}
	}

	private safeUi(ui: object, sourceId: string): ExtensionUIContext {
		return new Proxy(ui as ExtensionUIContext, {
			get: (target, property, receiver) => {
				if (property === "notify")
					return (message: unknown) => {
						if (sourceId !== "mcp") {
							this.report(sourceId, "extension-notification");
							return;
						}
						const diagnostic = mcpNotificationClass(message);
						this.report(
							sourceId,
							diagnostic.failureClass,
							diagnostic.recoveryHint,
						);
					};
				if (
					["confirm", "custom", "editor", "input", "select"].includes(
						String(property),
					)
				)
					return async () => {
						throw new Error(
							"Interactive Pi UI is unavailable in a durable run.",
						);
					};
				const value = Reflect.get(target, property, receiver) as unknown;
				if (typeof value === "function")
					return async () => {
						throw new Error(
							"Interactive Pi UI is unavailable in a durable run.",
						);
					};
				return value;
			},
		});
	}

	private nestedOutcome(
		name: string,
		args: unknown,
		result: Awaited<ReturnType<ToolExecutionApi["executeTool"]>>,
	): AgentToolCallOutcome {
		const raw =
			result.structuredOutput === undefined
				? undefined
				: toBoundedJson(result.structuredOutput, MAX_RESULT_BYTES, false);
		const invalidStructured =
			result.structuredOutput !== undefined && raw === undefined;
		const isError = result.isError || invalidStructured;
		const resultView = result as unknown as {
			readonly output?: unknown;
			readonly diagnostics?: unknown;
		};
		const content = nestedContent(
			raw,
			isError,
			resultView.output,
			resultView.diagnostics,
		);
		const safeDetails = toBoundedJson(result.details, MAX_DETAILS_BYTES, true);
		if (isTruncatedJson(safeDetails))
			this.report(name, "nested-details-truncated");
		const agentResult: AgentToolResult<unknown> = {
			content,
			details: safeDetails,
			...(raw !== undefined ? { structuredContent: raw } : {}),
			...(result.usage ? { usage: result.usage } : {}),
			...(isError ? { isError: true } : {}),
		};
		return {
			toolCall: {
				type: "toolCall",
				id: `local-pi-${result.taskId}`,
				name,
				arguments: boundedJsonObject(args) ?? {},
			},
			result: agentResult,
			isError,
			...(result.durationMs !== undefined
				? { durationMs: result.durationMs }
				: {}),
		};
	}

	private nestedError(
		name: string,
		args: unknown,
		message: string,
	): AgentToolCallOutcome {
		return {
			toolCall: {
				type: "toolCall",
				id: "local-pi-nested-error",
				name,
				arguments: boundedJsonObject(args) ?? {},
			},
			result: {
				content: [{ type: "text", text: message }],
				details: null,
				isError: true,
			},
			isError: true,
		};
	}

	private failedResult(message: string) {
		return {
			output: [{ type: "text" as const, text: message }],
			isError: true,
		};
	}

	private isAllowedByPolicy(name: string, policy: ToolPolicy): boolean {
		if (policy === "default" || policy === "orchestrator") return true;
		return (
			policy === "read-only" &&
			this.settings.restrictedAllow.readOnly.includes(name)
		);
	}

	private registeredTools(owner: BridgeOwner): readonly PiRegisteredTool[] {
		return owner.session.extensionRunner.getAllRegisteredTools() as unknown as readonly PiRegisteredTool[];
	}

	private isBridgeMcpExtension(
		info: PiSourceInfo | undefined,
		extensionPath: string,
	): boolean {
		return info?.source === "inline" && extensionPath === MCP_EXTENSION_PATH;
	}

	private isMcpTool(entry: PiRegisteredTool): boolean {
		return (
			entry.sourceInfo.source === "inline" &&
			(entry.sourceInfo.path ?? "").startsWith("<inline:") &&
			entry.definition.name.startsWith("mcp__")
		);
	}

	private hasEntries(value: unknown): boolean {
		if (!value) return false;
		if (typeof value === "function") return true;
		if (value instanceof Map) return value.size > 0;
		if (Array.isArray(value)) return value.length > 0;
		return typeof value === "object" && Object.keys(value).length > 0;
	}

	private descriptionFor(candidate: OwnerTool): string {
		const description = boundedText(
			candidate.definition.description ?? "",
			8_000,
		);
		const namespace = candidate.definition.namespace?.name;
		const prefix = namespace
			? `Pi namespace: ${boundedText(namespace, 120)}. `
			: "";
		return `${prefix}${description || "User-level Pi tool."}`;
	}

	private fingerprint(definition: PiToolDefinition): string {
		return createHash("sha256")
			.update(
				stableStringify({
					name: definition.name,
					parameters: definition.parameters,
					outputSchema: definition.outputSchema,
					exposure: definition.exposure ?? "direct",
					defaultActive: definition.defaultActive,
				}),
			)
			.digest("hex");
	}

	private disableName(name: string, reason: string, label?: string): void {
		this.conflictingNames.add(name);
		this.report(
			label ?? this.registrations.get(name)?.sourceId ?? "bridge",
			reason,
		);
		if (!this.registrations.has(name)) return;
		this.registrations.delete(name);
		const index = this.tools.findIndex((tool) => tool.name === name);
		if (index >= 0) this.tools.splice(index, 1);
		for (const owner of this.owners.values()) owner.tools.delete(name);
		this.publishRegistry();
	}

	private publishRegistry(): void {
		this.options.registry.install({
			name: EXTENSION_NAME,
			tools: [...this.tools],
		});
	}

	private pruneUnusedRegistrations(): void {
		const usedNames = new Set(
			[...this.owners.values()].flatMap((owner) => [...owner.tools.keys()]),
		);
		let changed = false;
		for (let index = this.tools.length - 1; index >= 0; index -= 1) {
			const registration = this.tools[index];
			if (!registration || usedNames.has(registration.name)) continue;
			this.registrations.delete(registration.name);
			this.conflictingNames.delete(registration.name);
			this.tools.splice(index, 1);
			changed = true;
		}
		for (const name of this.conflictingNames)
			if (!usedNames.has(name)) this.conflictingNames.delete(name);
		if (changed) this.publishRegistry();
	}

	private extensionLabel(extensionPath: string): string {
		return `extension-${createHash("sha256").update(extensionPath).digest("hex").slice(0, 8)}`;
	}

	private report(
		label: string,
		failureClass: string,
		recoveryHint?: string,
	): void {
		const safeLabel = boundedText(label.replace(/[^A-Za-z0-9_.:-]/g, "-"), 64);
		const safeClass = boundedText(
			failureClass.replace(/[^A-Za-z0-9_.:-]/g, "-"),
			64,
		);
		const key = `${safeLabel}:${safeClass}`;
		if (this.reported.has(key) || this.reported.size >= 64) return;
		this.reported.add(key);
		const safeHint = recoveryHint
			? `; next: ${boundedText(
					recoveryHint.replace(/[^A-Za-z0-9 .,'-]/g, "-"),
					128,
				)}`
			: "";
		this.options.log(`local Pi bridge ${safeLabel}: ${safeClass}${safeHint}`);
	}

	private async closeOwner(
		conversationId: ConversationId,
		owner: BridgeOwner,
	): Promise<void> {
		if (owner.closing) return;
		owner.closing = true;
		for (const controller of owner.activeControllers) controller.abort();
		await Promise.allSettled([...owner.activeCalls]);
		try {
			await owner.session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} catch {
			this.report("bridge", "session-shutdown-failed");
		}
		await this.disposeSession(owner.session);
		if (this.owners.get(conversationId) === owner)
			this.owners.delete(conversationId);
		this.pruneUnusedRegistrations();
	}

	private async disposeSession(session: BridgeOwner["session"]): Promise<void> {
		try {
			session.dispose();
		} catch {
			this.report("bridge", "session-dispose-failed");
		}
	}
}

/** Stable user-facing name for a tool from one local extension module. */
export function piExtensionToolName(
	extensionPath: string,
	toolName: string,
): string {
	const base = path
		.basename(extensionPath, path.extname(extensionPath))
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 24);
	const hash = createHash("sha256")
		.update(path.resolve(extensionPath))
		.digest("hex")
		.slice(0, 8);
	const prefix = `pi__${base || hash}__`;
	const candidate = `${prefix}${toolName}`;
	return candidate.length <= 64
		? candidate
		: `pi__${hash}__${toolName.slice(0, Math.max(1, 64 - hash.length - 6))}`;
}

function boundedText(value: string, maxLength: number): string {
	return value.length <= maxLength
		? value
		: `${truncateUtf8(value, Math.max(0, maxLength - 14))} [truncated]`;
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const parts: string[] = [];
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maxBytes) break;
		parts.push(character);
		bytes += size;
	}
	return parts.join("");
}

function contentText(
	content: readonly unknown[],
	maxLength: number,
): { text: string; truncated: boolean } {
	const parts: string[] = [];
	let remaining = maxLength;
	const itemLimit = Math.min(content.length, MAX_CONTENT_ITEMS);
	for (let index = 0; index < itemLimit && remaining > 0; index += 1) {
		const item = content[index];
		if (
			!isRecord(item) ||
			item.type !== "text" ||
			typeof item.text !== "string"
		)
			continue;
		const text = item.text.slice(0, remaining);
		parts.push(text);
		remaining -= text.length;
	}
	const truncated = content.length > itemLimit;
	if (truncated && remaining > 0) {
		const marker = "[progress content truncated]".slice(0, remaining);
		parts.push(marker);
	}
	return { text: parts.join("\n"), truncated };
}

function boundContent(
	value: readonly unknown[],
): readonly unknown[] | undefined {
	if (value.length > MAX_CONTENT_ITEMS) return undefined;
	const output: unknown[] = [];
	let remaining = MAX_RESULT_BYTES;
	for (const item of value) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string") {
			const text = truncateUtf8(item.text, Math.max(0, remaining - 32));
			output.push({ type: "text", text });
			remaining -= Buffer.byteLength(text, "utf8") + 32;
		} else if (
			item.type === "image" &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string"
		) {
			const imageBytes = Buffer.byteLength(item.data, "utf8");
			if (imageBytes > remaining - 128) continue;
			const image = {
				type: "image",
				data: item.data,
				mimeType: boundedText(item.mimeType, 128),
				...(typeof item.altText === "string"
					? { altText: boundedText(item.altText, 512) }
					: {}),
			};
			const bytes = imageBytes + Buffer.byteLength(image.mimeType, "utf8") + 32;
			if (bytes > remaining) continue;
			output.push(image);
			remaining -= bytes;
		}
		if (remaining <= 0) break;
	}
	return output;
}

function toBoundedJson(
	value: unknown,
	maxBytes: number,
	truncateStrings: boolean,
): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const seen = new WeakSet<object>();
		let remainingNodes = 2_000;
		let traversalTruncated = false;
		const convert = (entry: unknown, depth: number): JsonValue | undefined => {
			if (remainingNodes <= 0 || depth > 12) {
				traversalTruncated = true;
				return "[truncated]";
			}
			remainingNodes -= 1;
			if (entry === null || typeof entry === "boolean") return entry;
			if (typeof entry === "string")
				return truncateStrings ? boundedText(entry, 8_000) : entry;
			if (typeof entry === "number")
				return Number.isFinite(entry) ? entry : null;
			if (typeof entry !== "object") return String(entry);
			if (seen.has(entry)) return "[circular]";
			seen.add(entry);
			if (Array.isArray(entry)) {
				const output: JsonValue[] = [];
				const itemLimit = Math.min(entry.length, MAX_CONTAINER_ENTRIES);
				for (
					let index = 0;
					index < itemLimit && remainingNodes > 0;
					index += 1
				) {
					const converted = convert(entry[index], depth + 1);
					if (converted !== undefined) output.push(converted);
				}
				if (entry.length > itemLimit || remainingNodes <= 0) {
					traversalTruncated = true;
					output.push("[truncated]");
				}
				seen.delete(entry);
				return output;
			}
			const output: Record<string, JsonValue> = {};
			let inspected = 0;
			let truncated = false;
			for (const key in entry) {
				if (inspected >= MAX_CONTAINER_ENTRIES || remainingNodes <= 0) {
					truncated = true;
					break;
				}
				inspected += 1;
				if (!Object.hasOwn(entry, key)) continue;
				const converted = convert(
					(entry as Record<string, unknown>)[key],
					depth + 1,
				);
				if (converted !== undefined) output[boundedText(key, 128)] = converted;
			}
			if (truncated) {
				traversalTruncated = true;
				output.truncated = true;
			}
			seen.delete(entry);
			return output;
		};
		const converted = convert(value, 0);
		if (converted === undefined) return undefined;
		const serialized = JSON.stringify(converted);
		if (traversalTruncated) {
			return truncateStrings
				? { truncated: true, preview: truncateUtf8(serialized, maxBytes - 128) }
				: undefined;
		}
		if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return converted;
		return truncateStrings
			? { truncated: true, preview: truncateUtf8(serialized, maxBytes - 128) }
			: undefined;
	} catch {
		return undefined;
	}
}

function isTruncatedJson(value: JsonValue | undefined): boolean {
	return isRecord(value) && value.truncated === true;
}

function boundedJsonObject(
	input: unknown,
	maxBytes = MAX_RESULT_BYTES,
): JsonObject | undefined {
	const value = toBoundedJson(input, maxBytes, false);
	return isRecord(value) ? (value as JsonObject) : undefined;
}

function boundedDiagnosticText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const parts: string[] = [];
	const itemLimit = Math.min(value.length, 32);
	let remaining = 8_000;
	for (let index = 0; index < itemLimit && remaining > 0; index += 1) {
		const entry = value[index];
		if (!isRecord(entry) || typeof entry.message !== "string") continue;
		const message = boundedText(entry.message, Math.min(2_000, remaining));
		if (!message) continue;
		parts.push(message);
		remaining -= message.length + 1;
	}
	if (value.length > itemLimit && remaining > 0)
		parts.push("Additional nested-tool diagnostics were omitted.");
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function nestedContent(
	value: JsonValue | undefined,
	isError: boolean,
	output?: unknown,
	diagnostics?: unknown,
): AgentToolResult["content"] {
	if (typeof value === "string")
		return [{ type: "text", text: boundedText(value, 8_000) }];
	if (isRecord(value) && value.type === "image") {
		if (
			typeof value.data === "string" &&
			typeof value.mimeType === "string" &&
			Buffer.byteLength(value.data, "utf8") <= MAX_RESULT_BYTES
		)
			return [
				{
					type: "image",
					data: value.data,
					mimeType: value.mimeType,
				},
			];
	}
	if (Array.isArray(value)) {
		const content = boundContent(value);
		if (content) return content as AgentToolResult["content"];
	}
	if (typeof output === "string")
		return [{ type: "text", text: boundedText(output, 8_000) }];
	if (Array.isArray(output)) {
		const content = boundContent(output);
		if (content && content.length > 0)
			return content as AgentToolResult["content"];
	}
	if (isRecord(output) && typeof output.text === "string")
		return [{ type: "text", text: boundedText(output.text, 8_000) }];
	const diagnosticText = boundedDiagnosticText(diagnostics);
	if (diagnosticText) return [{ type: "text", text: diagnosticText }];
	if (isError) return [{ type: "text", text: "The nested tool call failed." }];
	if (value !== undefined)
		return [{ type: "text", text: boundedText(JSON.stringify(value), 8_000) }];
	return [];
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([left], [right]) => left.localeCompare(right),
		);
		return `{${entries
			.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

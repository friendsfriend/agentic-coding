import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type {
	AgentHandle,
	Assignment,
	ResolvedProfile,
	RuntimeId,
} from "../contracts/workflow.ts";
import type {
	AgentLifecycleOps,
	AgentObservation,
	MultiplexerPort,
} from "../multiplexer/port.ts";
import { selfExecEntry } from "../self-exec.ts";
import type { RenderedAssignment } from "./assignment.ts";
import type { JevSessionBinding } from "./classifier-runner.ts";
import type { GlobalPiTool } from "./pi-tools.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	writeAtomicPrivateFile,
} from "./secure-fs.ts";

export {
	HerdrLifecycle,
	HerdrMultiplexer,
} from "../multiplexer/herdr/index.ts";
export type { AgentObservation, MultiplexerPort } from "../multiplexer/port.ts";
/** Deprecated alias (add-multiplexer-adapters, task 1.3): existing Herdr-port
 * imports keep type-checking while call sites migrate to the port. */
export type HerdrPort = MultiplexerPort;

export interface LaunchContext {
	profile: ResolvedProfile;
	assignment: Assignment;
	rendered: RenderedAssignment;
	paneId: string;
	tabId?: string;
	cwd: string;
	/** Runtime bookkeeping is kept outside a wiki-root agent workspace. */
	runDirectory?: string;
	name: string;
	environment: Record<string, string>;
	bridgePath?: string;
	/** Trusted workflow extension; distinct from user-configured extensions. */
	workflowExtensionPath?: string;
	/** The in-session `ask_jev` tool, loaded for every pi run: without it the tool
	 * the pinned protocol names is simply absent. Absent for a runtime with no
	 * such tool. */
	jevExtensionPath?: string;
	/** Tools this user's own pi configuration enables globally (`codemode`), so a
	 * managed agent gets the same tool surface as their own pi session. Read by
	 * the engine at launch, and defaulted to none, so a launch never depends on
	 * the machine's settings being readable at that moment. */
	globalTools?: readonly GlobalPiTool[];
	/** The resolved classifier binding the in-session tool obeys, or absent when
	 * no pane-reachable provider is resolved. Serialized into the pane
	 * environment by the launcher, never read from the machine: the agent cannot
	 * select a provider the run was not pinned to. */
	jev?: JevSessionBinding;
	/** Abort ownership-bound external work when the effect lease is lost. */
	signal?: AbortSignal;
}
/** Workflow-facing agent lifecycle boundary (migrate-workflow-execution-to-effect
 * task 2.2/3.1). Methods are Effect operations; the underlying multiplexer
 * transport and subprocesses remain the foreign API boundary. Successfully
 * launched agents, adopted panes, and created workspaces belong to the durable
 * workflow and intentionally outlive a runner drain — nothing here tears them
 * down on ordinary scope exit. */
export interface AgentAdapter {
	readonly id: RuntimeId;
	/** True for a runtime that hosts its own process rather than running inside
	 * a multiplexer pane (add-pi-durable-runtime, `pi-durable`). Absent (or
	 * false) for every pane-based runtime; the launch handler in
	 * `effect-runner.ts` gates pane allocation/closing on it. */
	readonly hostsOwnProcess?: boolean;
	preflight(profile: ResolvedProfile, requirements: readonly string[]): void;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error>;
	prompt(
		handle: AgentHandle,
		message: string,
		signal?: AbortSignal,
	): Effect.Effect<void, Error>;
	observe(
		handle: AgentHandle,
		signal?: AbortSignal,
	): Effect.Effect<AgentObservation, Error>;
	stop(handle: AgentHandle, signal?: AbortSignal): Effect.Effect<void, Error>;
}
function requireExecutable(executable: string): string {
	const resolved = path.isAbsolute(executable)
		? executable
		: Bun.which(executable);
	if (!resolved || !fs.existsSync(resolved))
		throw new Error(`configured runtime executable not found: ${executable}`);
	return fs.realpathSync(resolved);
}
abstract class BaseAdapter implements AgentAdapter {
	abstract readonly id: RuntimeId;
	constructor(protected readonly lifecycle: AgentLifecycleOps) {}
	preflight(profile: ResolvedProfile, requirements: readonly string[]): void {
		if (profile.runtime !== this.id)
			throw new Error(
				`profile runtime ${profile.runtime} routed to ${this.id}`,
			);
		requireExecutable(profile.executable);
		const missing = requirements.filter(
			(requirement) =>
				requirement !== "read-only" &&
				!profile.capabilities.includes(requirement as never),
		);
		if (missing.length)
			throw new Error(
				`${this.id} lacks required policy: ${missing.join(", ")}`,
			);
	}
	abstract launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error>;
	prompt(handle: AgentHandle, message: string, signal?: AbortSignal) {
		return this.lifecycle.prompt(handle.paneId, message, signal);
	}
	observe(handle: AgentHandle, signal?: AbortSignal) {
		return this.lifecycle.observe(handle.paneId, signal);
	}
	stop(handle: AgentHandle, signal?: AbortSignal) {
		return this.lifecycle.stop(handle.paneId, signal);
	}
}
export class PiAdapter extends BaseAdapter {
	readonly id = "pi" as const;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		// A managed session must not depend on pi's interactive project-trust
		// decision. Worktrees carry the repository's `.pi` resources but sit outside
		// its saved trust path, so pi asks at startup and the launch prompt —
		// submitted into that dialog — is consumed as its answer, leaving the run
		// parked on a live but unprompted agent. Declining project resources for the
		// run matches the managed-session contract already visible in
		// `--no-prompt-templates` and the default `--no-extensions`; context files
		// such as AGENTS.md load regardless of trust, and CLI `--extension` paths are
		// unaffected.
		const args = ["--name", ctx.name, "--no-prompt-templates", "--no-approve"];
		if (ctx.profile.model) args.push("--model", ctx.profile.model);
		if (ctx.profile.thinking) args.push("--thinking", ctx.profile.thinking);
		const readOnly =
			ctx.profile.readOnly || ctx.profile.capabilities.includes("read-only");
		// pi's `--tools` replaces the whole selection, so a tool nobody names is a
		// tool the model never sees. Everything the run loads or inherits has to be
		// named here: the workflow's own extension tools (the pinned protocol's
		// question tools, and the in-session judgment sweep), plus the tools this
		// user's own pi settings enable globally.
		const global = ctx.globalTools ?? [];
		const inherited = [
			...(ctx.workflowExtensionPath ? ["developer_question", "agent_ask"] : []),
			...(ctx.jevExtensionPath ? ["ask_jev"] : []),
			...global.map((entry) => entry.tool),
		];
		const declared = ctx.profile.tools;
		// A profile that declares no tool list keeps pi's own default selection:
		// naming only the inherited tools would replace `read`/`bash`/`edit`/
		// `write` with an extension-only allowlist, contradicting the capabilities
		// preflight accepted. A read-only profile still needs `read` named,
		// because its whole point is to have no edit/write tool at all.
		const tools = declared.length
			? [...new Set([...declared, ...inherited])]
			: readOnly
				? [...new Set(["read", ...inherited])]
				: undefined;
		if (tools) args.push("--tools", tools.join(","));
		if (readOnly || ctx.profile.extensions.length === 0)
			args.push("--no-extensions");
		for (const extension of ctx.profile.extensions)
			args.push("--extension", extension);
		// `--no-extensions` disables the built-in extensions too, and a globally
		// enabled tool like `codemode` lives in one. Requesting it explicitly keeps
		// the user's extension *files* out of a managed run without dropping the
		// tool they configured.
		for (const entry of global)
			args.push("--extension", `builtin:${entry.extension}`);
		if (ctx.workflowExtensionPath)
			args.push("--extension", ctx.workflowExtensionPath);
		if (ctx.jevExtensionPath) args.push("--extension", ctx.jevExtensionPath);
		if (ctx.bridgePath) args.push("--extension", ctx.bridgePath);
		const withLauncher = withRuntimeLauncher(ctx, "pi");
		return launchHandle(this.lifecycle, withLauncher, "pi", args, ctx);
	}
}
export class OpenCodeAdapter extends BaseAdapter {
	readonly id = "opencode" as const;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		const args: string[] = ["--auto"];
		if (ctx.profile.model) args.push("--model", ctx.profile.model);
		if (ctx.profile.agent) args.push("--agent", ctx.profile.agent);
		const withLauncher = withOpenCodeLauncher(isolatedOpenCode(ctx));
		return launchHandle(this.lifecycle, withLauncher, "opencode", args, ctx);
	}
}
/** Shared launch mapping: the adapter owns runtime args + profile-visible
 * paths, the multiplexer port owns env injection, readiness, and launch-prompt
 * confirmation. */
function launchHandle(
	lifecycle: AgentLifecycleOps,
	launched: LaunchContext,
	kind: "pi" | "opencode",
	runtimeArgs: string[],
	original: LaunchContext,
): Effect.Effect<AgentHandle, Error> {
	return lifecycle
		.start({
			kind,
			name: original.name,
			paneId: original.paneId,
			cwd: original.cwd,
			runId: original.assignment.runId,
			...(original.runDirectory ? { runDirectory: original.runDirectory } : {}),
			runtimeArgs,
			environment: launched.environment,
			prompt: original.rendered.prompt,
			...(original.signal ? { signal: original.signal } : {}),
		})
		.pipe(
			Effect.map((info) => ({
				runtime: original.profile.runtime,
				name: original.name,
				paneId: info.paneId,
				...(info.tabId ? { tabId: info.tabId } : {}),
				...(info.sessionId ? { sessionId: info.sessionId } : {}),
			})),
		);
}
function isolatedOpenCode(ctx: LaunchContext): LaunchContext {
	const root = ctx.runDirectory ?? path.join(ctx.cwd, ".herdr-workflow");
	const directory = path.join(root, "runtime-config", ctx.assignment.runId);
	const directoryFd = openSecureDirectory(
		directory,
		ctx.runDirectory ?? ctx.cwd,
	);
	try {
		writeAtomicPrivateFile(
			directoryFd,
			"opencode.json",
			JSON.stringify(
				{
					permission:
						ctx.profile.readOnly ||
						ctx.profile.capabilities.includes("read-only")
							? // Read-only means no repository edits; bash stays allowed because
								// focused checks and the `agentic-coding workflow handoff` CLI
								// run through it (same contract as pi's `read,bash`).
								{ edit: "deny", bash: "allow", read: "allow" }
							: { edit: "allow", bash: "allow", read: "allow" },
					plugin: ctx.bridgePath ? [ctx.bridgePath] : [],
				},
				null,
				2,
			),
			0o600,
		);
	} finally {
		closeSecureDirectory(directoryFd);
	}
	return {
		...ctx,
		environment: { ...ctx.environment, XDG_CONFIG_HOME: directory },
	};
}
function withOpenCodeLauncher(ctx: LaunchContext): LaunchContext {
	return withRuntimeLauncher(ctx, "opencode");
}
function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
function withRuntimeLauncher(
	ctx: LaunchContext,
	name: "pi" | "opencode",
): LaunchContext {
	const target = requireExecutable(ctx.profile.executable);
	const directory = path.join(
		ctx.runDirectory ?? path.join(ctx.cwd, ".herdr-workflow"),
		"runtime-bin",
		ctx.assignment.runId,
	);
	const directoryFd = openSecureDirectory(
		directory,
		ctx.runDirectory ?? ctx.cwd,
	);
	const environment = {
		...ctx.environment,
		PATH: `${directory}:${process.env.PATH ?? ""}`,
		// The binding travels to the pane, so the in-session tool cannot disagree
		// with the run's pinned classifier. It is not a secret: for a hosted
		// provider no binding is built at all.
		...(ctx.jev ? { AGENTIC_JEV: JSON.stringify(ctx.jev) } : {}),
	};
	const exports = Object.entries(environment)
		.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
		.map(([key, value]) => `export ${key}=${shQuote(value)}`)
		.join("\n");
	const content = `#!/bin/sh\n${exports}\nexec ${shQuote(target)} "$@"\n`;
	try {
		writeAtomicPrivateFile(directoryFd, name, content, 0o700);
	} finally {
		closeSecureDirectory(directoryFd);
	}
	return { ...ctx, environment };
}

export class OpenCodeV2Adapter extends BaseAdapter {
	readonly id = "opencode-v2" as const;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		const args: string[] = ["--auto"];
		if (ctx.profile.model) args.push("--model", ctx.profile.model);
		if (ctx.profile.agent) args.push("--agent", ctx.profile.agent);
		const withLauncher = withOpenCodeLauncher(isolatedOpenCode(ctx));
		return launchHandle(this.lifecycle, withLauncher, "opencode", args, ctx);
	}
}

export class PiDurableAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;
	/** Marks this adapter as hosting its own process (durable-agent-host D4):
	 * the launch handler in `effect-runner.ts` skips pane allocation/closing
	 * for it instead of every runtime needing a pane. */
	readonly hostsOwnProcess = true as const;

	preflight(profile: ResolvedProfile, requirements: readonly string[]): void {
		if (profile.runtime !== this.id)
			throw new Error(
				`profile runtime ${profile.runtime} routed to ${this.id}`,
			);
		// No executable lookup (durable-agent-host: "preflight checks
		// capabilities (no executable lookup)"): the host is bundled, not an
		// external binary on PATH.
		const missing = requirements.filter(
			(requirement) =>
				requirement !== "read-only" &&
				!profile.capabilities.includes(requirement as never),
		);
		if (missing.length)
			throw new Error(
				`${this.id} lacks required policy: ${missing.join(", ")}`,
			);
	}

	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		return Effect.tryPromise({
			try: async () => {
				const { hostLayout } = await import("../agent-host/layout.ts");
				const { ensureHostRunning, HostClient } = await import(
					"../agent-host/client.ts"
				);
				const runtimeDir = durableRuntimeDir(ctx);
				const layout = hostLayout(runtimeDir);
				const entry = selfExecEntry();
				await ensureHostRunning(layout, {
					command: process.execPath,
					args: [
						...(entry ? [entry] : []),
						"agent",
						"host",
						"--workflow-dir",
						runtimeDir,
					],
					cwd: ctx.cwd,
				});
				// No multiplexer pane shell injects the run environment for this
				// runtime (durable-agent-host: "Per-run execution environment"), so
				// the adapter writes the same `run.env` file a pane-based launch
				// gets from its multiplexer `agentStart`, including the classifier
				// binding every other runtime's launcher injects into the pane
				// shell instead.
				const { writeAgentRunEnv } = await import(
					"../multiplexer/agent-env.ts"
				);
				const runEnvPath = writeAgentRunEnv({
					cwd: ctx.cwd,
					...(ctx.runDirectory ? { runDirectory: ctx.runDirectory } : {}),
					runId: ctx.assignment.runId,
					environment: {
						...ctx.environment,
						...(ctx.jev ? { AGENTIC_JEV: JSON.stringify(ctx.jev) } : {}),
					},
				});
				const client = new HostClient(layout.socketPath);
				const readOnly =
					ctx.profile.readOnly ||
					ctx.profile.capabilities.includes("read-only");
				const ensured = await client.ensureRun({
					runId: ctx.assignment.runId,
					cwd: ctx.cwd,
					runEnvPath,
					name: ctx.name,
					toolPolicy: readOnly ? "read-only" : "default",
					...(ctx.profile.model ? { model: ctx.profile.model } : {}),
					...(ctx.profile.thinking ? { thinking: ctx.profile.thinking } : {}),
				});
				await client.submit(
					ctx.assignment.runId,
					ctx.rendered.prompt,
					promptRequestId(ctx.assignment.runId, ctx.rendered.prompt),
					"followUp",
				);
				const handle: AgentHandle = {
					runtime: this.id,
					name: ctx.name,
					paneId: "",
					hostSocket: layout.socketPath,
					sessionId: ctx.assignment.runId,
					conversationId: ensured.conversationId,
				};
				return handle;
			},
			catch: toError,
		});
	}

	prompt(
		handle: AgentHandle,
		message: string,
		_signal?: AbortSignal,
	): Effect.Effect<void, Error> {
		return Effect.tryPromise({
			try: async () => {
				const runId = requireDurableRunId(handle);
				const { HostClient } = await import("../agent-host/client.ts");
				const client = new HostClient(requireDurableSocket(handle));
				await client.submit(
					runId,
					message,
					promptRequestId(runId, message),
					"followUp",
				);
			},
			catch: toError,
		});
	}

	observe(
		handle: AgentHandle,
		_signal?: AbortSignal,
	): Effect.Effect<AgentObservation, Error> {
		return Effect.tryPromise({
			try: async () => {
				if (!handle.hostSocket || !handle.sessionId)
					return { status: "unknown" as const, paneId: "" };
				const { HostClient, ensureHostRunning } = await import(
					"../agent-host/client.ts"
				);
				const { hostLayout } = await import("../agent-host/layout.ts");
				const client = new HostClient(handle.hostSocket);
				try {
					const result = await client.status(handle.sessionId);
					return {
						status: result.status,
						paneId: "",
						...(handle.sessionId ? { sessionId: handle.sessionId } : {}),
					};
				} catch {
					// One restart/resume attempt per observation before reporting
					// unknown (durable-agent-host D4): a crashed host must not
					// permanently block the run it was serving.
					try {
						const runtimeDir = path.dirname(path.dirname(handle.hostSocket));
						const layout = hostLayout(runtimeDir);
						const entry = selfExecEntry();
						await ensureHostRunning(layout, {
							command: process.execPath,
							args: [
								...(entry ? [entry] : []),
								"agent",
								"host",
								"--workflow-dir",
								runtimeDir,
							],
							cwd: runtimeDir,
						});
						const retried = await new HostClient(layout.socketPath).status(
							handle.sessionId,
						);
						return { status: retried.status, paneId: "" };
					} catch {
						return { status: "unknown" as const, paneId: "" };
					}
				}
			},
			catch: toError,
		});
	}

	stop(handle: AgentHandle, _signal?: AbortSignal): Effect.Effect<void, Error> {
		return Effect.tryPromise({
			try: async () => {
				if (!handle.hostSocket || !handle.sessionId) return;
				const { HostClient } = await import("../agent-host/client.ts");
				await new HostClient(handle.hostSocket).stopRun(handle.sessionId);
			},
			catch: toError,
		});
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
function durableRuntimeDir(ctx: LaunchContext): string {
	return ctx.runDirectory ?? path.join(ctx.cwd, ".herdr-workflow");
}
/** A stable per-(run, message) idempotency key: a retried delivery of the same
 * text is the same key (durable-agent-host: "Exactly-once submissions"), while
 * genuinely new content gets a new one. `AgentAdapter.prompt` does not carry
 * the caller's own effect idempotency key, so this is derived rather than
 * threaded through the adapter interface. */
function promptRequestId(runId: string, message: string): string {
	return createHash("sha256")
		.update(`${runId}\u0000${message}`)
		.digest("hex")
		.slice(0, 32);
}
function requireDurableRunId(handle: AgentHandle): string {
	if (!handle.sessionId)
		throw new Error("pi-durable handle is missing its run id");
	return handle.sessionId;
}
function requireDurableSocket(handle: AgentHandle): string {
	if (!handle.hostSocket)
		throw new Error("pi-durable handle is missing its host socket");
	return handle.hostSocket;
}

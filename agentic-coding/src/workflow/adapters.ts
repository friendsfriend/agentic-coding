// Managed agent adapters (multiplexer removal).
//
// The one runtime is `pi-durable`: the bundled durable host owns the agent
// process, and this adapter speaks its control socket. Pane-hosted runtimes
// (`pi`, `opencode`) and the multiplexer lifecycle they needed are gone, so an
// adapter no longer receives a pane id, a bridge path or a launcher script.
import { createHash } from "node:crypto";
import path from "node:path";
import { Effect } from "effect";
import type {
	AgentHandle,
	Assignment,
	ResolvedProfile,
	RuntimeId,
} from "../contracts/workflow.ts";
import { selfExecEntry } from "../self-exec.ts";
import type { RenderedAssignment } from "./assignment.ts";
import type { JevSessionBinding } from "./classifier-runner.ts";
import { writeAgentRunEnv } from "./run-env.ts";

export interface LaunchContext {
	profile: ResolvedProfile;
	assignment: Assignment;
	rendered: RenderedAssignment;
	cwd: string;
	/** Runtime bookkeeping is kept outside a wiki-root agent workspace. */
	runDirectory?: string;
	name: string;
	environment: Record<string, string>;
	/** The resolved classifier binding the in-session tool obeys, or absent when
	 * no reachable provider is resolved. Written into the run environment, never
	 * read from the machine: the agent cannot select a provider the run was not
	 * pinned to. */
	jev?: JevSessionBinding;
	/** Abort ownership-bound external work when the effect lease is lost. */
	signal?: AbortSignal;
}

/** One observation of a managed run. */
export interface AgentObservation {
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	sessionId?: string;
}

/** Workflow-facing agent lifecycle boundary. Methods are Effect operations;
 * the durable host transport is the foreign API boundary. Successfully launched
 * agents belong to the durable workflow and intentionally outlive a runner
 * drain — nothing here tears them down on ordinary scope exit. */
export interface AgentAdapter {
	readonly id: RuntimeId;
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

export class PiDurableAdapter implements AgentAdapter {
	readonly id = "pi-durable" as const;

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
				// The host reads the run's environment from this file
				// (durable-agent-host: "Per-run execution environment"), including
				// the classifier binding.
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
					return { status: "unknown" as const };
				const { HostClient, ensureHostRunning } = await import(
					"../agent-host/client.ts"
				);
				const { hostLayout } = await import("../agent-host/layout.ts");
				const client = new HostClient(handle.hostSocket);
				try {
					const result = await client.status(handle.sessionId);
					return {
						status: result.status,
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
						return { status: retried.status };
					} catch {
						return { status: "unknown" as const };
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

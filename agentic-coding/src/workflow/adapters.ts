// Managed agent adapters (multiplexer removal).
//
// The one runtime is `pi-durable`: the bundled durable host owns the agent
// process, and this adapter speaks its control socket. Pane-hosted runtimes
// (`pi`, `opencode`) and the multiplexer lifecycle they needed are gone, so an
// adapter no longer receives a pane id, a bridge path or a launcher script.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
	HostLaunchVerificationError,
	HostUnavailableError,
} from "../agent-host/client.ts";
import type { LaunchClaim, LaunchObservation } from "../contracts/launch.ts";
import type {
	AgentHandle,
	ApprovedDesign,
	Assignment,
	ResolvedProfile,
	RuntimeId,
} from "../contracts/workflow.ts";
import { selfExecEntry } from "../self-exec.ts";
import type { RenderedAssignment } from "./assignment.ts";
import type { JevSessionBinding } from "./classifier-runner.ts";
import { WorkflowRuntimeError } from "./contracts.ts";
import { PermanentFailure, TransientFailure } from "./failures.ts";
import { writeAgentRunEnv } from "./run-env.ts";

/** Snapshot the bounded, confined design bytes at the real operator approval
 * boundary, before the writer transaction. Later file edits cannot rewrite the
 * evidence that action approved. Missing/unsafe designs remain ineligible. */
export function captureApprovedDesign(
	worktree: string,
	changeId: string,
): Effect.Effect<
	Pick<ApprovedDesign, "content" | "digest"> | undefined,
	WorkflowRuntimeError
> {
	return Effect.try({
		try: () => {
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(changeId)) return undefined;
			try {
				const root = fs.realpathSync(worktree);
				const file = fs.realpathSync(
					path.join(root, "openspec", "changes", changeId, "design.md"),
				);
				const relative = path.relative(root, file);
				if (
					!relative ||
					relative === ".." ||
					relative.startsWith(`..${path.sep}`) ||
					path.isAbsolute(relative)
				)
					return undefined;
				const fd = fs.openSync(
					file,
					fs.constants.O_RDONLY |
						fs.constants.O_NOFOLLOW |
						fs.constants.O_NONBLOCK,
				);
				try {
					if (!fs.fstatSync(fd).isFile()) return undefined;
					const buffer = Buffer.alloc(128 * 1024 + 1);
					const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
					if (!count || count > 128 * 1024) return undefined;
					const bytes = buffer.subarray(0, count);
					const content = bytes.toString("utf8");
					if (!Buffer.from(content).equals(bytes)) return undefined;
					return {
						content,
						digest: createHash("sha256")
							.update(JSON.stringify(content))
							.digest("hex"),
					};
				} finally {
					fs.closeSync(fd);
				}
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ELOOP") return undefined;
				throw error;
			}
		},
		catch: (error) =>
			new WorkflowRuntimeError(
				"unavailable",
				`Could not snapshot approved design: ${error instanceof Error ? error.message : String(error)}`,
			),
	});
}

// Read-only bounded observation: never starts, restarts or reattaches a host.
export function observeLaunchRecovery(
	socketPath: string,
	runIds: readonly string[],
): Effect.Effect<LaunchObservation[], WorkflowRuntimeError> {
	return Effect.tryPromise({
		try: async () => {
			if (runIds.length > 32) throw new Error("inspection limit");
			const { authenticatedHostClient } = await import(
				"../agent-host/client.ts"
			);
			const client = authenticatedHostClient(socketPath, 5000);
			return Promise.all(runIds.map((runId) => client.inspectLaunch(runId)));
		},
		catch: () =>
			new WorkflowRuntimeError(
				"unavailable",
				"Host launch observation unavailable; check the background server and host, then inspect recovery again. No workflow state was changed.",
			),
	});
}

export interface LaunchContext {
	/** Only a committed launch claim can authorize managed remote admission. */
	claim?: LaunchClaim;
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
	stop(
		handle: AgentHandle,
		signal?: AbortSignal,
		claim?: LaunchClaim,
	): Effect.Effect<void, Error>;
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
				const { ensureHostRunning, authenticatedHostClient } = await import(
					"../agent-host/client.ts"
				);
				const { registerHostRetryTarget } = await import(
					"../agent-host/retry-authority.ts"
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
				const client = authenticatedHostClient(layout.socketPath);
				const readOnly =
					ctx.profile.readOnly ||
					ctx.profile.capabilities.includes("read-only");
				const request = {
					runId: ctx.assignment.runId,
					cwd: ctx.cwd,
					runEnvPath,
					name: ctx.name,
					toolPolicy: readOnly ? ("read-only" as const) : ("default" as const),
					...(ctx.profile.model ? { model: ctx.profile.model } : {}),
					...(ctx.profile.thinking ? { thinking: ctx.profile.thinking } : {}),
				};
				// Real workflow assignments cannot fall back to the legacy ensure /
				// submit pair. Interactive non-workflow callers retain that protocol.
				const managed = Boolean(
					ctx.assignment.workflowId ||
						ctx.environment.HERDR_WORKFLOW_ID ||
						ctx.claim,
				);
				if (managed && !ctx.claim)
					throw new Error(
						"Managed launch requires a committed claim and background server; inspect workflow status before dispatch.",
					);
				const requestId = promptRequestId(
					ctx.assignment.runId,
					ctx.rendered.prompt,
				);
				const ensured = ctx.claim
					? await client.admitWorkflowRun({
							...request,
							claim: ctx.claim,
							text: ctx.rendered.prompt,
							requestId,
						})
					: await client.ensureRun(request);
				if (!managed)
					await client.submit(
						ctx.assignment.runId,
						ctx.rendered.prompt,
						requestId,
						"followUp",
					);
				const retryTargetLease = registerHostRetryTarget(
					ctx.assignment.runId,
					ensured.conversationId,
					layout.socketPath,
				);
				// Ordinary authenticated admission outlives its launcher process.
				// A fresh launcher cannot restore the private parked-task capability
				// without restarting the host; successful admission must not require it.
				const handle: AgentHandle = {
					runtime: this.id,
					name: ctx.name,
					hostSocket: layout.socketPath,
					sessionId: ctx.assignment.runId,
					conversationId: ensured.conversationId,
					...(retryTargetLease ? { retryTargetLease } : {}),
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
				const client = await recoveredDurableClient(handle);
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
				try {
					const client = await recoveredDurableClient(handle);
					const result = await client.status(handle.sessionId);
					return { status: result.status, sessionId: handle.sessionId };
				} catch {
					return { status: "unknown" as const };
				}
			},
			catch: toError,
		});
	}

	stop(
		handle: AgentHandle,
		_signal?: AbortSignal,
		claim?: LaunchClaim,
	): Effect.Effect<void, Error> {
		return Effect.tryPromise({
			try: async () => {
				if (!handle.hostSocket || !handle.sessionId) return;
				const { authenticatedHostClient, ensureHostRunning } = await import(
					"../agent-host/client.ts"
				);
				const { hostLayout } = await import("../agent-host/layout.ts");
				const runtimeDir = path.dirname(path.dirname(handle.hostSocket));
				const entry = selfExecEntry();
				// Even an unseen run needs a durable stop tombstone. A dead host is
				// restarted only through ordinary ownership-checked startup, never
				// through privileged capability reattachment or busy-host takeover.
				await ensureHostRunning(hostLayout(runtimeDir), {
					command: process.execPath,
					args: [
						...(entry ? [entry] : []),
						"agent",
						"host",
						"--workflow-dir",
						runtimeDir,
					],
					cwd: path.dirname(runtimeDir),
				});
				const client = authenticatedHostClient(handle.hostSocket);
				if (claim) await client.fenceStoppedRun({ ...claim, intent: "stop" });
				else await client.stopRun(handle.sessionId);
				if (handle.conversationId) {
					const { unregisterHostRetryTarget } = await import(
						"../agent-host/retry-authority.ts"
					);
					unregisterHostRetryTarget(
						handle.sessionId,
						handle.conversationId,
						handle.retryTargetLease,
					);
				}
			},
			catch: toError,
		});
	}
}

function toError(error: unknown): Error {
	if (error instanceof HostLaunchVerificationError)
		return error.retryable
			? new TransientFailure(error.message)
			: new PermanentFailure(error.message);
	if (error instanceof HostUnavailableError)
		return new TransientFailure(error.message);
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

/** Resolve both a dead host and a restarted host whose in-memory run map is
 * empty. Do not re-submit an assignment or retry an ambiguous submission. */
async function recoveredDurableClient(handle: AgentHandle) {
	const { authenticatedHostClient } = await import("../agent-host/client.ts");
	const client = authenticatedHostClient(requireDurableSocket(handle));
	try {
		if ((await client.status(requireDurableRunId(handle))).status !== "unknown")
			return client;
	} catch {
		// A missing socket and an empty run map use the same validated recovery.
	}
	const { recoverDurableHandle } = await import("../agent-host/recovery.ts");
	const recovered = await recoverDurableHandle(handle);
	return authenticatedHostClient(recovered.hostSocket);
}

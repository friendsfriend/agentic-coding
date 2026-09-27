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
import type { RenderedAssignment } from "./assignment.ts";
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
		const tools = ctx.profile.tools;
		if (tools.length) args.push("--tools", tools.join(","));
		else if (
			ctx.profile.readOnly ||
			ctx.profile.capabilities.includes("read-only")
		)
			args.push("--tools", "read");
		if (
			ctx.profile.readOnly ||
			ctx.profile.capabilities.includes("read-only") ||
			ctx.profile.extensions.length === 0
		)
			args.push("--no-extensions");
		for (const extension of ctx.profile.extensions)
			args.push("--extension", extension);
		if (ctx.workflowExtensionPath)
			args.push("--extension", ctx.workflowExtensionPath);
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

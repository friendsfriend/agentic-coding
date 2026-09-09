import fs from "node:fs";
import path from "node:path";
import { Effect, Either } from "effect";
import { decodeHerdrResult } from "../herdr-client.ts";
import type { RenderedAssignment } from "./assignment.ts";
import type {
	AgentHandle,
	Assignment,
	ResolvedProfile,
	RuntimeId,
} from "./contracts.ts";
import * as H from "./herdr-schema.ts";
import {
	closeSecureDirectory,
	openSecureDirectory,
	writeAtomicPrivateFile,
} from "./secure-fs.ts";

export interface HerdrPort {
	call(...args: string[]): unknown;
	callAsync?(args: string[], signal?: AbortSignal): Promise<unknown>;
}
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
export interface AgentObservation {
	status: "idle" | "working" | "blocked" | "done" | "unknown";
	paneId: string;
	sessionId?: string;
}
/** Workflow-facing agent lifecycle boundary (migrate-workflow-execution-to-effect
 * task 2.2/3.1). Methods are Effect operations; the underlying Herdr CLI and
 * subprocesses remain the foreign API boundary. Successfully launched agents,
 * adopted panes, and created workspaces belong to the durable workflow and
 * intentionally outlive a runner drain — nothing here tears them down on
 * ordinary scope exit. */
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
function agent(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || !("agent" in value))
		throw new Error("Herdr returned no agent");
	const item = (value as { agent: unknown }).agent;
	if (!item || typeof item !== "object")
		throw new Error("Herdr returned invalid agent");
	return item as Record<string, unknown>;
}
function requireExecutable(executable: string): string {
	const resolved = path.isAbsolute(executable)
		? executable
		: Bun.which(executable);
	if (!resolved || !fs.existsSync(resolved))
		throw new Error(`configured runtime executable not found: ${executable}`);
	return fs.realpathSync(resolved);
}
const SHELL_NAMES = new Set([
	"sh",
	"bash",
	"dash",
	"zsh",
	"fish",
	"ksh",
	"mksh",
	"csh",
	"tcsh",
	"elvish",
	"xonsh",
	"nu",
	"pwsh",
	"powershell",
	"cmd",
]);
/** Effect acquisition around the shared Herdr port: ownership loss aborts the
 * underlying call, and Herdr failures surface as classified `Error`s. */
export function herdrCallEffect(
	herdr: HerdrPort,
	args: string[],
	signal?: AbortSignal,
): Effect.Effect<unknown, Error> {
	return Effect.tryPromise({
		try: () =>
			herdr.callAsync
				? herdr.callAsync(args, signal)
				: Promise.resolve(herdr.call(...args)),
		catch: (error) =>
			error instanceof Error ? error : new Error(String(error)),
	});
}
export class HerdrLifecycle {
	constructor(
		private readonly herdr: HerdrPort,
		private readonly sleep: (ms: number) => Effect.Effect<void> = (ms) =>
			Effect.sleep(ms),
		private readonly signal?: AbortSignal,
	) {}
	private call(
		args: string[],
		signal = this.signal,
	): Effect.Effect<unknown, Error> {
		const herdr = this.herdr;
		return Effect.gen(function* () {
			if (signal?.aborted) throw new Error("effect ownership was lost");
			return yield* herdrCallEffect(herdr, args, signal);
		});
	}
	waitForShell(
		paneId: string,
		signal = this.signal,
	): Effect.Effect<void, Error> {
		const self = this;
		return Effect.gen(function* () {
			for (let attempt = 0; attempt < 50; attempt++) {
				const raw = yield* self.call(
					["pane", "process-info", "--pane", paneId],
					signal,
				);
				const result = decodeHerdrResult(H.processInfoResult, raw);
				const info = result.process_info;
				const foreground = info?.foreground_processes ?? [];
				// Match Herdr's Linux/macOS available-shell check. Linux can report zsh
				// alongside startup helpers; seeing zsh somewhere in that job is not ready.
				const foregroundName = String(
					foreground[0]?.name ?? foreground[0]?.argv?.[0] ?? "",
				)
					.split(/[\\/]/)
					.at(-1)
					?.replace(/^-/, "")
					.replace(/\.exe$/, "")
					.toLowerCase();
				const shellIsForeground =
					typeof info?.shell_pid === "number" &&
					info.foreground_process_group_id === info.shell_pid &&
					foreground.length === 1 &&
					foreground[0]?.pid === info.shell_pid &&
					SHELL_NAMES.has(foregroundName ?? "");
				if (shellIsForeground) return;
				yield* self.sleep(100);
			}
			throw new Error(`pane did not reach foreground shell: ${paneId}`);
		});
	}
	start(
		kind: "pi" | "opencode",
		ctx: LaunchContext,
		runtimeArgs: string[],
	): Effect.Effect<AgentHandle, Error> {
		const self = this;
		return Effect.gen(function* () {
			yield* self.waitForShell(ctx.paneId, ctx.signal);
			// herdr 0.8.0 has no agent-level env flag and spawns agents through the pane
			// shell, so the run environment must be injected into the pane first. Source
			// a 0600 env file (secrets stay out of the terminal scrollback), then keep a
			// shell alive with the exported vars for `agent start` to inherit.
			const envFile = path.join(
				ctx.runDirectory ?? path.join(ctx.cwd, ".herdr-workflow"),
				"runtime-bin",
				ctx.assignment.runId,
				"run.env",
			);
			const directory = openSecureDirectory(
				path.dirname(envFile),
				ctx.runDirectory ?? ctx.cwd,
			);
			try {
				const lines = Object.entries(ctx.environment)
					.filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
					.map(([key, value]) => `${key}=${shQuote(value)}`);
				writeAtomicPrivateFile(
					directory,
					path.basename(envFile),
					`${lines.join("\n")}\n`,
					0o600,
				);
			} finally {
				closeSecureDirectory(directory);
			}
			// pane run is asynchronous and waitForShell cannot tell the pre-injection
			// shell from the exec'd one; a marker touched after sourcing proves the
			// env landed before `agent start` inherits it.
			const marker = `${envFile}.done`;
			yield* Effect.sync(() => fs.rmSync(marker, { force: true }));
			yield* self.call(
				[
					"pane",
					"run",
					ctx.paneId,
					`set -a; . ${shQuote(envFile)}; set +a; touch ${shQuote(marker)}; exec "${"$"}{SHELL:-sh}"`,
				],
				ctx.signal,
			);
			for (let attempt = 0; attempt < 50 && !fs.existsSync(marker); attempt++) {
				if (ctx.signal?.aborted) throw new Error("effect ownership was lost");
				yield* self.sleep(100);
			}
			if (!fs.existsSync(marker))
				throw new Error(
					`run environment injection did not land in pane: ${ctx.paneId}`,
				);
			yield* self.waitForShell(ctx.paneId, ctx.signal);
			const invoke = () =>
				self.call(
					[
						"agent",
						"start",
						ctx.name,
						"--kind",
						kind,
						"--pane",
						ctx.paneId,
						"--",
						...runtimeArgs,
					],
					ctx.signal,
				);
			let invokeOutcome = yield* Effect.either(invoke());
			if (
				Either.isLeft(invokeOutcome) &&
				String(invokeOutcome.left?.message ?? "").includes(
					"not an available shell",
				)
			) {
				yield* self.sleep(250);
				yield* self.waitForShell(ctx.paneId, ctx.signal);
				invokeOutcome = yield* Effect.either(invoke());
			}
			const result = Either.isLeft(invokeOutcome)
				? yield* Effect.fail(invokeOutcome.left)
				: invokeOutcome.right;
			const started = agent(result);
			const paneId = String(started.pane_id ?? ctx.paneId);
			const live = agent(
				yield* self.call(["agent", "get", paneId], ctx.signal),
			);
			if (String(live.pane_id) !== paneId)
				throw new Error(`agent get mismatch for ${paneId}`);
			yield* self.call(
				["agent", "prompt", paneId, ctx.rendered.prompt],
				ctx.signal,
			);
			return {
				runtime: ctx.profile.runtime,
				name: ctx.name,
				paneId,
				...(live.tab_id ? { tabId: String(live.tab_id) } : {}),
				...(live.session_id ? { sessionId: String(live.session_id) } : {}),
			};
		});
	}
	prompt(
		handle: AgentHandle,
		message: string,
		signal = this.signal,
	): Effect.Effect<void, Error> {
		const self = this;
		return Effect.gen(function* () {
			agent(yield* self.call(["agent", "get", handle.paneId], signal));
			yield* self.call(["agent", "prompt", handle.paneId, message], signal);
		});
	}
	observe(
		handle: AgentHandle,
		signal = this.signal,
	): Effect.Effect<AgentObservation, Error> {
		const self = this;
		return Effect.gen(function* () {
			const live = agent(
				yield* self.call(["agent", "get", handle.paneId], signal),
			);
			const observed = String(live.agent_status ?? "unknown");
			const status = ["idle", "working", "blocked", "done"].includes(observed)
				? (observed as AgentObservation["status"])
				: "unknown";
			return {
				status,
				paneId: handle.paneId,
				...(live.session_id ? { sessionId: String(live.session_id) } : {}),
			};
		});
	}
	stop(handle: AgentHandle, signal = this.signal): Effect.Effect<void, Error> {
		return this.call(["pane", "close", handle.paneId], signal);
	}
}
abstract class BaseAdapter implements AgentAdapter {
	abstract readonly id: RuntimeId;
	constructor(protected readonly lifecycle: HerdrLifecycle) {}
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
		return this.lifecycle.prompt(handle, message, signal);
	}
	observe(handle: AgentHandle, signal?: AbortSignal) {
		return this.lifecycle.observe(handle, signal);
	}
	stop(handle: AgentHandle, signal?: AbortSignal) {
		return this.lifecycle.stop(handle, signal);
	}
}
export class PiAdapter extends BaseAdapter {
	readonly id = "pi" as const;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		const args = ["--name", ctx.name, "--no-prompt-templates"];
		if (ctx.profile.model) args.push("--model", ctx.profile.model);
		if (ctx.profile.thinking) args.push("--thinking", ctx.profile.thinking);
		if (ctx.assignment.stepId === "core.research") {
			if (
				!ctx.profile.readOnly ||
				!ctx.profile.capabilities.includes("read-only") ||
				ctx.profile.capabilities.includes("shell") ||
				ctx.profile.capabilities.includes("edit")
			)
				throw new Error("research requires a read-only profile");
			args.push("--tools", "read", "--no-extensions");
		} else {
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
		}
		if (ctx.workflowExtensionPath)
			args.push("--extension", ctx.workflowExtensionPath);
		if (ctx.bridgePath) args.push("--extension", ctx.bridgePath);
		return this.lifecycle.start("pi", withRuntimeLauncher(ctx, "pi"), args);
	}
}
export class OpenCodeAdapter extends BaseAdapter {
	readonly id = "opencode" as const;
	launch(ctx: LaunchContext): Effect.Effect<AgentHandle, Error> {
		const args: string[] = ["--auto"];
		if (ctx.profile.model) args.push("--model", ctx.profile.model);
		if (ctx.profile.agent) args.push("--agent", ctx.profile.agent);
		return this.lifecycle.start(
			"opencode",
			withOpenCodeLauncher(isolatedOpenCode(ctx)),
			args,
		);
	}
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
						ctx.assignment.stepId === "core.research" ||
						ctx.profile.readOnly ||
						ctx.profile.capabilities.includes("read-only")
							? { edit: "deny", bash: "deny", read: "allow" }
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
		return this.lifecycle.start(
			"opencode",
			withOpenCodeLauncher(isolatedOpenCode(ctx)),
			args,
		);
	}
}

// Script infrastructure lifecycle
// (`port-environment-runtimes-to-bun`, task 4.4).
//
// Ported from `server/pkg/operations/{service,script_lifecycle}.go` — the script
// half of the operations service: starting a script service logged or in a tmux
// window, reporting its status and execution handle, adopting tmux windows a
// previous process left, and stopping what it started.
//
// Two rules are load-bearing:
//
//   - **observation is the process's, not a cached flag.** A status read checks
//     the pane/process it launched; a window that disappeared or a process that
//     exited reports `stopped`/`failed` instead of a remembered `running`.
//   - **only what this owner started is stopped.** A stop kills the tracked pane
//     or process tree, and adoption only takes windows named for the configured
//     service (`devenv - infra - <ident>`), so a user's tmux windows are never
//     touched.

import type { ProcessHandle, ProcessStore } from "../actions/process.ts";
import { killProcessTree } from "../actions/process-group.ts";

export const INFRA_STATUS = {
	running: "running",
	stopped: "stopped",
	failed: "failed",
} as const;

export const SCRIPT_RUNNER = {
	shell: "shell",
	powerShell: "powershell",
} as const;

export type ScriptRunner = (typeof SCRIPT_RUNNER)[keyof typeof SCRIPT_RUNNER];

/** The tmux window name prefix script infrastructure uses. */
export const INFRA_WINDOW_PREFIX = "devenv - infra - ";

export interface ScriptExecutionHandle {
	mode: string;
	paneId?: string;
	pid?: number;
	runner: string;
	exitCode?: number;
	startedAt: string;
}

export interface ScriptStatus {
	status: string;
	logPath: string;
	executionHandle?: ScriptExecutionHandle;
}

interface ScriptRun {
	mode: "logged" | "tmux";
	runner: string;
	paneId?: string;
	pid?: number;
	logPath: string;
	startedAt: string;
}

export interface CommandResult {
	readonly output: string;
	readonly error?: Error;
}

export interface ScriptInfrastructureOptions {
	/** The managed-process store the action engine tracks long-lived work in. */
	readonly store?: ProcessStore;
	/** Runs one argv; injectable so the lifecycle is testable without tmux. */
	readonly runCommand: (
		command: string,
		args: readonly string[],
	) => Promise<CommandResult>;
	readonly env?: Record<string, string | undefined>;
	readonly now?: () => Date;
	readonly logger?: (message: string) => void;
}

/**
 * Tracks the script services this process started. The action engine launches a
 * script service as a managed process (`process` step with a `handleKey`); this
 * owner decides *how* (logged or tmux window) and reports what happened.
 */
export class ScriptInfrastructure {
	private readonly runs = new Map<string, ScriptRun>();
	private readonly terminal = new Map<string, ScriptStatus>();
	private readonly store?: ProcessStore;
	private readonly runCommand: ScriptInfrastructureOptions["runCommand"];
	private readonly env: Record<string, string | undefined>;
	private readonly now: () => Date;
	private readonly logger?: (message: string) => void;

	constructor(options: ScriptInfrastructureOptions) {
		this.store = options.store;
		this.runCommand = options.runCommand;
		this.env = options.env ?? process.env;
		this.now = options.now ?? (() => new Date());
		this.logger = options.logger;
	}

	/** Whether a script service should launch in a tmux window, as Go decided. */
	tmuxMode(): boolean {
		return (this.env.TMUX ?? "").trim() !== "";
	}

	/**
	 * Launches one script service. `logged` spawns the command directly; `tmux`
	 * opens a named window whose pane the status read then observes.
	 */
	async launch(input: {
		readonly ident: string;
		readonly runner: string;
		readonly command: string;
		readonly args: readonly string[];
		readonly dir?: string;
		readonly logPath?: string;
		readonly spawn: () => { pid?: number };
	}): Promise<ScriptStatus> {
		const logPath = input.logPath ?? "";
		if (this.tmuxMode()) {
			const windowName = `${INFRA_WINDOW_PREFIX}${input.ident}`;
			const result = await this.runCommand("tmux", [
				"new-window",
				"-P",
				"-F",
				"#{window_id}:#{pane_pid}",
				"-n",
				windowName,
				...(input.dir ? ["-c", input.dir] : []),
				input.command,
				...input.args,
			]);
			if (!result.error) {
				const { windowId, pid } = parseTmuxWindowAndPid(result.output);
				if (windowId !== "") {
					const run: ScriptRun = {
						mode: "tmux",
						runner: input.runner,
						paneId: windowId,
						...(pid > 0 ? { pid } : {}),
						logPath,
						startedAt: this.now().toISOString(),
					};
					this.runs.set(input.ident, run);
					this.terminal.delete(input.ident);
					// The window we just opened is the evidence of a successful
					// launch; a status read would immediately probe the pane.
					return {
						status: INFRA_STATUS.running,
						logPath,
						executionHandle: executionHandle(run),
					};
				}
			}
			this.logger?.(
				`[script] tmux window unavailable for ${input.ident}; running logged`,
			);
		}
		const spawned = input.spawn();
		this.runs.set(input.ident, {
			mode: "logged",
			runner: input.runner,
			...(spawned.pid === undefined ? {} : { pid: spawned.pid }),
			logPath,
			startedAt: this.now().toISOString(),
		});
		this.terminal.delete(input.ident);
		return this.status(input.ident);
	}

	/** Records the terminal state a finished process reported. */
	noteExit(ident: string, exitCode: number | undefined, logPath: string): void {
		const run = this.runs.get(ident);
		if (!run) return;
		const failed = exitCode !== undefined && exitCode !== 0;
		this.runs.delete(ident);
		this.terminal.set(ident, {
			status: failed ? INFRA_STATUS.failed : INFRA_STATUS.stopped,
			logPath: logPath === "" ? run.logPath : logPath,
			executionHandle: {
				mode: run.mode,
				...(run.paneId === undefined ? {} : { paneId: run.paneId }),
				...(run.pid === undefined ? {} : { pid: run.pid }),
				runner: run.runner,
				...(exitCode === undefined ? {} : { exitCode }),
				startedAt: run.startedAt,
			},
		});
	}

	/**
	 * The service's live status. A tmux run is checked against its pane; a logged
	 * run against its process; a run whose observation fails is `stopped`, not a
	 * remembered `running`.
	 */
	async status(ident: string): Promise<ScriptStatus> {
		const run = this.runs.get(ident);
		if (!run) {
			return (
				this.terminal.get(ident) ?? {
					status: INFRA_STATUS.stopped,
					logPath: "",
				}
			);
		}
		if (run.mode === "tmux") {
			const result = await this.runCommand("tmux", [
				"display-message",
				"-p",
				"-t",
				run.paneId ?? "",
				"#{window_id}:#{pane_pid}",
			]);
			if (result.error) {
				this.runs.delete(ident);
				this.terminal.set(ident, { status: INFRA_STATUS.stopped, logPath: "" });
				return { status: INFRA_STATUS.stopped, logPath: "" };
			}
			const { pid } = parseTmuxWindowAndPid(result.output);
			if (pid > 0) run.pid = pid;
			if (run.pid !== undefined && run.pid > 0 && !processAlive(run.pid)) {
				this.runs.delete(ident);
				this.terminal.set(ident, { status: INFRA_STATUS.stopped, logPath: "" });
				return { status: INFRA_STATUS.stopped, logPath: "" };
			}
			return {
				status: INFRA_STATUS.running,
				logPath: "",
				executionHandle: executionHandle(run),
			};
		}
		const handle = this.store?.get(ident);
		if (!handle && run.pid !== undefined && !processAlive(run.pid)) {
			this.runs.delete(ident);
			this.terminal.set(ident, {
				status: INFRA_STATUS.stopped,
				logPath: run.logPath,
			});
			return { status: INFRA_STATUS.stopped, logPath: run.logPath };
		}
		return {
			status: INFRA_STATUS.running,
			logPath: run.logPath,
			executionHandle: executionHandle(run),
		};
	}

	/** The handle a status read publishes, without running an observation. */
	executionHandle(ident: string): ScriptExecutionHandle | undefined {
		const run = this.runs.get(ident);
		if (run) return executionHandle(run);
		return this.terminal.get(ident)?.executionHandle;
	}

	/** Stops what this owner started; an untracked service is already stopped. */
	async stop(ident: string): Promise<void> {
		const run = this.runs.get(ident);
		if (!run) return;
		this.runs.delete(ident);
		if (run.mode === "tmux") {
			await this.runCommand("tmux", ["kill-window", "-t", run.paneId ?? ""]);
			return;
		}
		this.store?.delete(ident);
		if (run.pid !== undefined && run.pid > 0) {
			// The script's own children are what must stop, not just the wrapper.
			killProcessTree(run.pid);
		}
	}

	/**
	 * Adopts the tmux windows a previous process left, so a restarted server
	 * reports a script service that is still running instead of starting a second
	 * copy. Only windows named for a configured script service are adopted.
	 */
	async adopt(
		services: readonly { readonly ident: string; readonly type?: string }[],
	): Promise<number> {
		if (!this.tmuxMode()) return 0;
		const result = await this.runCommand("tmux", [
			"list-windows",
			"-a",
			"-F",
			"#{window_id}:#{window_name}:#{pane_pid}",
		]);
		if (result.error) return 0;
		const known = new Map(
			services
				.filter((service) => service.type === "script")
				.map((service) => [service.ident, service]),
		);
		let adopted = 0;
		for (const line of result.output.split("\n")) {
			const { windowId, windowName, pid } = parseTmuxWindowLine(line);
			if (windowId === "" || !windowName.startsWith(INFRA_WINDOW_PREFIX))
				continue;
			const ident = windowName.slice(INFRA_WINDOW_PREFIX.length).trim();
			const service = known.get(ident);
			if (!service) continue;
			if (pid > 0 && !processAlive(pid)) continue;
			if (this.runs.has(ident)) continue;
			this.runs.set(ident, {
				mode: "tmux",
				runner: SCRIPT_RUNNER.shell,
				paneId: windowId,
				...(pid > 0 ? { pid } : {}),
				logPath: "",
				startedAt: this.now().toISOString(),
			});
			adopted++;
		}
		return adopted;
	}

	/** Identifiers this owner is currently tracking, for diagnostics and tests. */
	tracked(): string[] {
		return [...this.runs.keys()];
	}
}

function executionHandle(run: ScriptRun): ScriptExecutionHandle {
	return {
		mode: run.mode,
		...(run.paneId === undefined ? {} : { paneId: run.paneId }),
		...(run.pid === undefined ? {} : { pid: run.pid }),
		runner: run.runner,
		startedAt: run.startedAt,
	};
}

/** Parses `window_id:window_name:pane_pid` from `tmux list-windows`. */
export function parseTmuxWindowLine(line: string): {
	windowId: string;
	windowName: string;
	pid: number;
} {
	const parts = line.trim().split(":");
	if (parts.length === 0 || parts[0].trim() === "") {
		return { windowId: "", windowName: "", pid: 0 };
	}
	if (parts.length === 2) {
		return {
			windowId: parts[0].trim(),
			windowName: "",
			pid: parseLeadingInt(parts[1]),
		};
	}
	return {
		windowId: parts[0].trim(),
		windowName: parts.slice(1, -1).join(":").trim(),
		pid: parseLeadingInt(parts[parts.length - 1]),
	};
}

/** Parses `window_id:pane_pid`, the format `new-window -F` prints. */
export function parseTmuxWindowAndPid(output: string): {
	windowId: string;
	pid: number;
} {
	const parsed = parseTmuxWindowLine(output);
	return { windowId: parsed.windowId, pid: parsed.pid };
}

function parseLeadingInt(text: string): number {
	const match = text.trim().match(/^-?\d+/);
	return match ? Number.parseInt(match[0], 10) : 0;
}

/** Whether a pid still exists; signal 0 only probes existence. */
export function processAlive(pid: number): boolean {
	if (pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The log path a script service uses when it has none configured. */
export function defaultScriptLogPath(configDir: string, ident: string): string {
	return `${configDir}/logs/infrastructure/${ident}.log`;
}

/** The process handle a tracked run publishes to the process store. */
export function scriptProcessHandle(run: {
	mode: string;
	pid?: number;
	paneId?: string;
	startedAt: string;
}): ProcessHandle {
	return {
		mode: run.mode,
		...(run.pid === undefined ? {} : { pid: run.pid }),
		...(run.paneId === undefined ? {} : { paneId: run.paneId }),
		startedAt: run.startedAt,
	};
}

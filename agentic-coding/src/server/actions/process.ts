// Long-lived managed processes (`port-action-execution-to-bun`, task 2.6).
//
// Ported from `server/pkg/actionexec/process.go`.
//
// A managed process outlives the action context: a kubectl port-forward or a dev
// server must not die when the action's deadline passes. This handler therefore
// spawns without a signal and tracks the process in the store, which is what
// recovery and cancellation use to address it later.
import type { ActionStepDefinition } from "@devenv/types";
import type { ScriptInfrastructure } from "../runtime/script-infrastructure.ts";
import type { CommandEventSink } from "./command.ts";
import { endpointExports } from "./command.ts";
import { killProcessTree } from "./process-group.ts";

/** The script lifecycle owner a managed process defers its launch to. */
export type ScriptInfraLauncher = Pick<
	ScriptInfrastructure,
	"launch" | "noteExit"
>;

import type { HandlerContext, StepResult } from "./step-result.ts";
import { OUTCOME } from "./step-result.ts";
import { VALUE_TYPE_ENDPOINT } from "./values.ts";

export interface ProcessHandle {
	mode: string;
	pid?: number;
	paneId?: string;
	startedAt: string;
}

export interface ProcessStore {
	put(key: string, handle: ProcessHandle): void;
	get(key: string): ProcessHandle | undefined;
	delete(key: string): void;
}

export class MemoryProcessStore implements ProcessStore {
	readonly #handles = new Map<string, ProcessHandle>();

	put(key: string, handle: ProcessHandle): void {
		this.#handles.set(key, handle);
	}

	get(key: string): ProcessHandle | undefined {
		return this.#handles.get(key);
	}

	delete(key: string): void {
		this.#handles.delete(key);
	}

	/** Terminates every tracked process and everything it started. */
	killAll(): void {
		const handles = [...this.#handles.values()];
		this.#handles.clear();
		for (const handle of handles) {
			if (!handle.pid || handle.pid <= 0) continue;
			// A managed process is usually a wrapper (`sh -c`, a port-forward
			// supervisor), so cancelling only the direct child would leak its
			// children.
			killProcessTree(handle.pid);
		}
	}
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function parseEnv(entries: readonly string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of entries) {
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		env[entry.slice(0, separator)] = entry.slice(separator + 1);
	}
	return env;
}

/** A long-lived process this run started, tracked so it can be recovered. */
export class ProcessHandler {
	constructor(
		private readonly store?: ProcessStore,
		private readonly events?: CommandEventSink,
		private readonly scriptInfra?: ScriptInfraLauncher,
	) {}

	async execute(
		context: HandlerContext,
		step: ActionStepDefinition,
	): Promise<StepResult> {
		const configuration = step.configuration ?? {};
		const name = configuration.command;
		if (typeof name !== "string" || name === "") {
			return {
				outcome: OUTCOME.failed,
				error: new Error("command is required"),
			};
		}
		const args = stringList(configuration.args);
		const dir =
			typeof configuration.dir === "string" ? configuration.dir : undefined;
		const envEntries = stringList(configuration.env);
		const logPath =
			typeof configuration.logPath === "string"
				? configuration.logPath
				: undefined;
		const logFile = logPath
			? Bun.file(logPath).writer({ highWaterMark: 1024 * 1024 })
			: undefined;

		// Managed processes outlive the action execution context: spawning with a
		// signal would kill a port-forward when the action's deadline passes.
		const spawnProcess = () =>
			Bun.spawn([name, ...args], {
				...(dir ? { cwd: dir } : {}),
				...(envEntries.length > 0
					? { env: { ...process.env, ...parseEnv(envEntries) } }
					: {}),
				stdout: "pipe",
				stderr: "pipe",
			});
		const configuredKey =
			typeof configuration.handleKey === "string" &&
			configuration.handleKey !== ""
				? configuration.handleKey
				: undefined;
		const handleKey = configuredKey ?? step.id;
		// A script infrastructure service is launched by its own lifecycle owner
		// (logged, or a tmux window when the server runs inside tmux); every other
		// managed process is spawned directly.
		let proc: ReturnType<typeof spawnProcess> | undefined;
		if (this.scriptInfra && configuredKey !== undefined) {
			const launched = await this.scriptInfra.launch({
				ident: configuredKey,
				runner:
					typeof configuration.runner === "string"
						? configuration.runner
						: "shell",
				command: name,
				args,
				...(dir ? { dir } : {}),
				...(logPath ? { logPath } : {}),
				spawn: () => {
					proc = spawnProcess();
					return { pid: proc.pid };
				},
			});
			if (!proc) {
				// tmux mode: the pane is the handle, and no process was spawned.
				this.store?.put(handleKey, {
					mode: launched.executionHandle?.mode ?? "tmux",
					...(launched.executionHandle?.paneId
						? { paneId: launched.executionHandle.paneId }
						: {}),
					...(launched.executionHandle?.pid
						? { pid: launched.executionHandle.pid }
						: {}),
					startedAt:
						launched.executionHandle?.startedAt ?? new Date().toISOString(),
				});
				return { outcome: OUTCOME.executed };
			}
		}
		proc ??= spawnProcess();
		const handle: ProcessHandle = {
			mode: "process",
			pid: proc.pid,
			startedAt: new Date().toISOString(),
		};
		this.store?.put(handleKey, handle);

		const pump = async (
			stream: ReadableStream<Uint8Array> | undefined,
			streamName: "stdout" | "stderr",
		): Promise<void> => {
			if (!stream) return;
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				const text = decoder.decode(chunk, { stream: true });
				if (text === "") continue;
				this.events?.emitCommand({
					type: "command.output",
					stepId: step.id,
					stream: streamName,
					chunk: text,
				});
				if (logFile) logFile.write(text);
			}
		};
		// The output pumps and the exit bookkeeping run detached: the step's
		// result is "the process started", which is what readiness then gates.
		const exited = proc.exited;
		void Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")])
			.catch(() => undefined)
			.finally(async () => {
				this.store?.delete(handleKey);
				logFile?.end();
				// A script service reports its terminal state to the owner that
				// publishes infrastructure status.
				if (this.scriptInfra && configuredKey !== undefined) {
					this.scriptInfra.noteExit(configuredKey, await exited, logPath ?? "");
				}
			});

		for (const endpoint of endpointExports(configuration)) {
			context.values.set(`endpoint.${endpoint.name}`, {
				type: VALUE_TYPE_ENDPOINT,
				visibility: "public",
				data: endpoint,
			});
		}
		return { outcome: OUTCOME.executed };
	}
}

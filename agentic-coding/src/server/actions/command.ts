// Command steps: one process per executed command
// (`port-action-execution-to-bun`, tasks 2.3 and 2.4).
//
// Ported from `server/pkg/actionexec/command.go`.
//
// Every real process command gets exactly one leaf step owning its command,
// stdout, stderr, exit code and error. The handler never fabricates a command
// for work that did not run, never merges two commands into one step, and never
// decides the run's fate: it reports, the engine applies the failure policy.
import type { ActionStepDefinition } from "@devenv/types";
import { killProcessTree } from "./process-group.ts";
import type { HandlerContext, StepResult } from "./step-result.ts";
import { OUTCOME } from "./step-result.ts";
import {
	type EndpointValue,
	formatValue,
	resolveValueTemplates,
	VALUE_TYPE_ENDPOINT,
	type Value,
} from "./values.ts";

export interface CommandSpec {
	name: string;
	args: string[];
	/** Redacted argv for events and history; falls back to `args`. */
	displayArgs?: string[];
	dir?: string;
	env?: string[];
	/** Execution identity, preserved by a runner that forwards the command. */
	runId?: string;
	stepId?: string;
	commandId?: string;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	error?: Error;
}

export interface CommandRunner {
	run(
		spec: CommandSpec,
		output?: (stream: "stdout" | "stderr", chunk: string) => void,
		signal?: AbortSignal,
	): Promise<CommandResult>;
}

export interface CommandEvent {
	type: string;
	stepId: string;
	command?: string;
	args?: string[];
	stream?: "stdout" | "stderr";
	chunk?: string;
	exitCode?: number;
	error?: string;
}

export interface CommandEventSink {
	emitCommand(event: CommandEvent): void;
}

/** The error text Go's `os/exec` produces, which reaches `step.error`. */
function exitError(exitCode: number, signalCode: string | null): Error {
	if (signalCode) return new Error(`signal: ${signalCode}`);
	return new Error(`exit status ${exitCode}`);
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error) return reason;
	return new Error("context canceled");
}

/**
 * Runs one command to completion, buffering both streams and emitting them
 * afterwards, exactly like Go's `exec.Cmd.Run` with `bytes.Buffer`. A cancelled
 * signal kills the child and the result carries the abort reason.
 */
export class OSCommandRunner implements CommandRunner {
	async run(
		spec: CommandSpec,
		output?: (stream: "stdout" | "stderr", chunk: string) => void,
		signal?: AbortSignal,
	): Promise<CommandResult> {
		if (signal?.aborted) {
			return {
				stdout: "",
				stderr: "",
				exitCode: -1,
				error: abortError(signal),
			};
		}
		const env =
			spec.env && spec.env.length > 0
				? { ...process.env, ...parseEnv(spec.env) }
				: undefined;
		const proc = Bun.spawn([spec.name, ...spec.args], {
			...(spec.dir ? { cwd: spec.dir } : {}),
			...(env ? { env } : {}),
			stdout: "pipe",
			stderr: "pipe",
		});
		// Cancelling the command cancels what the command started: a `sh -c`
		// wrapper's children must not outlive the step.
		const onAbort = () => killProcessTree(proc.pid, { signal: "SIGKILL" });
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			await proc.exited;
			const signalCode = proc.signalCode ?? null;
			const exitCode = signalCode ? -1 : (proc.exitCode ?? -1);
			const result: CommandResult = { stdout, stderr, exitCode };
			if (signalCode) {
				result.error =
					signal?.aborted === true
						? abortError(signal)
						: exitError(exitCode, signalCode);
			} else if (exitCode !== 0) {
				result.error = exitError(exitCode, null);
			}
			// Both streams are reported after the command finishes, in the same
			// order Go's buffer flush produces them.
			if (output) {
				if (stdout !== "") output("stdout", stdout);
				if (stderr !== "") output("stderr", stderr);
			}
			return result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
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

export function commandSpec(
	configuration: Record<string, unknown>,
): CommandSpec {
	const name = configuration.command;
	if (typeof name !== "string" || name === "") {
		throw new Error("command is required");
	}
	return {
		name,
		args: stringList(configuration.args),
		...(configuration.displayArgs !== undefined
			? { displayArgs: stringList(configuration.displayArgs) }
			: {}),
		...(typeof configuration.dir === "string"
			? { dir: configuration.dir }
			: {}),
		...(configuration.env !== undefined
			? { env: stringList(configuration.env) }
			: {}),
	};
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Runs a `command` step: resolves its templates, executes it, emits the
 * lifecycle events, and publishes whatever the step's configuration says to
 * capture.
 */
export class CommandHandler {
	constructor(
		private readonly runner: CommandRunner = new OSCommandRunner(),
		private readonly events?: CommandEventSink,
	) {}

	async execute(
		context: HandlerContext,
		step: ActionStepDefinition,
	): Promise<StepResult> {
		const configuration = step.configuration ?? {};
		const values = context.values;
		let spec: CommandSpec;
		try {
			spec = commandSpec(configuration);
			// Identity first: a forwarded command must carry it even when
			// template resolution is what fails.
			spec.runId = context.runId;
			spec.stepId = step.id;
			spec.commandId = `${step.id}-command-0`;
			spec.args = resolveValueTemplates(values, spec.args);
			if (spec.env) {
				spec.env = resolveValueTemplates(values, spec.env);
			}
		} catch (error) {
			return { outcome: OUTCOME.failed, error: asError(error) };
		}

		const display = spec.displayArgs ?? spec.args;
		this.events?.emitCommand({
			type: "command.started",
			stepId: step.id,
			command: spec.name,
			args: [...display],
		});
		const result = await this.runner.run(
			spec,
			(stream, chunk) => {
				this.events?.emitCommand({
					type: "command.output",
					stepId: step.id,
					stream,
					chunk,
				});
			},
			context.signal,
		);
		if (result.error) {
			this.events?.emitCommand({
				type: "command.failed",
				stepId: step.id,
				exitCode: result.exitCode,
				error: result.error.message,
			});
		} else {
			this.events?.emitCommand({
				type: "command.completed",
				stepId: step.id,
				exitCode: result.exitCode,
			});
		}

		let error = result.error;
		if (error === undefined) {
			error = this.captureOutputs(context, configuration, result);
		}
		if (error) {
			return {
				outcome: OUTCOME.failed,
				exitCode: result.exitCode,
				error,
			};
		}
		return { outcome: OUTCOME.executed, exitCode: result.exitCode };
	}

	/** Publishes the step's declared outputs; the first failure aborts capture. */
	private captureOutputs(
		context: HandlerContext,
		configuration: Record<string, unknown>,
		result: CommandResult,
	): Error | undefined {
		const values = context.values;
		const exports = endpointExports(configuration);
		for (const endpoint of exports) {
			values.set(`endpoint.${endpoint.name}`, {
				type: VALUE_TYPE_ENDPOINT,
				visibility: "public",
				data: endpoint,
			});
		}
		const setValues = configuration.setValues;
		if (isRecord(setValues)) {
			for (const [key, data] of Object.entries(setValues)) {
				values.set(key, { type: "string", visibility: "internal", data });
			}
		}
		const label = configuration.captureJSONLabel;
		const captureKey = configuration.captureKey;
		if (typeof label === "string" && label !== "") {
			try {
				const parsed: unknown = JSON.parse(result.stdout.trim());
				if (!isRecord(parsed)) {
					throw new Error("captured JSON is not an object");
				}
				if (typeof captureKey === "string") {
					const data = parsed[label];
					values.set(captureKey, {
						type: "path",
						visibility: "internal",
						data: typeof data === "string" ? data : "",
					});
				}
			} catch (error) {
				return asError(error);
			}
		}
		const captureStdout = configuration.captureStdout;
		if (typeof captureStdout === "string" && captureStdout !== "") {
			const declared = configuration.captureType;
			const type =
				typeof declared === "string" && declared !== "" ? declared : "string";
			values.set(captureStdout, {
				type,
				visibility: "internal",
				data: result.stdout.trim(),
			});
		}
		return undefined;
	}
}

/**
 * A compiled definition carries endpoint exports as typed values. TypeScript has
 * no typed/untyped runtime distinction, so a JSON-shaped export is accepted too;
 * only the field names matter, and only a compiled definition ever reaches here.
 */
export function endpointExports(
	configuration: Record<string, unknown>,
): EndpointValue[] {
	const raw = configuration.endpointExports;
	if (!Array.isArray(raw)) return [];
	return raw.filter(isRecord).map((entry) => ({
		name: typeof entry.name === "string" ? entry.name : "",
		protocol: String(entry.protocol ?? ""),
		host: String(entry.host ?? ""),
		port: Number(entry.port ?? 0),
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export type { Value };
export { formatValue };

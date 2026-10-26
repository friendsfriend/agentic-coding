// The `bash` tool's wall-clock bound and its elapsed-time note (efficiency
// review step 3, item 2). One recursive `grep` ran 1,202 s — 41 % of a run — with
// no `timeout` argument and returned 50 bytes, and a repository-wide `find` from
// `/` ran 227 s the run before; both needed a developer to stop them. The
// `bash` tool has a `timeout` parameter and no default, so this module owns the
// one place the product supplies one: the durable host installs
// `boundedCodingTools()` instead of pi-durable's own `CodingTools`, which gives
// every runtime the product serves — a durable workflow run, a debug run and the
// orchestrator session — the same bound, the same override and the same result
// line. Nothing else in the product runs through this path with an expectation
// of unbounded runtime: the engine's own child commands carry their own
// timeouts (`src/workflow/process.ts`), and builds, test suites and servers go
// through `env_build`/`env_test`/`env_start`, which are not `bash` at all.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
	CodingTools,
	type createBashTool,
} from "@earendil-works/pi-durable/tools";
import { type ToolSurfaceOptions, toolSurfaceNote } from "./tool-surface.ts";

/** The wall-clock bound a `bash` call gets when the caller passes no `timeout`,
 * in seconds: long enough for a focused build or test command, short enough
 * that a recursive search can no longer eat a third of a run. */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 120;
/** Ceiling for a caller's own `timeout`, in seconds. A larger value is capped
 * rather than refused, so a runaway override can never be unbounded — while a
 * genuinely long command still has room (a container build, a cold dependency
 * install) once it asks for it. */
export const BASH_MAX_TIMEOUT_SECONDS = 3_600;
/** How long a call runs before its result carries the elapsed-time note. */
export const BASH_ELAPSED_NOTE_SECONDS = 60;

/** Bounds of one bounded `bash` tool. Every field is injectable so a test can
 * use a sub-second bound instead of sleeping. */
export interface BashBoundOptions {
	readonly defaultTimeoutSeconds?: number;
	readonly maxTimeoutSeconds?: number;
	readonly elapsedNoteSeconds?: number;
}

/** What the coding-tool registration takes: the bounds above plus whether this
 * run's tool set contains `codemode`, which only changes the `bash`
 * description's last sentence (tool-surface.ts). */
export interface BoundedCodingToolsOptions
	extends BashBoundOptions,
		ToolSurfaceOptions {}

/** The `timeout` one call runs with. The caller's own value always wins,
 * capped at the ceiling; an invalid value (not finite, or not positive) is
 * handed on unchanged so pi-durable's own validation produces its own message
 * rather than this module inventing a second one. */
export function bashTimeoutSeconds(
	requested: number | undefined,
	options: BashBoundOptions = {},
): number {
	const fallback =
		options.defaultTimeoutSeconds ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const ceiling = options.maxTimeoutSeconds ?? BASH_MAX_TIMEOUT_SECONDS;
	if (requested === undefined) return fallback;
	if (!Number.isFinite(requested) || requested <= 0) return requested;
	return Math.min(requested, ceiling);
}

/** A duration as a reader expects it: one decimal below ten seconds, whole
 * seconds above. */
function formatSeconds(value: number): string {
	const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
	return `${rounded} s`;
}

/**
 * The line a stopped call's result carries: what bound fired, how long the call
 * actually ran, and what to do instead. It is written for the model to act on —
 * scope the path, use the structured environment tools, or pass a larger
 * `timeout` — and deliberately says "stopped" rather than "aborted": the
 * tool-result failure vocabulary classifies a call by the first word it
 * recognizes, and an `aborted` reading would hide the `timeout` this is.
 */
export function bashTimeoutLine(
	boundSeconds: number,
	elapsedSeconds: number,
	options: BashBoundOptions = {},
): string {
	const ceiling = options.maxTimeoutSeconds ?? BASH_MAX_TIMEOUT_SECONDS;
	return [
		`bash: timed out after ${formatSeconds(boundSeconds)} (elapsed ${formatSeconds(elapsedSeconds)}); the command and its child processes were stopped and this is the output collected so far.`,
		`Scope the work instead of raising the bound: give a search a path inside the project and limit its depth (-maxdepth, --max-count), run long builds and test suites through env_build/env_test (servers through env_start) rather than bash, or pass \`timeout\` in seconds — up to ${ceiling} — for a command that genuinely needs longer.`,
	].join("\n");
}

/** The note a call that ran past {@link BASH_ELAPSED_NOTE_SECONDS} ends with.
 * The durable harness has no mid-call channel to the model — `api.output`
 * becomes the result content only when the call settles, and a diagnostic is
 * recorded on the result rather than streamed — so the elapsed time is reported
 * where it can actually reach the model, at the end of the call that ran long. */
export function bashElapsedLine(
	boundSeconds: number,
	elapsedSeconds: number,
): string {
	return `bash: this call ran ${formatSeconds(elapsedSeconds)} of its ${formatSeconds(boundSeconds)} bound; scope the command, or pass \`timeout\` in seconds when it genuinely needs longer.`;
}

/** pi-durable's `bash` registration, the shape this module replaces. */
export type BashTool = ReturnType<typeof createBashTool>;
type BashArgs = Parameters<BashTool["execute"]>[0];
type BashApi = Parameters<BashTool["execute"]>[1];

/** The parameters of the bounded tool: pi-durable's own two fields, with the
 * `timeout` description the model needs now that one has a default. */
function bashParameters(defaultSeconds: number, ceilingSeconds: number) {
	return Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description: `Timeout in seconds. A call that exceeds it is stopped and returns the output collected so far. Default ${defaultSeconds} when omitted; a larger value than ${ceilingSeconds} is capped at ${ceilingSeconds}.`,
			}),
		),
	});
}

/**
 * The run's execution environment with its `exec` observed: the environment's
 * own `ExecutionError` code `timeout` is the contract for "the bound stopped
 * this command", so the wrapper learns *why* a call ended without matching on
 * pi-durable's message text. Every other member is forwarded untouched.
 */
function observedEnv(env: ExecutionEnv, onTimeout: () => void): ExecutionEnv {
	return new Proxy(env, {
		get(target, property) {
			if (property !== "exec") return Reflect.get(target, property, target);
			return async (
				command: string,
				execOptions: Parameters<ExecutionEnv["exec"]>[1],
				context: Parameters<ExecutionEnv["exec"]>[2],
			) => {
				const result = await target.exec(command, execOptions, context);
				if (!result.ok && result.error.code === "timeout") onTimeout();
				return result;
			};
		},
	});
}

/**
 * pi-durable's `bash` tool with the bound applied. The tool's own `execute` is
 * still the one that runs the command — the command prefix, output spill,
 * truncation diagnostic, exit-code handling and result shape stay exactly
 * pi-durable's — and this wrapper only supplies the `timeout` the caller left
 * out, appends the bound's line to the result, and keeps the failure a
 * `timeout` one.
 */
export function createBoundedBashTool(
	base: BashTool,
	options: BoundedCodingToolsOptions = {},
): BashTool {
	const defaultSeconds =
		options.defaultTimeoutSeconds ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const ceiling = options.maxTimeoutSeconds ?? BASH_MAX_TIMEOUT_SECONDS;
	const noteSeconds = options.elapsedNoteSeconds ?? BASH_ELAPSED_NOTE_SECONDS;
	return {
		...base,
		description: [
			base.description,
			`The call is stopped after ${formatSeconds(defaultSeconds)} when no \`timeout\` is given; a \`timeout\` in seconds overrides that, up to ${formatSeconds(ceiling)}.`,
			"A stopped call returns the output collected so far and says so. Scope an expensive search to a path inside the project (with -maxdepth/--max-count) instead of the whole filesystem, and run long builds and test suites through env_build/env_test rather than bash.",
			// The inspection split and the batching rule where the shell is chosen
			// (efficiency backlog item 14); `codemode` only when this run has it.
			toolSurfaceNote(options),
		]
			.filter((part) => typeof part === "string" && part.length > 0)
			.join(" "),
		parameters: bashParameters(defaultSeconds, ceiling),
		async execute(args: BashArgs, api: BashApi, context) {
			const boundSeconds = bashTimeoutSeconds(args.timeout, options);
			const started = Date.now();
			let timedOut = false;
			// The last character emitted, so a line this wrapper appends starts on
			// its own line. Byte chunks are passed through without decoding: the
			// worst case is one extra blank line before the note.
			let tail = "";
			const elapsedSeconds = (): number => (Date.now() - started) / 1000;
			const appendLine = (line: string): void => {
				api.output(tail === "" || tail === "\n" ? `${line}\n` : `\n${line}\n`);
				tail = "\n";
			};
			const env = api.env;
			const delegated: BashApi = {
				...api,
				...(env === undefined
					? {}
					: {
							env: observedEnv(env, () => {
								timedOut = true;
							}),
						}),
				output: (chunk, skipped) => {
					if (typeof chunk === "string" && chunk.length > 0)
						tail = chunk.slice(-1);
					api.output(chunk, skipped);
				},
			};
			try {
				const result = await base.execute(
					{ ...args, timeout: boundSeconds },
					delegated,
					context,
				);
				if (elapsedSeconds() >= noteSeconds)
					appendLine(bashElapsedLine(boundSeconds, elapsedSeconds()));
				return result;
			} catch (error) {
				if (timedOut) {
					const line = bashTimeoutLine(boundSeconds, elapsedSeconds(), options);
					appendLine(line);
					// The thrown message is what the result records as the call's
					// failure: it carries the bound, so the call is classified a
					// `timeout` rather than an anonymous tool error.
					throw new Error(line);
				}
				if (elapsedSeconds() >= noteSeconds)
					appendLine(bashElapsedLine(boundSeconds, elapsedSeconds()));
				throw error;
			}
		},
	};
}

/**
 * pi-durable's coding tools with `bash` replaced by the bounded one, installed
 * by the host in place of `CodingTools`. Tool *selection* is by name, so the
 * read-only policy, a debug run's explicit list and the orchestrator's list all
 * resolve to this registration wherever they name `bash`.
 */
export function boundedCodingTools(
	options: BoundedCodingToolsOptions = {},
): Extension {
	const tools = (CodingTools.tools ?? []).map((tool) =>
		tool.name === "bash"
			? createBoundedBashTool(tool as BashTool, options)
			: tool,
	);
	return defineExtension({ name: "coding-tools", tools });
}

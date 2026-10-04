// Durable codemode (pi-durable-codemode-parity): a `codemode` tool that runs
// sandboxed JavaScript whose only capability is calling the run's own offered
// tools. It is an *additional* tool — the run keeps its direct tools — and the
// script's reach is exactly the tools this run was offered, so a read-only run
// cannot reach `write`/`edit` through a script.
//
// Built on `@earendil-works/pi-codemode` (the same sandbox pi's builtin
// `codemode` extension uses), not on pi-coding-agent's extension: that one is
// written against pi-coding-agent's own extension API, which pi-durable does
// not share.
import type { Context, JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
	type CodemodeJsonSchema,
	type CodemodeResult,
	CodemodeSandbox,
	type CodemodeTool,
	loadQuickJSWasm,
	parseCodemodeSource,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode";
import {
	defineExtension,
	defineTool,
	type Extension,
	section,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { codemodeWasmPath, codemodeWorkerUrl } from "./codemode-assets.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** Overall deadline for one script, including time spent in its tool calls.
 * The script can override it with a `// @options:` line. */
const DEFAULT_TIMEOUT_MS = 300_000;

const CodemodeParameters = Type.Object({
	code: Type.String({ description: "Raw JavaScript source." }),
});

const CODEMODE_DESCRIPTION = [
	"Run JavaScript that calls this run's other tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS sandbox: top-level `await` and `return` work. No Node, file system, network, or timers.",
	"- `await tools.<name>({ ...args })` resolves to the tool's text output as a string, and rejects with an Error when the call fails. Calls still running when the script ends are cancelled.",
	'- Optional first line: `// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}`',
	"Globals:",
	"- `text(value)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script.",
	"- `store(key, value)` and `load(key)` keep JSON values across codemode calls in this run.",
	"- `ALL_TOOLS` lists the tools this script can call.",
].join("\n");

/** A durable `codemode` extension plus the tool it registers, so the host can
 * put the tool in a read-only run's explicit tool selection. */
export interface DurableCodemode {
	readonly extension: Extension;
	readonly tool: ToolRegistration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Tool-result content as one string (the value a script's call resolves to:
 * our tools declare no output schema, so text is the whole result). */
function contentToText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			isRecord(part) && part.type === "text" && typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n");
}

/** One offered tool as the script sees it. The nested call runs the tool's own
 * `execute` through a wrapper of the outer invocation's API, so validation and
 * the tool's environment are the same; `output`/`details`/`diagnostic` are
 * captured locally so a nested call never pollutes the codemode call's result. */
/** One call a script made, as the host served it: the sandbox records the name,
 * status and duration but not the arguments, so the wrapper adds them. The
 * arguments are JSON, since the sandbox hands tools their JSON round trip. */
interface RecordedCall {
	readonly name: string;
	readonly args: JsonValue;
}

function nestedTool(
	tool: ToolRegistration,
	api: ToolExecutionApi,
	context: Context,
	recorded: RecordedCall[],
): CodemodeTool {
	return {
		name: tool.name,
		...(tool.description ? { description: tool.description } : {}),
		inputSchema: tool.parameters as CodemodeJsonSchema,
		execute: async (rawArgs) => {
			// The sandbox pushes its own record as the call starts, so the
			// wrapper's records line up with `result.calls` by position.
			recorded.push({ name: tool.name, args: rawArgs as JsonValue });
			let captured = "";
			let details: unknown;
			const nested: ToolExecutionApi = {
				...api,
				callId: `${api.callId}:${tool.name}`,
				output: (chunk) => {
					captured +=
						typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				},
				diagnostic: () => {},
				details: async (value) => {
					details = value;
				},
			};
			const result = await tool.execute(rawArgs as never, nested, context);
			const text = result.content ? contentToText(result.content) : captured;
			if (result.isError) throw new Error(text.trim() || `${tool.name} failed`);
			return details !== undefined ? details : text;
		},
	};
}

function textResult(text: string, isError = false): ToolExecutionResult {
	return {
		content: [{ type: "text", text }],
		...(isError ? { isError: true } : {}),
	};
}

/** The model-facing result: the script's output items, its return value, and
 * the calls it made, headed by whether it completed. The calls also travel as
 * structured details — with the arguments the sandbox does not record — so the
 * dashboard can show what each call actually did. */
function formatResult(
	result: CodemodeResult,
	recorded: readonly RecordedCall[],
): ToolExecutionResult {
	const output = result.output.flatMap((item) =>
		item.type === "text" ? [item.text] : [],
	);
	const lines = [result.ok ? "Script completed" : "Script failed"];
	if (result.ok && result.value !== undefined)
		lines.push(`return: ${JSON.stringify(result.value)}`);
	lines.push(...output);
	if (!result.ok) lines.push(`Script error: ${result.error.message}`);
	if (result.calls.length > 0)
		lines.push(
			`calls: ${result.calls
				.map((call) => `${call.name} (${call.status})`)
				.join(", ")}`,
		);
	return {
		...textResult(lines.join("\n"), !result.ok),
		details: {
			calls: result.calls.map((call, index) => ({
				name: call.name,
				status: call.status,
				durationMs: call.durationMs,
				...(recorded[index] ? { args: recorded[index]?.args ?? null } : {}),
			})),
		},
	};
}

/** The durable `codemode` tool. Enablement is the host's decision (global pi
 * settings); this only builds the tool and its prompt section. */
export function createDurableCodemode(): DurableCodemode {
	// `store()`/`load()` values, keyed by conversation: the sandbox is created
	// per call, so the extension owns the persistence across calls in one run.
	const stores = new Map<string, Record<string, unknown>>();

	const tool = defineTool({
		name: CODEMODE_TOOL_NAME,
		description: CODEMODE_DESCRIPTION,
		parameters: CodemodeParameters,
		execute: async (args, api, context) => {
			let offered: readonly ToolRegistration[];
			try {
				offered = (await api.agent(context)).tools;
			} catch (error) {
				return textResult(
					`codemode: could not resolve this run's tools (${errorMessage(error)})`,
					true,
				);
			}
			const callable = offered.filter(
				(entry) => entry.name !== CODEMODE_TOOL_NAME,
			);
			const recorded: RecordedCall[] = [];
			let parsed: ReturnType<typeof parseCodemodeSource>;
			try {
				parsed = parseCodemodeSource(args.code);
			} catch (error) {
				return textResult(
					`codemode: invalid script (${errorMessage(error)})`,
					true,
				);
			}
			const workerUrl = codemodeWorkerUrl();
			let sandbox: CodemodeSandbox;
			try {
				sandbox = new CodemodeSandbox({
					tools: callable.map((entry) =>
						nestedTool(entry, api, context, recorded),
					),
					wasm: await loadQuickJSWasm(codemodeWasmPath()),
					timeoutMs: DEFAULT_TIMEOUT_MS,
					...(workerUrl ? { workerUrl } : {}),
				});
			} catch (error) {
				// The compiled binary embeds the wasm and worker; a build that could
				// not must report the tool unavailable rather than fail the run.
				return textResult(
					`codemode: the sandbox is unavailable in this build (${errorMessage(error)})`,
					true,
				);
			}
			const key = String(api.conversationId);
			const store = stores.get(key) ?? {};
			let result: CodemodeResult;
			try {
				result = await sandbox.execute(parsed.code, {
					...(parsed.options.timeoutMs !== undefined
						? { timeoutMs: parsed.options.timeoutMs }
						: {}),
					...(context.abortSignal ? { signal: context.abortSignal } : {}),
					store,
				});
			} finally {
				void sandbox.close().catch(() => undefined);
			}
			if (result.ok) {
				const next: Record<string, unknown> = {
					...store,
					...result.storeWrites.set,
				};
				for (const deleted of result.storeWrites.delete) delete next[deleted];
				stores.set(key, next);
			}
			return formatResult(result, recorded);
		},
	});

	const extension = defineExtension({
		name: "agentic.codemode",
		tools: [tool],
		sections: [
			// pi-durable has no per-request tool description, so the calling
			// convention and the callable tool list live in a prompt section
			// rendered from the request's own offered tools.
			section("codemode", (input) => {
				if (
					!input.agent.tools.some((entry) => entry.name === CODEMODE_TOOL_NAME)
				)
					return undefined;
				const callable = input.agent.tools.filter(
					(entry) => entry.name !== CODEMODE_TOOL_NAME,
				);
				if (callable.length === 0) return undefined;
				return [
					"codemode runs JavaScript that calls this run's tools as `tools.<name>(args)`. Use it to batch independent calls or chain a search → read → filter pipeline in one call; keep a single call, every edit, and the handoff direct. Available:",
					...callable.map(
						(entry) =>
							`- tools.${toCodemodeIdentifier(entry.name)}: ${entry.description ?? entry.name}`,
					),
				].join("\n");
			}),
		],
	});

	return { extension, tool };
}

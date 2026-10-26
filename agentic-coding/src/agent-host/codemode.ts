// The durable host uses pi-durable's native codemode extension as its sole
// sandbox and nested-call executor. This module only supplies the host's
// embedded sandbox assets, a default deadline, and the dashboard's live call
// projection; all discovery, replay, store/load and execution stay upstream.
import type { JsonValue } from "@earendil-works/chord";
import { CodemodeSandbox, loadQuickJSWasm } from "@earendil-works/pi-codemode";
import type {
	Extension,
	ToolExecutionApi,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import {
	createCodemodeExtension,
	CODEMODE_TOOL_NAME as NATIVE_CODEMODE_TOOL_NAME,
} from "@earendil-works/pi-durable/codemode";
import { codemodeWasmPath, codemodeWorkerUrl } from "./codemode-assets.ts";
import { createProgressPublisher } from "./progress-publisher.ts";
import { BATCHING_RULE, CODEMODE_PIPELINE } from "./tool-surface.ts";

export const CODEMODE_TOOL_NAME = NATIVE_CODEMODE_TOOL_NAME;

/** The maximum wall-clock time for one script unless it has its own options. */
export const CODEMODE_DEFAULT_TIMEOUT_MS = 300_000;

/** The maximum number of nested calls retained for live and final details. */
const MAX_RECORDED_CALLS = 50;
const MAX_CALL_OUTPUT_CHARS = 4_000;
const MAX_CALL_ARGUMENT_CHARS = 4_000;
const MAX_CALL_DETAILS_CHARS = 4_000;
const MAX_NATIVE_DETAILS_CHARS = 8_000;
const MAX_DETAIL_DEPTH = 6;
const MAX_DETAIL_ITEMS = 32;
const MAX_DETAIL_NODES = 256;

/** The native catalog estimates four characters per token. Leave room for its
 * headings within the shared 7.5 KiB prompt-section budget. */
const CODEMODE_INLINE_BUDGET = 1_800;

/** A nested call as shown in the host's codemode detail panel. */
interface RecordedCall {
	readonly name: string;
	readonly args: JsonValue;
	output: string;
	isError: boolean;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	details?: JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Convert native output without materializing an unbounded nested result. */
export function valueToText(value: unknown): string {
	if (typeof value === "string") return boundedText(value);
	if (Array.isArray(value)) {
		const chunks: string[] = [];
		let length = 0;
		let inspected = 0;
		let omitted = false;
		for (const part of value) {
			if (inspected >= MAX_DETAIL_ITEMS) {
				omitted = true;
				break;
			}
			inspected += 1;
			if (
				!isRecord(part) ||
				part.type !== "text" ||
				typeof part.text !== "string"
			)
				continue;
			const separator = chunks.length === 0 ? "" : "\n";
			const available = MAX_CALL_OUTPUT_CHARS - length - separator.length;
			if (available <= 0) {
				omitted = true;
				break;
			}
			chunks.push(`${separator}${part.text.slice(0, available)}`);
			length += separator.length + Math.min(part.text.length, available);
			if (part.text.length > available) {
				omitted = true;
				break;
			}
		}
		let text = chunks.join("");
		if (omitted) {
			const marker = "…[output truncated]";
			text = `${text.slice(0, MAX_CALL_OUTPUT_CHARS - marker.length)}${marker}`;
		}
		return text;
	}
	if (value === undefined) return "";
	try {
		return boundedPrefixText(
			JSON.stringify(boundedJson(value, MAX_CALL_OUTPUT_CHARS)) ?? "",
		);
	} catch {
		return "[unserializable output]";
	}
}

function boundedText(value: string): string {
	if (value.length <= MAX_CALL_OUTPUT_CHARS) return value;
	const marker = "[earlier output omitted]\n";
	return `${marker}${value.slice(-(MAX_CALL_OUTPUT_CHARS - marker.length))}`;
}

function boundedPrefixText(value: string): string {
	if (value.length <= MAX_CALL_OUTPUT_CHARS) return value;
	const marker = "…[truncated]";
	return `${value.slice(0, MAX_CALL_OUTPUT_CHARS - marker.length)}${marker}`;
}

/** Keep structured arguments and details useful while bounding both their
 * serialized size and the work needed to project them into live progress. */
function boundedJsonValue(
	value: unknown,
	budget: { remaining: number },
	depth = 0,
	nodes: { remaining: number } = { remaining: MAX_DETAIL_NODES },
): JsonValue {
	if (budget.remaining <= 0 || nodes.remaining <= 0) return "[details omitted]";
	nodes.remaining -= 1;
	if (depth >= MAX_DETAIL_DEPTH) {
		budget.remaining = Math.max(0, budget.remaining - 24);
		return "[nested details omitted]";
	}
	if (typeof value === "string") {
		if (value.length <= budget.remaining) {
			budget.remaining -= value.length;
			return value;
		}
		const marker = "…[truncated]";
		const text = `${value.slice(0, Math.max(0, budget.remaining - marker.length))}${marker}`;
		budget.remaining = 0;
		return text;
	}
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		budget.remaining = Math.max(0, budget.remaining - 16);
		return value;
	}
	if (Array.isArray(value)) {
		const result: JsonValue[] = [];
		for (const item of value) {
			if (result.length >= MAX_DETAIL_ITEMS || budget.remaining <= 0) {
				result.push("[additional items omitted]");
				break;
			}
			result.push(boundedJsonValue(item, budget, depth + 1, nodes));
		}
		return result;
	}
	if (isRecord(value)) {
		const result: Record<string, JsonValue> = {};
		let retained = 0;
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			if (retained >= MAX_DETAIL_ITEMS || budget.remaining <= 0) {
				result.detailsOmitted = true;
				break;
			}
			if (key === "__proto__") continue;
			const boundedKey = key.slice(0, 128);
			budget.remaining = Math.max(0, budget.remaining - boundedKey.length - 4);
			result[boundedKey] = boundedJsonValue(
				value[key],
				budget,
				depth + 1,
				nodes,
			);
			retained += 1;
		}
		return result;
	}
	budget.remaining = Math.max(0, budget.remaining - 32);
	return String(value).slice(0, 32);
}

function boundedJson(value: unknown, maxChars: number): JsonValue {
	return boundedJsonValue(value, { remaining: maxChars });
}

function recordedCallValue(call: RecordedCall): Record<string, JsonValue> {
	return {
		name: call.name,
		args: call.args,
		output: call.output,
		isError: call.isError,
		status: call.status,
		...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
		...(call.details === undefined ? {} : { details: call.details }),
	};
}

function textContent(value: unknown): string {
	return valueToText(value);
}

/** Wrap only the result/progress boundary. The native tool remains responsible
 * for tool discovery, sandbox work, nested task ownership, and replay. */
function withHostPresentation(tool: ToolRegistration): ToolRegistration {
	const execute = tool.execute;
	return {
		...tool,
		description: [
			String(tool.description ?? ""),
			`- ${CODEMODE_PIPELINE}.`,
			`- ${BATCHING_RULE}.`,
		]
			.filter(Boolean)
			.join("\n"),
		execute: async (args, api, context) => {
			const agent = await api.agent(context);
			const allowed = new Set(
				agent.callable
					.map((entry) => entry.name)
					.filter((name) => name !== CODEMODE_TOOL_NAME),
			);
			const recorded: RecordedCall[] = [];
			const omittedCalls = { count: 0 };
			const progress = createProgressPublisher(
				() => ({
					calls: recorded.map(recordedCallValue),
					omittedCalls: omittedCalls.count,
				}),
				(snapshot) => api.details(snapshot as JsonValue, context),
			);
			const markCancelledCalls = () => {
				if (!context.abortSignal?.aborted) return;
				let changed = false;
				for (const call of recorded) {
					if (call.status !== "running") continue;
					call.isError = false;
					call.status = "cancelled";
					call.output ||= "Cancelled";
					changed = true;
				}
				if (changed) progress.request();
			};
			const observedApi: ToolExecutionApi = {
				...api,
				executeTool: async (name, nestedArgs, nestedContext, options) => {
					const record: RecordedCall | undefined =
						recorded.length < MAX_RECORDED_CALLS
							? {
									name,
									args: boundedJson(nestedArgs, MAX_CALL_ARGUMENT_CHARS),
									output: "",
									isError: false,
									status: "running",
								}
							: undefined;
					if (record) recorded.push(record);
					else omittedCalls.count += 1;
					progress.request();
					const started = Date.now();
					try {
						if (!allowed.has(name))
							throw new Error(
								`Tool ${name} is not available to this run's codemode script`,
							);
						const result = await api.executeTool(
							name,
							nestedArgs,
							nestedContext,
							options,
						);
						const diagnostics = result.diagnostics
							.filter((diagnostic) => diagnostic.severity === "error")
							.map((diagnostic) => diagnostic.message)
							.join("\n");
						if (record) {
							record.output = boundedText(
								valueToText(result.structuredOutput) || diagnostics,
							);
							record.isError = result.isError === true;
							record.status = record.isError ? "error" : "ok";
							if (result.details !== undefined)
								record.details = boundedJson(
									result.details,
									MAX_CALL_DETAILS_CHARS,
								);
						}
						return result;
					} catch (error) {
						if (record) {
							record.isError = true;
							record.status = context.abortSignal?.aborted
								? "cancelled"
								: "error";
							record.output = boundedText(errorMessage(error));
						}
						throw error;
					} finally {
						if (record) record.durationMs = Date.now() - started;
						progress.request();
					}
				},
			};

			try {
				const result = await execute(args, observedApi, context);
				markCancelledCalls();
				const nativeDetails = isRecord(result.details) ? result.details : {};
				const nativeCalls = Array.isArray(nativeDetails.calls)
					? nativeDetails.calls
					: [];
				const retainedCount = Math.min(
					MAX_RECORDED_CALLS,
					Math.max(nativeCalls.length, recorded.length),
				);
				const calls = Array.from({ length: retainedCount }, (_, index) => {
					const nativeCall = boundedJson(
						nativeCalls[index],
						MAX_CALL_DETAILS_CHARS,
					);
					return {
						...(isRecord(nativeCall) ? nativeCall : {}),
						...(recorded[index] ? recordedCallValue(recorded[index]) : {}),
					};
				});
				const nativeMetadata: Record<string, unknown> = {};
				for (const key in nativeDetails) {
					if (
						Object.hasOwn(nativeDetails, key) &&
						key !== "calls" &&
						key !== "output"
					)
						nativeMetadata[key] = nativeDetails[key];
				}
				const boundedMetadata = boundedJson(
					nativeMetadata,
					MAX_NATIVE_DETAILS_CHARS,
				);
				return {
					...result,
					details: {
						...(isRecord(boundedMetadata) ? boundedMetadata : {}),
						output: boundedText(textContent(result.output)),
						calls,
						omittedCalls: Math.max(
							omittedCalls.count,
							nativeCalls.length - retainedCount,
						),
					},
				};
			} finally {
				markCancelledCalls();
				try {
					await progress.flush();
				} finally {
					progress.dispose();
				}
			}
		},
	};
}

/** A native codemode extension plus its registered tool for hosts whose
 * read-only selection explicitly names tools, and its sandbox shutdown hook. */
export interface DurableCodemode {
	readonly extension: Extension;
	readonly tool: ToolRegistration;
	readonly close: () => Promise<void>;
}

/** Enablement remains the host's decision (the user's global Pi settings). */
export function createDurableCodemode(): DurableCodemode {
	const sandbox = new CodemodeSandbox({
		wasm: loadQuickJSWasm(codemodeWasmPath()),
		...(codemodeWorkerUrl() ? { workerUrl: codemodeWorkerUrl() } : {}),
	});
	const start = sandbox.start.bind(sandbox);
	// The native extension uses start() for durable replay; that API otherwise
	// defaults to no deadline, unlike this host's previous five-minute bound.
	sandbox.start = (code, options) =>
		start(code, {
			...options,
			timeoutMs: options.timeoutMs ?? CODEMODE_DEFAULT_TIMEOUT_MS,
		});

	const native = createCodemodeExtension({
		sandbox,
		models: false,
		inlineBudget: CODEMODE_INLINE_BUDGET,
	});
	const nativeTool = native.tools?.find(
		(entry) => entry.name === CODEMODE_TOOL_NAME,
	);
	if (!nativeTool)
		throw new Error("The native codemode extension did not register codemode");
	const tool = withHostPresentation(nativeTool);
	const extension: Extension = {
		...native,
		name: "agentic.codemode",
		tools: native.tools?.map((entry) =>
			entry.name === CODEMODE_TOOL_NAME ? tool : entry,
		),
	};
	return { extension, tool, close: () => sandbox.close() };
}

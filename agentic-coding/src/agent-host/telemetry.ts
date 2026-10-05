// Runtime telemetry envelopes for a durable conversation (durable-agent-
// tools: "Runtime telemetry envelopes"). Mirrors
// `agent-definitions/bridges/pi-telemetry.ts`'s envelope shape (schema
// version 1, layer "runtime") but is driven by pi-durable's own
// `watchEvents()` agent-event stream instead of pi extension hooks, and
// tags every envelope `runtime: "pi-durable"`.
import fs from "node:fs";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	type AgentEvent,
	type ConversationId,
	type Harness,
	watchEvents,
} from "@earendil-works/pi-durable";

export interface TelemetryIdentity {
	readonly workflowId?: string;
	readonly runId?: string;
	readonly stepId?: string;
	readonly role?: string;
	readonly profile?: string;
	readonly telemetryPath?: string;
	readonly captureContent?: boolean;
}

const SECRET_PATTERN =
	/(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;
function redact(text: string): string {
	return text.replace(SECRET_PATTERN, "[REDACTED]");
}
const CONTENT_LIMIT = 8192;

function emit(
	identity: TelemetryIdentity,
	event: string,
	fields: Record<string, unknown> = {},
): void {
	const envelope = {
		schemaVersion: 1,
		at: new Date().toISOString(),
		layer: "runtime",
		runtime: "pi-durable",
		event,
		workflowId: identity.workflowId,
		runId: identity.runId,
		stepId: identity.stepId,
		role: identity.role,
		profile: identity.profile,
		...fields,
	};
	const output = identity.telemetryPath;
	if (output) {
		try {
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.appendFileSync(output, `${JSON.stringify(envelope)}\n`);
		} catch {
			/* observational only */
		}
	}
	const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (endpoint) {
		void fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(envelope),
			signal: AbortSignal.timeout(750),
		}).catch(() => undefined);
	}
}

/** Wall-clock timing of one committed assistant entry, measured from the
 * agent-event stream: pi-durable records no generation start/end, so this is
 * the only source for a real duration or token rate. */
export interface EntryTiming {
	/** `message_start` → `message_end` for the assistant response. */
	readonly generationMs?: number;
	/** `thinking_start` → the first text/tool-call block (or the message end). */
	readonly thinkingMs?: number;
}

/** Attach agent-event telemetry for one conversation; returns a stop
 * function. Best-effort: a failure to attach must never fail the run it
 * would have been observing. `onTiming` additionally receives each committed
 * assistant entry's measured wall-clock timing. */
export async function attachTelemetry(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
	identity: TelemetryIdentity,
	onTiming?: (entryId: string, timing: EntryTiming) => void,
): Promise<() => void> {
	const stream = await watchEvents(harness, conversationId, context);
	let generationStart: number | undefined;
	let thinkingStart: number | undefined;
	let thinkingMs = 0;
	const closeThinking = (now: number) => {
		if (thinkingStart === undefined) return;
		thinkingMs += Math.max(0, now - thinkingStart);
		thinkingStart = undefined;
	};
	const handle = (events: readonly AgentEvent[]) => {
		for (const event of events) {
			const now = Date.now();
			switch (event.type) {
				case "message_start":
					if ((event.message as { role?: string }).role === "assistant") {
						generationStart = now;
						thinkingMs = 0;
						thinkingStart = undefined;
					}
					break;
				case "message_update":
					for (const change of event.changes) {
						if (change.type === "thinking_start") thinkingStart = now;
						else if (
							change.type === "text_start" ||
							change.type === "toolcall_start"
						)
							closeThinking(now);
					}
					break;
				case "message_end": {
					closeThinking(now);
					const entry = event.entry;
					const assistant =
						entry.kind === "pi.assistant" &&
						entry.model?.[0]?.role === "assistant"
							? entry.model[0]
							: undefined;
					const generationMs =
						generationStart !== undefined
							? Math.max(0, now - generationStart)
							: undefined;
					if (assistant && onTiming) {
						onTiming(String(entry.id), {
							...(generationMs !== undefined ? { generationMs } : {}),
							...(thinkingMs > 0 ? { thinkingMs } : {}),
						});
					}
					// One usage envelope per committed assistant message: cost, the
					// provider's token counters and the measured generation duration are
					// what the dashboard's per-agent metrics (cost, tok/s) aggregate, and
					// they persist in `telemetry.jsonl` for long-term monitoring. A message
					// whose provider reported nothing is not emitted, so the panel omits
					// metrics instead of showing zero placeholders.
					if (assistant) {
						const usage = assistant.usage;
						const cost = usage.cost?.total ?? 0;
						const tokens =
							usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
						if (tokens > 0 || cost > 0)
							emit(identity, "runtime.usage", {
								inputTokens: usage.input,
								outputTokens: usage.output,
								cacheReadTokens: usage.cacheRead,
								cacheWriteTokens: usage.cacheWrite,
								totalTokens: usage.totalTokens,
								cost,
								...(generationMs !== undefined
									? { durationMs: generationMs }
									: {}),
							});
					}
					generationStart = undefined;
					thinkingMs = 0;
					break;
				}
				case "turn_start":
					emit(identity, "runtime.turn_started");
					break;
				case "tool_execution_start":
					emit(identity, "runtime.tool_start", {
						"pi.tool.name": event.toolName,
						"pi.tool.call_id": event.toolCallId,
						...(identity.captureContent
							? {
									"herdr.content.tool_input": redact(
										JSON.stringify(event.args),
									).slice(0, CONTENT_LIMIT),
								}
							: {}),
					});
					break;
				case "tool_execution_end": {
					const isError = event.entry === undefined;
					emit(identity, "runtime.tool", {
						outcome: isError ? "error" : "ok",
						"pi.tool.name": event.toolName,
						"pi.tool.call_id": event.toolCallId,
						"pi.tool.outcome": isError ? "error" : "ok",
					});
					break;
				}
				case "run_end":
					emit(identity, "runtime.settled");
					break;
				case "task_failed":
					emit(identity, "runtime.task_failed", {
						"pi.error.class": redact(event.message).slice(0, 160),
					});
					break;
				default:
					break;
			}
		}
	};
	stream.start(async (events) => handle(events));
	return () => {
		void stream.stop();
	};
}

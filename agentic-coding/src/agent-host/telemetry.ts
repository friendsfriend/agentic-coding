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
import { telemetryWorkspaceRemoved } from "../workflow/observability.ts";
import {
	classifyToolFailure,
	type ToolFailureKind,
	toolArgsTelemetry,
	toolFailureLine,
	toolResultTelemetry,
} from "./tool-telemetry.ts";

export interface TelemetryIdentity {
	readonly workflowId?: string;
	readonly runId?: string;
	readonly stepId?: string;
	readonly role?: string;
	readonly profile?: string;
	/** The run's generation (its attempt counter), when the run environment
	 * carries one: the index a later analysis needs to tell a re-launched run
	 * from its predecessors. */
	readonly generation?: number;
	readonly telemetryPath?: string;
	readonly captureContent?: boolean;
}

const SECRET_PATTERN =
	/(-----BEGIN[\s\S]*?-----END[^\n]*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|github_pat_[A-Za-z0-9_]{20,}|HERDR_RUN_TOKEN=[^\s]+)/g;
function redact(text: string): string {
	return text.replace(SECRET_PATTERN, "[REDACTED]");
}
const CONTENT_LIMIT = 8192;

/** Write one runtime envelope for `identity`'s run: to that run's telemetry
 * file, and to the OTLP receiver when the session exports there. Returns
 * whether the envelope reached the file: the session window's `closed` record is
 * the one envelope a reader treats as proof, so its writer has to be able to say
 * that the append happened. */
function emitEnvelope(
	identity: TelemetryIdentity,
	event: string,
	fields: Record<string, unknown> = {},
): boolean {
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
		...(identity.generation !== undefined
			? { "herdr.run.generation": identity.generation }
			: {}),
		...fields,
	};
	const output = identity.telemetryPath;
	let written = false;
	// The run environment pins this path inside the run's own worktree. That
	// worktree is removed when the workflow closes, and a session that outlives it
	// (or an event that lands after the removal) must not recreate it: the leftover
	// directory would make the next workflow on the same branch fail
	// `workspace.setup` with `fatal: '<path>' already exists`.
	if (output && !telemetryWorkspaceRemoved(path.dirname(output))) {
		try {
			fs.mkdirSync(path.dirname(output), { recursive: true });
			fs.appendFileSync(output, `${JSON.stringify(envelope)}\n`);
			written = true;
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
	return written;
}

/** Emit one content-free runtime envelope from a tool boundary, using the
 * session's own run environment instead of a conversation handle (the
 * orchestrator tools have no `Harness`). Best-effort like every other
 * observation here: a session with no telemetry path and no OTLP endpoint
 * records nothing rather than failing the tool it was measuring. */
export function emitToolTelemetry(
	env: Readonly<Record<string, string>>,
	event: string,
	fields: Record<string, unknown> = {},
): boolean {
	return emitEnvelope(
		{
			workflowId: env.HERDR_WORKFLOW_ID,
			runId: env.HERDR_RUN_ID,
			stepId: env.HERDR_STEP_ID,
			role: env.HERDR_ROLE,
			profile: env.HERDR_PROFILE,
			telemetryPath: env.HERDR_TELEMETRY_PATH,
		},
		event,
		fields,
	);
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

/** Why a compaction ran, as the analysis needs to count it (efficiency backlog
 * item 6). pi-durable knows `manual`, `threshold` and `overflow`; the cost
 * ceiling is the host's own proactive path, so it is named here and reported by
 * the host through {@link TelemetryHooks.compactionKind}. */
export type CompactionKind = "auto-ceiling" | "auto-overflow" | "manual";

/** The measurement hooks a host may attach alongside the envelopes. All of them
 * are optional: telemetry is observational, and a host that passes none still
 * records the same envelopes it always did. */
export interface TelemetryHooks {
	/** Measured wall-clock timing of one committed assistant entry. */
	readonly onTiming?: (entryId: string, timing: EntryTiming) => void;
	/** The context size one committed assistant message carried, with the turn it
	 * belongs to and the identity that message was recorded under. The cost ceiling
	 * is decided from this measurement, against the ceiling of the run named here
	 * rather than the run that created the conversation. */
	readonly onMeasuredContext?: (
		info: {
			readonly promptTokens: number;
			readonly turnIndex: number;
		},
		identity: TelemetryIdentity,
	) => void;
	/** The kind of a compaction, for one the host admitted itself (`auto-ceiling`).
	 * Undefined means pi-durable started it, and its own reason decides. */
	readonly compactionKind?: (taskId: string) => CompactionKind | undefined;
	/** One observation per finished tool call (the dead-surface rule), with the
	 * identity of the run that *started* that call: a call whose turn began under
	 * one run stays that run's even if the conversation was rebound before the
	 * outcome arrived, so a late failure can never be charged to a later run. */
	readonly onToolOutcome?: (
		observation: ToolOutcomeObservation,
		identity: TelemetryIdentity,
	) => void;
}

/** The task kind of pi-durable's built-in compaction task. */
const COMPACTION_TASK_KIND = "pi.compaction";

/** One compaction followed through the event stream, so its envelope can carry
 * the measured duration, the token movement and an outcome. pi-durable records
 * no counters for a compaction, so both token numbers are measured from the
 * conversation's own assistant usage: the newest request's prompt tokens before
 * the compaction started, and the first one after it ended. */
interface TrackedCompaction {
	reason: string;
	blocking: boolean;
	/** The counted kind: whether the host admitted it for cost or pi-durable did. */
	kind: CompactionKind;
	attempts: number;
	startedAt: number;
	tokensBefore?: number;
	/** Set when the compaction's status disappeared: the task finished. */
	endedAt?: number;
	/** Set once a `pi.compaction` entry was appended, i.e. a summary was placed. */
	summaryPlaced?: boolean;
	/** Set when the task failed, with a bounded error class. */
	failedClass?: string;
	/** Set when the envelope was emitted, so it is emitted exactly once. */
	emitted?: boolean;
}

/** Prompt tokens of one usage, i.e. the context size that request carried. */
function promptTokens(usage: {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** One runtime envelope from a host that already holds the identity (the cost
 * ceiling reports its decisions this way). Best-effort like every other
 * observation: an unwritable telemetry file records nothing rather than failing
 * the run it was measuring. */
export function emitRuntimeEnvelope(
	identity: TelemetryIdentity,
	event: string,
	fields: Record<string, unknown> = {},
): boolean {
	return emitEnvelope(identity, event, fields);
}

/** Why a conversation was bound to a run: `created` (the conversation was made
 * for this run), `rebound` (an existing conversation whose previous run is
 * known), `adopted` (an existing conversation whose previous run this host
 * cannot name, as after a restart) or `resumed` (the same run bound again, as
 * after an abort). */
export type SessionWindowReason = "created" | "rebound" | "adopted" | "resumed";

/** The two session-window envelopes (efficiency backlog item 20: a run's window
 * is its session's window). The run window is the engine's — `started_at` to
 * the run's `agent.handoff` — and keeps its meaning; these state the window of
 * the *session* that served the run, so a turn a conversation emits after its
 * run closed is a recorded continuation rather than an unexplained window
 * error. Additive and observational: no workflow state, no store field, no
 * schema change, and neither envelope closes a run or a session. */
export type SessionWindowEvent =
	| "runtime.session_window.opened"
	| "runtime.session_window.closed";

/** Emit one session-window envelope on the run binding it names. Both events
 * carry the conversation id as `herdr.session.conversation_id`, never as the
 * envelope's `sessionId`: that field means *run* id everywhere else
 * (`src/server/telemetry-parser.ts` maps it to `herdr.session.id`), and one
 * attribute must not carry two identifier spaces. Best-effort like every other
 * observation here — but the return value lets the host retry a `closed` record
 * that could not be written, which a reader treats as proof of a continuation. */
export function emitSessionWindow(
	conversationId: ConversationId,
	event: SessionWindowEvent,
	identity: TelemetryIdentity,
	fields: Record<string, unknown> = {},
): boolean {
	return emitRuntimeEnvelope(identity, event, {
		"herdr.session.conversation_id": String(conversationId),
		...fields,
	});
}

/** One finished tool call, as the run supervisor of a dead surface (see
 * `fail-fast.ts`) needs it: what the call was, whether it succeeded, and — for
 * a failure — its machine-readable kind and one bounded error line. */
export interface ToolOutcomeObservation {
	readonly tool: string;
	readonly ok: boolean;
	readonly kind?: ToolFailureKind;
	readonly turn?: number;
	/** One redacted, bounded line of the failure's own text, when it had any. */
	readonly errorLine?: string;
}

/** Attach agent-event telemetry for one conversation; returns a stop
 * function. Best-effort: a failure to attach must never fail the run it
 * would have been observing. `hooks` carries the measurements the host also
 * uses (`onTiming` for the dashboard's tok/s, `onMeasuredContext` for the cost
 * ceiling, `onToolOutcome` for the dead-surface rule: one observation per
 * finished tool call, which must not throw: an observer's failure is not the
 * run's), so one event stream serves all of them.
 *
 * `identity` is the run's identity, or a getter for the one current now: a
 * conversation outlives the run that created it, and the host passes a getter so
 * a later run's events are that run's (see `host.ts`'s session binding). A plain
 * identity means "this stream belongs to one run". */
export async function attachTelemetry(
	harness: Harness,
	conversationId: ConversationId,
	context: Context,
	identity: TelemetryIdentity | (() => TelemetryIdentity),
	hooks: TelemetryHooks = {},
): Promise<() => void> {
	const stream = await watchEvents(harness, conversationId, context);
	// One stream can outlive the run that created it: a later run of the same
	// step and role is served by the same conversation, so the identity is
	// resolved at each emission and every envelope carries the run that was
	// working when it was written — not the run that created the conversation.
	const identityOf = (): TelemetryIdentity =>
		typeof identity === "function" ? identity() : identity;
	const emit = (event: string, fields: Record<string, unknown> = {}): void => {
		emitEnvelope(identityOf(), event, fields);
	};
	let generationStart: number | undefined;
	let thinkingStart: number | undefined;
	let thinkingMs = 0;
	let lastPromptTokens: number | undefined;
	const compactions = new Map<string, TrackedCompaction>();
	// Every tool call of this conversation: its measured duration, the turn it
	// belongs to and the argument digest, so the end envelope can carry the
	// fields that make the call measurable (tool-call telemetry shape).
	const toolCalls = new Map<
		string,
		{ startedAt: number; turnIndex: number | undefined }
	>();
	// The run that started each in-flight tool call. A rebinding moves the
	// conversation, not the call, so the outcome is charged to the run that began
	// it (the dead-surface rule must never stop a run for another run's call).
	const callOwners = new Map<string, TelemetryIdentity>();
	/** `turn_start` events seen so far; -1 while the conversation has not started
	 * a turn, so a call before the first turn records no index rather than 0. */
	let turnIndex = -1;
	/** The largest context this conversation carried, by the provider's own
	 * prompt counters: the number the run-completion envelope reports so a
	 * ceiling's effect is measurable after the fact. */
	let peakContextTokens = 0;
	/** Compactions by kind, counted once each when they start. */
	const compactionKinds: Record<CompactionKind, number> = {
		"auto-ceiling": 0,
		"auto-overflow": 0,
		manual: 0,
	};
	/** The kind of one compaction: the host names its own ceiling admissions,
	 * everything else is pi-durable's reason (`manual`, or the automatic
	 * threshold/overflow family). */
	const kindOf = (taskId: string, reason: string): CompactionKind => {
		const admitted = hooks.compactionKind?.(taskId);
		if (admitted) return admitted;
		return reason === "manual" ? "manual" : "auto-overflow";
	};

	/** Emit one compaction's completion envelope. `tokensAfter` is present only
	 * when a later generation measured it; the envelope is emitted exactly once,
	 * either when that measurement arrives or when the stream settles. */
	const emitCompaction = (
		taskId: string,
		entry: TrackedCompaction,
		tokensAfter: number | undefined,
	): void => {
		if (entry.emitted) return;
		entry.emitted = true;
		compactions.delete(taskId);
		const outcome = entry.failedClass
			? "failed"
			: entry.summaryPlaced
				? "completed"
				: "aborted";
		emit("runtime.compaction", {
			reason: entry.reason,
			kind: entry.kind,
			blocking: entry.blocking,
			attempts: entry.attempts,
			...(entry.endedAt !== undefined
				? { durationMs: entry.endedAt - entry.startedAt }
				: {}),
			...(entry.tokensBefore !== undefined
				? { tokensBefore: entry.tokensBefore }
				: {}),
			...(tokensAfter !== undefined ? { tokensAfter } : {}),
			outcome,
			...(entry.failedClass ? { "pi.error.class": entry.failedClass } : {}),
		});
	};

	/** Emit every finished compaction whose measurement is now available, or —
	 * when the stream settles — every finished compaction, measured or not. An
	 * exclamation mark of honesty: a measured flush never invents a "tokens
	 * after" — it is attached only when the request is genuinely smaller than
	 * the one before the compaction, which is what a placed summary does. */
	const flushCompactions = (measured: boolean, tokensAfter?: number): void => {
		for (const [taskId, entry] of [...compactions]) {
			if (entry.emitted) continue;
			if (entry.failedClass) {
				emitCompaction(taskId, entry, undefined);
				continue;
			}
			if (entry.endedAt === undefined) continue;
			if (!measured) {
				emitCompaction(taskId, entry, undefined);
				continue;
			}
			const shrank =
				tokensAfter !== undefined &&
				entry.tokensBefore !== undefined &&
				tokensAfter < entry.tokensBefore;
			if (shrank) emitCompaction(taskId, entry, tokensAfter);
		}
	};
	const closeThinking = (now: number) => {
		if (thinkingStart === undefined) return;
		thinkingMs += Math.max(0, now - thinkingStart);
		thinkingStart = undefined;
	};

	/** Record that a summary was placed: pi-durable's receipt that separates a
	 * successful compaction from one cancelled before it could place anything. */
	const markSummaryPlaced = (): void => {
		let newest: TrackedCompaction | undefined;
		for (const entry of compactions.values()) {
			if (entry.summaryPlaced) continue;
			if (!newest || entry.startedAt >= newest.startedAt) newest = entry;
		}
		if (newest) newest.summaryPlaced = true;
	};
	const handle = (events: readonly AgentEvent[]) => {
		for (const event of events) {
			const now = Date.now();
			// This event's identity, resolved once: the envelopes it produces and the
			// measurements it reports are the same run's.
			const current = identityOf();
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
					// A placed summary is a committed `pi.compaction` entry. It carries a
					// model message (the summary text), so pi-durable delivers it as a
					// message rather than as an `entry_appended` event; both spellings are
					// accepted here so the receipt is never missed.
					if (entry.kind === "pi.compaction") markSummaryPlaced();
					const assistant =
						entry.kind === "pi.assistant" &&
						entry.model?.[0]?.role === "assistant"
							? entry.model[0]
							: undefined;
					const generationMs =
						generationStart !== undefined
							? Math.max(0, now - generationStart)
							: undefined;
					if (assistant && hooks.onTiming) {
						hooks.onTiming(String(entry.id), {
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
						// The request's own prompt size: the measured context the next
						// compaction report compares against.
						const prompt = promptTokens(usage);
						if (prompt > 0) {
							lastPromptTokens = prompt;
							if (prompt > peakContextTokens) peakContextTokens = prompt;
							// A compaction that ended before this generation is now measured:
							// its summary was placed and this request carried the reduced
							// context, which is the only "tokens after" available (pi-durable
							// records no counters for a compaction itself).
							flushCompactions(true, prompt);
							// The same measurement decides the cost ceiling: it is taken at the
							// end of a committed turn, so a ceiling compaction is admitted at a
							// turn boundary and never inside a tool call.
							hooks.onMeasuredContext?.(
								{ promptTokens: prompt, turnIndex },
								current,
							);
						}
						if (tokens > 0 || cost > 0)
							emit("runtime.usage", {
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
					turnIndex += 1;
					emit("runtime.turn_started");
					break;
				case "tool_execution_start": {
					const args = toolArgsTelemetry(event.toolName, event.args);
					toolCalls.set(event.toolCallId, {
						startedAt: now,
						turnIndex: turnIndex < 0 ? undefined : turnIndex,
					});
					callOwners.set(event.toolCallId, current);
					emit("runtime.tool_start", {
						"pi.tool.name": event.toolName,
						"pi.tool.call_id": event.toolCallId,
						// What was asked, never the payload: the hash joins exact repeats,
						// the digest identifies the call and carries no secret.
						"pi.tool.args_hash": args.hash,
						"pi.tool.args_digest": args.digest,
						"pi.tool.argument_bytes": args.bytes,
						...(turnIndex >= 0 ? { "pi.turn.index": turnIndex } : {}),
						...(identityOf().captureContent
							? {
									"herdr.content.tool_input": redact(
										JSON.stringify(event.args),
									).slice(0, CONTENT_LIMIT),
								}
							: {}),
					});
					break;
				}
				case "tool_execution_end": {
					const tracked = toolCalls.get(event.toolCallId);
					toolCalls.delete(event.toolCallId);
					// The run that began this call, not the run bound when it ended.
					const owner = callOwners.get(event.toolCallId) ?? current;
					callOwners.delete(event.toolCallId);
					const result = toolResultTelemetry(event.entry);
					// A result entry that never survived is a host error (the tool task
					// faulted or was orphaned); a surviving one states its own error flag,
					// so a failed `edit` is no longer recorded as a success.
					const isError = event.entry === undefined || result?.isError === true;
					const failureKind = isError
						? classifyToolFailure(event.entry)
						: undefined;
					const turn =
						tracked?.turnIndex ?? (turnIndex < 0 ? undefined : turnIndex);
					const errorLine = isError ? toolFailureLine(event.entry) : undefined;
					emit("runtime.tool", {
						outcome: isError ? "error" : "ok",
						"pi.tool.name": event.toolName,
						"pi.tool.call_id": event.toolCallId,
						"pi.tool.outcome": isError ? "error" : "ok",
						// The explicit `ok` the recording needs: every call states its
						// outcome, successful or not.
						"pi.tool.ok": !isError,
						...(tracked !== undefined
							? { "pi.tool.duration_ms": Math.max(0, now - tracked.startedAt) }
							: {}),
						...(result !== undefined
							? {
									"pi.tool.result_bytes": result.bytes,
									"pi.tool.result_lines": result.lines,
									"pi.tool.result_truncated": result.truncated,
								}
							: {}),
						...(failureKind ? { "pi.tool.failure_kind": failureKind } : {}),
						...(turn !== undefined ? { "pi.turn.index": turn } : {}),
					});
					if (hooks.onToolOutcome) {
						// An observer is the run's supervisor, not its runtime: a throw here
						// would break the event stream it is watching, so it is swallowed.
						try {
							hooks.onToolOutcome(
								{
									tool: event.toolName,
									ok: !isError,
									...(failureKind ? { kind: failureKind } : {}),
									...(turn !== undefined ? { turn } : {}),
									...(errorLine ? { errorLine } : {}),
								},
								owner,
							);
						} catch {
							/* observation is best-effort */
						}
					}
					break;
				}
				case "run_end":
					// The run settled: the envelope carries what makes a ceiling's effect
					// measurable per run — the peak context and the number of compactions
					// by kind — so "automatic compactions > 0, peak context < 200k" can be
					// answered from telemetry alone.
					emit("runtime.settled", {
						...(peakContextTokens > 0 ? { peakContextTokens } : {}),
						...(turnIndex >= 0 ? { turns: turnIndex + 1 } : {}),
						compactionsAutoCeiling: compactionKinds["auto-ceiling"],
						compactionsAutoOverflow: compactionKinds["auto-overflow"],
						compactionsManual: compactionKinds.manual,
					});
					// The run settled: a compaction that never got a measured follow-up
					// generation still reports what is known (its reason, duration and
					// before-tokens) instead of being dropped.
					flushCompactions(false);
					break;
				case "entry_appended":
					// A `pi.compaction` entry is the placed summary: the receipt that
					// tells a successful compaction from one that was aborted before it
					// could place anything.
					if (event.entry.kind === "pi.compaction") markSummaryPlaced();
					break;
				case "compaction_start": {
					const taskId = String(event.taskId);
					const existing = compactions.get(taskId);
					const kind = existing?.kind ?? kindOf(taskId, event.reason);
					// Count each compaction once, at its first start; a retried attempt is
					// the same compaction and must not double the counter.
					if (!existing) compactionKinds[kind] += 1;
					compactions.set(taskId, {
						reason: event.reason,
						kind,
						blocking: event.blocking,
						attempts: (existing?.attempts ?? 0) + 1,
						startedAt: existing?.startedAt ?? now,
						...(lastPromptTokens !== undefined
							? { tokensBefore: lastPromptTokens }
							: {}),
					});
					emit("runtime.compaction_start", {
						reason: event.reason,
						kind,
						blocking: event.blocking,
						attempt: 1,
					});
					break;
				}
				case "compaction_end": {
					const taskId = String(event.taskId);
					const entry = compactions.get(taskId) ?? {
						reason: event.reason,
						kind: kindOf(taskId, event.reason),
						blocking: false,
						attempts: 1,
						startedAt: now,
					};
					entry.endedAt = now;
					compactions.set(taskId, entry);
					break;
				}
				case "task_failed": {
					emit("runtime.task_failed", {
						"pi.error.class": redact(event.message).slice(0, 160),
					});
					if (event.kind === COMPACTION_TASK_KIND) {
						const taskId = String(event.taskId);
						const entry = compactions.get(taskId) ?? {
							reason: "unknown",
							kind: kindOf(taskId, "unknown"),
							blocking: false,
							attempts: 1,
							startedAt: now,
						};
						entry.failedClass = redact(event.message).slice(0, 160);
						compactions.set(taskId, entry);
						emitCompaction(taskId, entry, undefined);
					}
					break;
				}
				default:
					break;
			}
		}
	};
	stream.start(async (events) => handle(events));
	return () => {
		// Whatever compaction is still pending when the stream stops is reported
		// with what is known, so telemetry never silently loses one.
		flushCompactions(false);
		void stream.stop();
	};
}

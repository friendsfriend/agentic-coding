// One normalizer for every telemetry generation in the snapshot.
//
// The sources carry three shapes of the same event stream:
//
//  1. the legacy envelope (`{"at","event","role","cost"}` — `model_usage`,
//     `provider_response`, `tool_error`, `pi_agent_*`, `verification_finding`),
//  2. the span envelope with tool metrics (`schemaVersion`, `layer`,
//     `workflowId`, `runId`, `pi.tool.duration_ms`, `pi.tool.result_bytes`,
//     `herdr.content.tool_input`),
//  3. the newest span envelope, which keeps only names and outcomes.
//
// OTel spans in `traces.sqlite` are the same payload with the fields flattened
// into `herdr.*`/`pi.*` attributes, so a span is turned back into a record and
// fed through this same function. Field presence decides what a record can
// answer; nothing is inferred from which file it came from.

import {
	type ArgsDigest,
	digestToolArgs,
	looksLikeCode,
	redactBounded,
	textDigest,
} from "./redact.ts";

export type TelemetryFormat = "legacy" | "span";

/** The machine-readable failure vocabulary the runtime records. A file that
 * carries anything else keeps the failure kind NULL rather than storing an
 * uninterpretable string. */
export const TOOL_FAILURE_KINDS: ReadonlySet<string> = new Set([
	"not-found",
	"no-match",
	"denied",
	"host-error",
	"timeout",
	"aborted",
	"invalid-args",
	"other",
]);

/** Tool outcomes that mean the call succeeded. Anything else (including the
 * legacy `error` spelling) counts as a failure. */
export const OK_TOOL_OUTCOMES: ReadonlySet<string> = new Set(["ok", "success"]);

/** Events whose `outcome`/`status` field describes a tool call. */
const TOOL_EVENT_PATTERN = /^(runtime\.tool|tool_error)/;

export interface NormalizedEvent {
	event: string;
	format: TelemetryFormat;
	layer?: string;
	workflowId?: string;
	runId?: string;
	stepId?: string;
	role?: string;
	profile?: string;
	model?: string;
	provider?: string;
	at?: string;
	revision?: number;
	herdrStatus?: string;
	attempt?: number;

	/** Workflow-level metadata, carried by `workflow.started`/`legacy.migrated`. */
	repo?: string;
	branch?: string;
	definitionId?: string;
	workflowType?: string;
	baseCommit?: string;
	/** OTel trace id when the record came from a span (never from JSONL). */
	traceId?: string;
	/** The run's generation (attempt counter) when the envelope carries one. */
	runGeneration?: number;

	turnIndex?: number;
	toolName?: string;
	callId?: string;
	toolOutcome?: string;
	/** The envelope's explicit `pi.tool.ok`, when the generation records one. */
	toolOk?: boolean;
	toolDurationMs?: number;
	toolArgumentBytes?: number;
	toolResultBytes?: number;
	toolResultLines?: number;
	toolResultTruncated?: boolean;
	/** `not-found`, `no-match`, `denied`, `host-error`, `timeout`, `aborted`,
	 * `invalid-args` or `other` — a code, never prose. */
	toolFailureKind?: string;
	toolInput?: ArgsDigest;
	errorClass?: string;

	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	totalTokens?: number;
	cost?: number;
	durationMs?: number;
	tokensPerSecond?: number;

	turnToolCalls?: number;
	turnToolErrors?: number;
	turnDurationMs?: number;

	outcome?: string;
	handoffOutcome?: string;
	handoffReason?: string;
	effectKind?: string;
	effectAttempt?: number;

	severity?: string;
	findingId?: string;
	findingPath?: string;
	findingStatus?: string;
	verdict?: string;
	actionId?: string;
	phaseFrom?: string;
	phaseTo?: string;
	/** A short, space-free reason code; prose is never kept. */
	reasonCode?: string;
	/** The bounded, credential-masked reason a repair was taken (efficiency
	 * backlog item 11). Absent on every generation that recorded none. */
	repairReason?: string;
	/** How many effects the repair expired and how many runs it retired. */
	repairEffects?: number;
	repairRuns?: number;
	/** The workflow-level repair counter the engine recorded with the event. */
	repairCount?: number;
	/** What a workflow wait was about, and its subject (item 12). */
	waitKind?: string;
	waitSubject?: string;
	/** The session window's own vocabulary (efficiency backlog item 20): why a
	 * conversation was bound to a run, the run it left (`closed`) and the run it
	 * moved to, and the conversation the window belongs to. */
	sessionReason?: string;
	sessionReboundTo?: string;
	sessionPreviousRunId?: string;
	sessionConversationId?: string;
	/** Why a compaction ran, as the envelope's own `kind`: `auto-ceiling`,
	 * `auto-overflow` or `manual`. Absent on a generation that only spells a
	 * reason. */
	compactionKind?: string;
	compactionReason?: string;
	compactionBlocking?: boolean;

	/** Hash/byte-count of any free-text detail; the text is never retained. */
	detail?: { hash: string; bytes: number };
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function bool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	return undefined;
}

/** A flag an older writer spelled as 0/1 or "true"/"false". */
function boolish(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
	for (const key of keys) {
		const value = record[key];
		if (value !== undefined && value !== null) return value;
	}
	return undefined;
}

/** ISO instant from epoch milliseconds, or the value itself when already ISO. */
export function toIso(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const ms = value > 1e15 ? value / 1e6 : value;
		return new Date(ms).toISOString();
	}
	const text = str(value);
	if (text === undefined) return undefined;
	if (/^\d+$/.test(text)) return toIso(Number(text));
	return text;
}

/** Nanosecond OTel timestamps → ISO. */
export function nanosToIso(
	nanos: number | null | undefined,
): string | undefined {
	if (typeof nanos !== "number" || !Number.isFinite(nanos) || nanos <= 0)
		return undefined;
	return new Date(Math.round(nanos / 1e6)).toISOString();
}

export interface NormalizeOptions {
	/** Workflow id to use when the record carries none (a per-workflow file). */
	workflowId?: string;
	/** Instant to use when the record carries none (a span's own timestamp). */
	at?: string;
}

/**
 * Normalize one telemetry record (JSONL line object, or flattened span
 * attributes). Returns `undefined` for a record with no event name, which is
 * counted as skipped rather than guessed at.
 */
export function normalizeRecord(
	record: Record<string, unknown>,
	options: NormalizeOptions = {},
): NormalizedEvent | undefined {
	const event = str(pick(record, "event", "name"));
	if (event === undefined) return undefined;
	const format: TelemetryFormat =
		record.schemaVersion === undefined && record.spanId === undefined
			? "legacy"
			: "span";

	const rawToolInput = str(
		pick(record, "herdr.content.tool_input", "tool_input"),
	);
	const description = str(
		pick(record, "description", "message", "detail", "error"),
	);
	const errorClass = str(
		pick(record, "pi.error.class", "herdr.error.class", "error.class"),
	);

	const normalized: NormalizedEvent = {
		event,
		format,
		layer: str(record.layer),
		workflowId:
			str(
				pick(record, "workflowId", "herdr.change.id", "herdr.change", "change"),
			) ?? options.workflowId,
		runId: str(
			pick(record, "runId", "herdr.run.id", "sessionId", "herdr.session.id"),
		),
		stepId: str(pick(record, "stepId", "herdr.step.id")),
		role: str(pick(record, "role", "herdr.role")),
		profile: str(pick(record, "profile", "herdr.profile")),
		model: str(pick(record, "pi.model", "model")),
		provider: str(pick(record, "pi.provider", "provider")),
		at: toIso(pick(record, "at", "timestamp", "time")) ?? options.at,
		revision: num(pick(record, "herdr.revision")),
		herdrStatus: str(pick(record, "herdr.status")),
		attempt: num(pick(record, "herdr.run.attempt", "herdr.effect.attempt")),
		repo: str(pick(record, "herdr.repository", "repository")),
		branch: str(record["herdr.branch"]),
		definitionId: str(record["herdr.definition.id"]),
		workflowType: str(record["herdr.workflow.type"]),
		baseCommit: str(record["herdr.base.commit"]),
		traceId: str(record.traceId),
		runGeneration: num(record["herdr.run.generation"]),

		turnIndex: num(record["pi.turn.index"]),
		toolName: str(pick(record, "pi.tool.name", "tool")),
		callId: str(pick(record, "pi.tool.call_id", "toolCallId")),
		toolOutcome: str(
			TOOL_EVENT_PATTERN.test(event)
				? pick(record, "pi.tool.outcome", "outcome")
				: record["pi.tool.outcome"],
		),
		toolOk: boolish(record["pi.tool.ok"]),
		toolDurationMs: num(pick(record, "pi.tool.duration_ms", "durationMs")),
		toolArgumentBytes: num(record["pi.tool.argument_bytes"]),
		toolResultBytes: num(record["pi.tool.result_bytes"]),
		toolResultLines: num(record["pi.tool.result_lines"]),
		toolResultTruncated: boolish(record["pi.tool.result_truncated"]),
		toolFailureKind: (() => {
			const kind = str(record["pi.tool.failure_kind"]);
			return kind !== undefined && TOOL_FAILURE_KINDS.has(kind)
				? kind
				: undefined;
		})(),
		errorClass,

		inputTokens: num(pick(record, "inputTokens", "input")),
		outputTokens: num(pick(record, "outputTokens", "output")),
		cacheReadTokens: num(pick(record, "cacheReadTokens", "cacheRead")),
		cacheWriteTokens: num(pick(record, "cacheWriteTokens", "cacheWrite")),
		totalTokens: num(pick(record, "totalTokens", "total_tokens")),
		cost: num(record.cost),
		tokensPerSecond: num(record.tokensPerSecond),

		turnToolCalls: num(record["pi.turn.tool_calls"]),
		turnToolErrors: num(record["pi.turn.tool_errors"]),
		turnDurationMs: num(record["pi.turn.duration_ms"]),

		handoffOutcome: str(
			event === "agent.handoff"
				? pick(record, "herdr.handoff.outcome", "outcome")
				: record["herdr.handoff.outcome"],
		),
		handoffReason: str(record["herdr.handoff.reason"]),
		outcome: str(record.outcome),
		effectKind: str(record["herdr.effect.kind"]),
		effectAttempt: num(record["herdr.effect.attempt"]),

		severity: str(record.severity),
		findingId: str(record.finding_id),
		findingPath: str(pick(record, "finding_path", "path")),
		findingStatus: str(record.status),
		verdict: str(pick(record, "verdict")),
		actionId: str(pick(record, "herdr.action.id", "action")),
		phaseFrom: str(record.source),
		phaseTo: str(record.target),
		reasonCode: (() => {
			const reason = str(record.reason);
			return reason !== undefined && looksLikeCode(reason) ? reason : undefined;
		})(),
		repairReason: str(record["herdr.repair.reason"]),
		repairEffects: num(record["herdr.repair.effects"]),
		repairRuns: num(record["herdr.repair.runs"]),
		repairCount: num(record["herdr.repair.count"]),
		waitKind: str(record["herdr.wait.kind"]),
		waitSubject: str(record["herdr.wait.subject"]),
		sessionReason: str(record["herdr.session.reason"]),
		sessionReboundTo: str(record["herdr.session.rebound_to"]),
		sessionPreviousRunId: str(record["herdr.session.previous_run_id"]),
		sessionConversationId: str(record["herdr.session.conversation_id"]),
		compactionReason: str(record.reason),
		compactionKind: str(record.kind),
		compactionBlocking: bool(record.blocking),
	};

	// A progress checkpoint's own vocabulary (efficiency backlog item 19): its
	// decision is the event's outcome, its rule a space-free reason code, and an
	// errored evaluation is the only thing that carries an error class — which is
	// exactly what `checkpoint-gaps` reads.
	if (event === "runtime.checkpoint") {
		normalized.outcome =
			str(record["herdr.checkpoint.decision"]) ?? normalized.outcome;
		const rule = str(record["herdr.checkpoint.rule"]);
		normalized.reasonCode =
			rule !== undefined && looksLikeCode(rule)
				? rule
				: normalized.reasonCode;
		normalized.errorClass =
			str(record["herdr.checkpoint.status"]) === "error"
				? (str(record["herdr.checkpoint.error_class"]) ?? "checkpoint_error")
				: undefined;
	}

	// A tool outcome that is neither "ok" nor absent stays as recorded; the
	// dataset never rewrites an outcome it cannot interpret. The fallback error
	// class is only derived for a tool event — an unrelated event's `status`
	// (`new`, `resolved`) is not an error class.
	if (
		TOOL_EVENT_PATTERN.test(event) &&
		normalized.toolOutcome !== undefined &&
		!OK_TOOL_OUTCOMES.has(normalized.toolOutcome)
	)
		normalized.errorClass =
			normalized.errorClass ?? normalized.toolOutcome ?? event;

	// The recorded digest wins over one derived here: it is what the runtime
	// actually saw, and re-deriving it from a captured payload would both lose
	// fields the runtime recorded and require the payload to exist at all.
	const recordedHash = str(record["pi.tool.args_hash"]);
	const recordedDigest = str(record["pi.tool.args_digest"]);
	if (recordedHash !== undefined) {
		normalized.toolInput = {
			hash: recordedHash,
			digest:
				recordedDigest === undefined ? "" : redactBounded(recordedDigest, 200),
			bytes: normalized.toolArgumentBytes ?? 0,
		};
	} else if (rawToolInput !== undefined) {
		let parsed: unknown = rawToolInput;
		try {
			parsed = JSON.parse(rawToolInput);
		} catch {
			parsed = rawToolInput;
		}
		normalized.toolInput = digestToolArgs(normalized.toolName ?? "?", parsed);
	}
	if (description !== undefined)
		normalized.detail = textDigest(redactBounded(description, 400));
	return normalized;
}

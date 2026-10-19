// Turning the snapshot's sources into the normalized tables.
//
// The pipeline is: read every source (each file keeps its parse counts), tag
// every record with the source it came from, then build the five tables with a
// documented precedence so the same run seen three times produces one run and
// three clearly-labelled turn sets. Nothing here interprets the data — later
// steps do that. What it does have to get right is honesty: a run that could
// only be attributed heuristically is marked `heuristic`, an unparsed line is
// counted, and a field a source does not carry stays NULL rather than becoming
// a guess.

import path from "node:path";
import {
	type HarnessConversation,
	type HarnessReadResult,
	readHarness,
} from "./harness.ts";
import { type HerdrReadResult, readHerdr } from "./herdr.ts";
import { type NormalizedEvent, OK_TOOL_OUTCOMES } from "./normalize.ts";
import { redactBounded, sha256Hex } from "./redact.ts";
import {
	assertEvidenceRoot,
	type DiscoveredFile,
	discoverEvidence,
} from "./sources.ts";
import { readTelemetryJsonl } from "./telemetry.ts";
import { readTraces } from "./traces.ts";
import {
	type Confidence,
	type EventClass,
	type EventRow,
	type ExtractedTables,
	type RunRow,
	SOURCE_BY_ID,
	type SourceFileRow,
	type SourceId,
	sourceRank,
	type ToolCallRow,
	type TurnRow,
	type WorkflowRow,
} from "./types.ts";

interface TaggedEvent {
	source: SourceId;
	order: number;
	file: string;
	event: NormalizedEvent;
}

export interface ExtractOptions {
	evidenceDir: string;
	onProgress?: (message: string) => void;
}

export interface ExtractResult {
	tables: ExtractedTables;
	discoveryFiles: number;
	discoveryMissing: string[];
}

/** Events that describe a single turn or call; they belong in `turns` and
 * `tool_calls`, not in the event log, or the log would be 90% noise. */
const TURN_AND_CALL_EVENTS: ReadonlySet<string> = new Set([
	"runtime.tool",
	"runtime.tool_start",
	"runtime.turn",
	"runtime.turn_started",
	"runtime.usage",
	"model_usage",
	"provider_response",
	"runtime.provider_response",
	"tool_error",
	"pi_agent_start",
	"pi_agent_end",
	"pi_agent_settled",
	"runtime.started",
	"runtime.settled",
	"agent.launch",
	"agent.launch.attempt",
	"routing.request",
	"routing.response",
	"workflow.rollup",
]);

/** The subset of turn/call events that can also appear without a run id, in the
 * oldest generation. They are re-homed onto a synthetic run rather than
 * dropped, so a workflow's call volume is never silently zero. */
const TURN_CALL_EVENT_NAMES: ReadonlySet<string> = new Set([
	"runtime.tool",
	"runtime.tool_start",
	"runtime.turn",
	"runtime.turn_started",
	"runtime.usage",
	"model_usage",
	"tool_error",
]);

export function eventClass(event: string): EventClass {
	if (/compaction/.test(event)) return "compaction";
	// Every developer-blocking transition: entering a wait and ending one
	// (efficiency backlog item 12).
	if (/^workflow\.waiting/.test(event)) return "wait";
	if (/^(triage_|triage\.)/.test(event)) return "triage";
	if (/^(verif|verifier|test_verifier|worker_verification)/.test(event))
		return "verifier";
	if (
		/^(plan_quality|gate\.|developer[._]|agent\.question|workflow_phase_overridden|phase_changed|model_selected|runtime\.model_selected)/.test(
			event,
		)
	)
		return "gate";
	if (/^(archive_|git_operations_|workflow_closed|delivery\.)/.test(event))
		return "delivery";
	if (/^(routing\.classified)/.test(event)) return "routing";
	switch (event) {
		case "agent.handoff":
			return "handoff";
		case "effect.result":
			return "effect";
		case "workflow.started":
		case "legacy.migrated":
		// The session window (efficiency backlog item 20): the run's session was
		// bound to a run, or left one for a later run. Recorded as lifecycle so the
		// two events are readable by class as well as by name; `run-window-drift`
		// reads them by name.
		case "runtime.session_window.opened":
		case "runtime.session_window.closed":
			return "lifecycle";
		default:
			return "other";
	}
}

function str(value: string | undefined | null): string | null {
	return value === undefined || value === null || value.length === 0
		? null
		: value;
}

/** How many ids a bounded id list holds. The ids themselves stay in the store
 * they were recorded in; the dataset keeps their count. Anything that is not an
 * array counts as none recorded. */
function idCount(value: unknown): number | null {
	return Array.isArray(value) ? value.length : null;
}

/** Highest-precedence source among those that contributed to a row. */
function topSource(sources: Iterable<SourceId>): SourceId {
	let best: SourceId = "traces.otel-tui";
	let bestRank = -1;
	for (const source of sources) {
		const rank = sourceRank(source);
		if (rank > bestRank) {
			bestRank = rank;
			best = source;
		}
	}
	return best;
}

/** Rank of the highest-precedence contributing source. */
function topRank(sources: Iterable<SourceId>): number {
	let best = 0;
	for (const source of sources) best = Math.max(best, sourceRank(source));
	return best;
}

function iso(value: string | undefined): string | null {
	return value === undefined ? null : value;
}

function minIso(
	current: string | null | undefined,
	candidate: string | undefined,
): string | null {
	if (candidate === undefined) return current ?? null;
	if (current === null || current === undefined) return candidate;
	return candidate < current ? candidate : current;
}

function maxIso(
	current: string | null | undefined,
	candidate: string | undefined,
): string | null {
	if (candidate === undefined) return current ?? null;
	if (current === null || current === undefined) return candidate;
	return candidate > current ? candidate : current;
}

/** `…agentic-coding-e3447de8.feature-fix-thing` → `fix-thing`. */
export function workflowFromPath(
	candidate: string | undefined,
): string | undefined {
	if (candidate === undefined) return undefined;
	const base = path.basename(candidate);
	const match = base.match(/\.feature-(.+)$/);
	return match?.[1];
}

/**
 * Normalize a tool call id. One older runtime recorded the id as
 * `<id>|<opaque base64 payload>`; the payload is not needed to pair a call with
 * its result and is dropped, and anything still long is reduced to a bounded
 * prefix plus a hash so no bulk value enters the dataset.
 */
export function sanitizeCallId(
	value: string | null | undefined,
): string | null {
	if (value === null || value === undefined) return null;
	const head = (value.split("|")[0] ?? "").trim();
	if (head.length === 0) return null;
	if (head.length <= 64) return head;
	return `${head.slice(0, 24)}#${sha256Hex(head).slice(0, 12)}`;
}

interface RankedField<T> {
	value: T;
	rank: number;
}

class FieldBag<T> {
	readonly fields = new Map<string, RankedField<T>>();

	set(key: string, value: T | undefined | null, rank: number): void {
		if (value === undefined || value === null) return;
		const existing = this.fields.get(key);
		if (existing === undefined || rank >= existing.rank)
			this.fields.set(key, { value, rank });
	}

	get(key: string): T | null {
		return this.fields.get(key)?.value ?? null;
	}
}

interface FlowAccumulator {
	id: string;
	fields: FieldBag<string>;
	firstAt: string | null;
	lastAt: string | null;
	sources: Set<SourceId>;
}

interface RunAccumulator {
	runId: string;
	label: string | null;
	fields: FieldBag<string>;
	firstAt: string | null;
	lastAt: string | null;
	durationMs: number | null;
	sources: Set<SourceId>;
	confidence: Confidence;
}

interface TurnBuild {
	index: number;
	startedAt: string | null;
	endedAt: string | null;
	durationMs: number | null;
	usage: NormalizedEvent | null;
	toolCalls: number;
	toolErrors: number;
	/** Whether the source states the turn's call count at all. */
	hasCount: boolean;
}

function flushTurn(
	build: TurnBuild,
	runId: string,
	runLabel: string | null,
	workflowId: string | null,
	source: SourceId,
	out: TurnRow[],
): void {
	const usage = build.usage;
	const hasCounters =
		usage !== null &&
		(usage.inputTokens !== undefined ||
			usage.outputTokens !== undefined ||
			usage.cacheReadTokens !== undefined ||
			usage.cacheWriteTokens !== undefined);
	const total =
		usage?.totalTokens ??
		(hasCounters && usage !== null
			? (usage.inputTokens ?? 0) +
				(usage.outputTokens ?? 0) +
				(usage.cacheReadTokens ?? 0) +
				(usage.cacheWriteTokens ?? 0)
			: null);
	out.push({
		run_id: runId,
		run_label: runLabel,
		workflow_id: workflowId,
		source,
		source_rank: sourceRank(source),
		turn_index: build.index,
		started_at: build.startedAt,
		ended_at: build.endedAt,
		duration_ms:
			build.durationMs ??
			(build.startedAt !== null && build.endedAt !== null
				? Math.max(0, Date.parse(build.endedAt) - Date.parse(build.startedAt))
				: null),
		input_tokens: usage?.inputTokens ?? null,
		output_tokens: usage?.outputTokens ?? null,
		cache_read_tokens: usage?.cacheReadTokens ?? null,
		cache_write_tokens: usage?.cacheWriteTokens ?? null,
		total_tokens: total,
		cost: usage?.cost ?? null,
		// The transcript's `usage.reasoning` is the thinking-token count; the
		// telemetry envelope only carries a thinking *level*, which is not a
		// token count and is therefore not stored here.
		thinking_tokens: null,
		stop_reason: null,
		tool_calls: build.hasCount ? build.toolCalls : null,
		model: usage?.model ?? null,
		provider: usage?.provider ?? null,
		confidence: "exact",
		preferred: 0,
	});
}

function buildTelemetryTurns(
	group: TaggedEvent[],
	runId: string,
	runLabel: string | null,
	workflowId: string | null,
	source: SourceId,
): { turns: TurnRow[]; turnIndexByOrder: Map<number, number> } {
	const sorted = [...group].sort(
		(a, b) =>
			(a.event.at ?? "").localeCompare(b.event.at ?? "") || a.order - b.order,
	);
	const turns: TurnRow[] = [];
	const turnIndexByOrder = new Map<number, number>();
	const byIndex = new Map<number, TurnBuild>();
	const hasToolStart = sorted.some(
		(entry) => entry.event.event === "runtime.tool_start",
	);
	// A generation emits `turn_started`, then its message usage, then the tool
	// executions of that generation. `turn_started` (and the older
	// `runtime.turn`) is therefore the only turn boundary when it exists; usage
	// and tool events attach to the turn it opened. Only the oldest generation,
	// which has neither, is composed from its per-message usage rows.
	const boundedByTurnStarted = sorted.some(
		(entry) =>
			entry.event.event === "runtime.turn_started" ||
			entry.event.event === "runtime.turn",
	);
	const hasToolEvents = sorted.some(
		(entry) =>
			entry.event.event === "runtime.tool_start" ||
			entry.event.event === "runtime.tool" ||
			entry.event.event === "tool_error",
	);
	let auto = 0;
	let current: TurnBuild | null = null;

	const allocate = (preferred: number | undefined): TurnBuild => {
		let index = preferred ?? auto++;
		while (byIndex.has(index)) index = auto++;
		const build: TurnBuild = {
			index,
			startedAt: null,
			endedAt: null,
			durationMs: null,
			usage: null,
			toolCalls: 0,
			toolErrors: 0,
			hasCount: hasToolEvents,
		};
		byIndex.set(index, build);
		return build;
	};
	const close = (): void => {
		if (current === null) return;
		flushTurn(current, runId, runLabel, workflowId, source, turns);
		current = null;
	};

	for (const entry of sorted) {
		const event = entry.event;
		switch (event.event) {
			case "runtime.turn": {
				close();
				const build = allocate(event.turnIndex);
				build.startedAt = iso(event.at);
				build.endedAt = iso(event.at);
				build.durationMs = event.turnDurationMs ?? null;
				build.toolCalls = event.turnToolCalls ?? 0;
				build.toolErrors = event.turnToolErrors ?? 0;
				build.hasCount = event.turnToolCalls !== undefined;
				turnIndexByOrder.set(entry.order, build.index);
				flushTurn(build, runId, runLabel, workflowId, source, turns);
				break;
			}
			case "runtime.turn_started": {
				close();
				current = allocate(event.turnIndex);
				current.startedAt = iso(event.at);
				break;
			}
			case "runtime.usage":
			case "model_usage": {
				if (current !== null && !boundedByTurnStarted && current.usage !== null)
					close();
				if (current === null) current = allocate(event.turnIndex);
				current.usage = event;
				current.endedAt = iso(event.at) ?? current.endedAt;
				current.startedAt = current.startedAt ?? iso(event.at);
				turnIndexByOrder.set(entry.order, current.index);
				if (!boundedByTurnStarted) close();
				break;
			}
			case "runtime.tool_start":
			case "runtime.tool":
			case "tool_error": {
				if (current === null) current = allocate(event.turnIndex);
				if (event.event === "runtime.tool_start") current.toolCalls += 1;
				else if (event.event === "runtime.tool" && !hasToolStart)
					current.toolCalls += 1;
				if (event.event === "tool_error") current.toolErrors += 1;
				current.startedAt = current.startedAt ?? iso(event.at);
				current.endedAt = iso(event.at) ?? current.endedAt;
				turnIndexByOrder.set(entry.order, current.index);
				break;
			}
			default:
				break;
		}
	}
	close();
	return { turns, turnIndexByOrder };
}

function buildTelemetryToolCalls(
	group: TaggedEvent[],
	turnIndexByOrder: Map<number, number>,
	runId: string,
	runLabel: string | null,
	workflowId: string | null,
	source: SourceId,
): ToolCallRow[] {
	const sorted = [...group].sort(
		(a, b) =>
			(a.event.at ?? "").localeCompare(b.event.at ?? "") || a.order - b.order,
	);
	const rows: ToolCallRow[] = [];
	const pending = new Map<string, ToolCallRow>();
	let sequence = 0;

	const base = (
		tool: string,
		callId: string | null,
		order: number,
		event: NormalizedEvent,
	): ToolCallRow => ({
		run_id: runId,
		run_label: runLabel,
		workflow_id: workflowId,
		source,
		source_rank: sourceRank(source),
		// The event's own turn index is a fallback only: the turn table numbers
		// turns by position in the same file, and a call must not point at a turn
		// index that file never allocated.
		turn_index: turnIndexByOrder.get(order) ?? event.turnIndex ?? null,
		call_id: callId,
		dedupe_key: callId ?? `${tool}#${sequence++}`,
		tool,
		started_at: null,
		ended_at: null,
		duration_ms: null,
		ok: null,
		error_class: null,
		failure_kind: null,
		args_hash: null,
		args_digest: null,
		args_bytes: null,
		result_bytes: null,
		result_lines: null,
		result_truncated: null,
		recording: event.format === "legacy" ? "legacy" : "span",
		confidence: "exact",
		preferred: 0,
	});

	for (const entry of sorted) {
		const event = entry.event;
		const tool = event.toolName ?? "unknown";
		const callId = sanitizeCallId(event.callId);
		switch (event.event) {
			case "runtime.tool_start": {
				const row = base(tool, callId, entry.order, event);
				row.started_at = iso(event.at);
				if (event.toolInput !== undefined) {
					row.args_hash = event.toolInput.hash;
					row.args_digest = event.toolInput.digest;
					row.args_bytes = event.toolInput.bytes;
				}
				if (callId !== null) pending.set(callId, row);
				rows.push(row);
				break;
			}
			case "runtime.tool": {
				const existing = callId === null ? undefined : pending.get(callId);
				const row = existing ?? base(tool, callId, entry.order, event);
				row.tool = tool;
				row.ended_at = iso(event.at) ?? row.ended_at;
				row.duration_ms = event.toolDurationMs ?? row.duration_ms;
				if (event.toolArgumentBytes !== undefined)
					row.args_bytes = row.args_bytes ?? event.toolArgumentBytes;
				row.result_bytes = event.toolResultBytes ?? row.result_bytes;
				row.result_lines = event.toolResultLines ?? row.result_lines;
				if (event.toolResultTruncated !== undefined)
					row.result_truncated = event.toolResultTruncated ? 1 : 0;
				row.ok = toolOkValue(event, row.ok);
				row.failure_kind = event.toolFailureKind ?? row.failure_kind;
				row.error_class = errorClassOf(event) ?? row.error_class;
				if (event.toolInput !== undefined && row.args_hash === null) {
					row.args_hash = event.toolInput.hash;
					row.args_digest = event.toolInput.digest;
					row.args_bytes = row.args_bytes ?? event.toolInput.bytes;
				}
				if (existing === undefined) rows.push(row);
				if (callId !== null) pending.delete(callId);
				break;
			}
			case "tool_error": {
				const row = base(tool, null, entry.order, event);
				row.started_at = iso(event.at);
				row.ended_at = iso(event.at);
				row.ok = 0;
				row.error_class = errorClassOf(event) ?? "tool_error";
				rows.push(row);
				break;
			}
			default:
				break;
		}
	}
	return rows;
}

/** The call's outcome. The envelope's explicit `ok` wins over the outcome
 * spelling: it is what the runtime measured, including a failed call whose
 * result entry survived (which the old `ok`/`error` fallback read as a
 * success). A recording that states neither leaves the previous value alone. */
function toolOkValue(
	event: NormalizedEvent,
	current: number | null,
): number | null {
	if (event.toolOk !== undefined) return event.toolOk ? 1 : 0;
	if (event.toolOutcome === undefined) return current;
	return OK_TOOL_OUTCOMES.has(event.toolOutcome) ? 1 : 0;
}

function errorClassOf(event: NormalizedEvent): string | null {
	return event.errorClass === undefined
		? null
		: redactBounded(event.errorClass, 160);
}

function harnessTurns(
	conversation: HarnessConversation,
	runId: string,
	workflowId: string | null,
	source: SourceId,
): TurnRow[] {
	return conversation.turns.map((turn) => ({
		run_id: runId,
		run_label: conversation.label ?? null,
		workflow_id: workflowId,
		source,
		source_rank: sourceRank(source),
		turn_index: turn.index,
		started_at: turn.at ?? null,
		ended_at: turn.endedAt ?? null,
		duration_ms:
			turn.at !== undefined && turn.endedAt !== undefined
				? Math.max(0, Date.parse(turn.endedAt) - Date.parse(turn.at))
				: null,
		input_tokens: turn.inputTokens ?? null,
		output_tokens: turn.outputTokens ?? null,
		cache_read_tokens: turn.cacheReadTokens ?? null,
		cache_write_tokens: turn.cacheWriteTokens ?? null,
		total_tokens: turn.totalTokens ?? null,
		cost: turn.cost ?? null,
		thinking_tokens: turn.thinkingTokens ?? null,
		stop_reason: turn.stopReason ?? null,
		tool_calls: turn.toolCalls.length,
		model: turn.model ?? null,
		provider: turn.provider ?? null,
		confidence: "exact",
		preferred: 0,
	}));
}

function harnessToolCalls(
	conversation: HarnessConversation,
	runId: string,
	workflowId: string | null,
	source: SourceId,
): ToolCallRow[] {
	const rows: ToolCallRow[] = [];
	for (const turn of conversation.turns) {
		for (const call of turn.toolCalls) {
			const result = conversation.toolResults.get(call.callId);
			const callId = sanitizeCallId(call.callId) ?? call.callId;
			rows.push({
				run_id: runId,
				run_label: conversation.label ?? null,
				workflow_id: workflowId,
				source,
				source_rank: sourceRank(source),
				turn_index: turn.index,
				call_id: callId,
				dedupe_key: callId,
				tool: call.tool,
				started_at: turn.at ?? null,
				ended_at: result?.at ?? null,
				duration_ms:
					turn.at !== undefined && result?.at !== undefined
						? Math.max(0, Date.parse(result.at) - Date.parse(turn.at))
						: null,
				ok: result === undefined ? null : result.isError ? 0 : 1,
				error_class: result?.isError === true ? "tool_error" : null,
				// A transcript states that a call failed but names no kind: the
				// runtime's vocabulary is not reconstructed from result text here.
				failure_kind: null,
				args_hash: call.argsDigest.hash,
				args_digest: call.argsDigest.digest,
				args_bytes: call.argsDigest.bytes,
				result_bytes: result?.bytes ?? null,
				result_lines: result?.lines ?? null,
				result_truncated:
					result === undefined ? null : result.truncated ? 1 : 0,
				recording: "harness",
				confidence: result === undefined ? "heuristic" : "exact",
				preferred: 0,
			});
		}
	}
	return rows;
}

/** Assign each harness conversation to a run, using the handle name where the
 * durable store still knows it and the workflow's single run where it does not. */
function attributeHarness(
	files: Array<{ file: DiscoveredFile; read: HarnessReadResult }>,
	handleNames: Map<string, string>,
	runsByWorkflow: Map<string, Set<string>>,
	notes: string[],
): Array<{
	fileName: string;
	conversation: HarnessConversation;
	runId: string;
	runLabel: string | null;
	workflowId: string | null;
	source: SourceId;
	confidence: Confidence;
}> {
	const attributed = [];
	for (const { file, read } of files) {
		for (const conversation of read.conversations) {
			const label = conversation.label ?? null;
			const cwdWorkflow = workflowFromPath(conversation.cwd);
			const workflowId = file.workflowId ?? cwdWorkflow ?? null;
			let runId: string | null = null;
			let confidence: Confidence = "heuristic";
			if (label !== null) {
				const fromHandle = handleNames.get(label);
				if (fromHandle !== undefined) {
					runId = fromHandle;
					confidence = "exact";
				}
			}
			if (runId === null && workflowId !== null) {
				const candidates = runsByWorkflow.get(workflowId);
				if (candidates !== undefined && candidates.size === 1) {
					runId = [...candidates][0] ?? null;
					confidence = "heuristic";
				}
			}
			if (runId === null) {
				runId = `${file.source}#${workflowId ?? label ?? "unattributed"}#${conversation.id}`;
				confidence = label === null ? "unknown" : "heuristic";
				notes.push(
					`${file.relative}: conversation ${conversation.id} (${label ?? "no label"}) could not be attributed to a durable run`,
				);
			}
			attributed.push({
				fileName: file.relative,
				conversation,
				runId,
				runLabel: label,
				workflowId,
				source: file.source,
				confidence,
			});
		}
	}
	return attributed;
}

/** Build every table from the evidence directory. */
export function extractTables(options: ExtractOptions): ExtractResult {
	const discovery = discoverEvidence(options.evidenceDir);
	assertEvidenceRoot(discovery);
	const progress = options.onProgress ?? (() => {});

	const tagged: TaggedEvent[] = [];
	const sourceFiles: SourceFileRow[] = [];
	const notes: string[] = [];
	const harnessFiles: Array<{ file: DiscoveredFile; read: HarnessReadResult }> =
		[];
	const herdrFiles: Array<{ file: DiscoveredFile; read: HerdrReadResult }> = [];
	let order = 0;

	for (const file of discovery.files) {
		progress(`reading ${file.relative}`);
		if (file.kind === "telemetry") {
			const { events, stats } = readTelemetryJsonl(file.path, file.workflowId);
			// A per-workflow file is an append log, but sorting by instant keeps
			// the turn composition correct even if a writer interleaved.
			for (const event of events)
				tagged.push({
					source: file.source,
					order: order++,
					file: file.relative,
					event,
				});
			sourceFiles.push({
				source: file.source,
				path: file.relative,
				kind: "telemetry",
				records: stats.records,
				parsed: stats.parsed,
				skipped: stats.skipped,
				note: stats.notes.length > 0 ? stats.notes.join("; ") : undefined,
			});
		} else if (file.kind === "traces") {
			const { events, stats, workspaceFiles } = readTraces(file.path);
			for (const event of events)
				tagged.push({
					source: file.source,
					order: order++,
					file: file.relative,
					event,
				});
			sourceFiles.push({
				source: file.source,
				path: file.relative,
				kind: "traces",
				records: stats.records,
				parsed: stats.parsed,
				skipped: stats.skipped,
				note:
					stats.notes.length > 0
						? stats.notes.join("; ")
						: `${workspaceFiles} workspace_files rows`,
			});
		} else if (file.kind === "harness") {
			const read = readHarness(file.path);
			harnessFiles.push({ file, read });
			sourceFiles.push({
				source: file.source,
				path: file.relative,
				kind: "harness",
				records: read.stats.records,
				parsed: read.stats.parsed,
				skipped: read.stats.skipped,
				note:
					`${read.conversations.length} conversation(s)` +
					(read.stats.notes.length > 0
						? `; ${read.stats.notes.join("; ")}`
						: ""),
			});
		} else {
			const read = readHerdr(file.path);
			herdrFiles.push({ file, read });
			sourceFiles.push({
				source: file.source,
				path: file.relative,
				kind: "herdr",
				records: read.instances.length + read.runs.length + read.events.length,
				parsed: read.instances.length + read.runs.length + read.events.length,
				skipped: read.skipped,
				note:
					`${read.instances.length} instances, ${read.runs.length} runs, ${read.events.length} events` +
					(read.notes.length > 0 ? `; ${read.notes.join("; ")}` : ""),
			});
		}
	}

	// ---- workflows -------------------------------------------------------
	const flows = new Map<string, FlowAccumulator>();
	const flowOf = (id: string): FlowAccumulator => {
		const existing = flows.get(id);
		if (existing) return existing;
		const created: FlowAccumulator = {
			id,
			fields: new FieldBag<string>(),
			firstAt: null,
			lastAt: null,
			sources: new Set<SourceId>(),
		};
		flows.set(id, created);
		return created;
	};
	for (const file of discovery.files)
		if (file.workflowId !== undefined)
			flowOf(file.workflowId).sources.add(file.source);
	for (const { file, read } of herdrFiles) {
		const rank = sourceRank(file.source);
		for (const instance of read.instances) {
			const flow = flowOf(instance.id);
			flow.sources.add(file.source);
			flow.fields.set("repo", instance.repository, rank);
			flow.fields.set("definition_id", instance.definitionId, rank);
			flow.fields.set("branch", instance.branch, rank);
			flow.fields.set("base_commit", instance.baseCommit, rank);
			flow.fields.set("status", instance.status, rank);
			flow.fields.set("current_step", instance.currentStep, rank);
			flow.firstAt = minIso(flow.firstAt, instance.createdAt);
			flow.lastAt = maxIso(flow.lastAt, instance.updatedAt);
		}
		for (const run of read.runs)
			flowOf(run.workflowId).sources.add(file.source);
	}
	for (const entry of tagged) {
		const id = entry.event.workflowId;
		if (id === undefined) continue;
		const flow = flowOf(id);
		flow.sources.add(entry.source);
		const rank = sourceRank(entry.source);
		if (
			entry.event.event === "workflow.started" ||
			entry.event.event === "legacy.migrated"
		) {
			flow.fields.set("repo", entry.event.repo, rank);
			flow.fields.set("branch", entry.event.branch, rank);
			flow.fields.set("base_commit", entry.event.baseCommit, rank);
			flow.fields.set(
				"definition_id",
				entry.event.definitionId ?? entry.event.workflowType,
				rank,
			);
		}
		if (entry.event.workflowType !== undefined)
			flow.fields.set("workflow_type", entry.event.workflowType, rank);
		flow.fields.set("status", entry.event.herdrStatus, rank);
		flow.firstAt = minIso(flow.firstAt, entry.event.at);
		flow.lastAt = maxIso(flow.lastAt, entry.event.at);
	}

	// ---- runs ------------------------------------------------------------
	const runs = new Map<string, RunAccumulator>();
	const runOf = (
		runId: string,
		confidence: Confidence = "exact",
	): RunAccumulator => {
		const existing = runs.get(runId);
		if (existing) {
			if (confidence === "exact") existing.confidence = "exact";
			return existing;
		}
		const created: RunAccumulator = {
			runId,
			label: null,
			fields: new FieldBag<string>(),
			firstAt: null,
			lastAt: null,
			durationMs: null,
			sources: new Set<SourceId>(),
			confidence,
		};
		runs.set(runId, created);
		return created;
	};
	const handleNames = new Map<string, string>();
	for (const { file, read } of herdrFiles) {
		const rank = sourceRank(file.source);
		for (const run of read.runs) {
			const accumulator = runOf(run.runId, "exact");
			accumulator.sources.add(file.source);
			accumulator.label = accumulator.label ?? run.handleName ?? null;
			accumulator.fields.set("workflow_id", run.workflowId, rank);
			accumulator.fields.set("step_id", run.stepId, rank);
			accumulator.fields.set("role", run.role, rank);
			accumulator.fields.set("profile", run.profile, rank);
			accumulator.fields.set("model", run.model, rank);
			accumulator.fields.set("runtime", run.runtime, rank);
			accumulator.fields.set(
				"attempt",
				run.attempt === undefined ? undefined : String(run.attempt),
				rank,
			);
			accumulator.fields.set(
				"generation",
				run.generation === undefined ? undefined : String(run.generation),
				rank,
			);
			accumulator.fields.set("status", run.status, rank);
			accumulator.firstAt = minIso(accumulator.firstAt, run.createdAt);
			accumulator.lastAt = maxIso(accumulator.lastAt, run.completedAt);
			if (run.handleName !== undefined)
				handleNames.set(run.handleName, run.runId);
		}
	}
	for (const entry of tagged) {
		const runId = entry.event.runId;
		if (runId === undefined) continue;
		const accumulator = runOf(runId);
		accumulator.sources.add(entry.source);
		const rank = sourceRank(entry.source);
		accumulator.fields.set("workflow_id", entry.event.workflowId, rank);
		accumulator.fields.set("step_id", entry.event.stepId, rank);
		// The run's generation when the envelope carries one, so a telemetry-only
		// run states which attempt it was instead of staying NULL.
		accumulator.fields.set(
			"generation",
			entry.event.runGeneration === undefined
				? undefined
				: String(entry.event.runGeneration),
			rank,
		);
		accumulator.fields.set("role", entry.event.role, rank);
		accumulator.fields.set("profile", entry.event.profile, rank);
		accumulator.fields.set("model", entry.event.model, rank);
		accumulator.fields.set("provider", entry.event.provider, rank);
		accumulator.fields.set(
			"attempt",
			entry.event.attempt === undefined
				? undefined
				: String(entry.event.attempt),
			rank,
		);
		accumulator.firstAt = minIso(accumulator.firstAt, entry.event.at);
		accumulator.lastAt = maxIso(accumulator.lastAt, entry.event.at);
		if (entry.event.event === "agent.handoff") {
			accumulator.fields.set(
				"handoff_outcome",
				entry.event.handoffOutcome,
				rank,
			);
			accumulator.fields.set(
				"handoff_reason",
				entry.event.handoffReason ?? entry.event.herdrStatus,
				rank,
			);
			accumulator.fields.set("completed_at", entry.event.at, rank);
			accumulator.durationMs =
				accumulator.durationMs ?? entry.event.durationMs ?? null;
		}
		if (entry.event.event === "agent.launch")
			accumulator.fields.set("started_at", entry.event.at, rank);
	}
	const runsByWorkflow = new Map<string, Set<string>>();
	for (const accumulator of runs.values()) {
		const workflowId = accumulator.fields.get("workflow_id");
		if (workflowId === null) continue;
		const set = runsByWorkflow.get(workflowId) ?? new Set<string>();
		set.add(accumulator.runId);
		runsByWorkflow.set(workflowId, set);
	}
	const attributed = attributeHarness(
		harnessFiles,
		handleNames,
		runsByWorkflow,
		notes,
	);
	for (const item of attributed) {
		const accumulator = runOf(item.runId, item.confidence);
		accumulator.sources.add(item.source);
		accumulator.label = accumulator.label ?? item.runLabel;
		accumulator.fields.set(
			"workflow_id",
			item.workflowId,
			sourceRank(item.source),
		);
		accumulator.fields.set(
			"role",
			item.runLabel?.split("-")[0],
			sourceRank(item.source),
		);
		accumulator.fields.set(
			"model",
			item.conversation.model,
			sourceRank(item.source),
		);
		accumulator.fields.set(
			"provider",
			item.conversation.provider,
			sourceRank(item.source),
		);
		const firstTurn = item.conversation.turns[0];
		accumulator.firstAt = minIso(accumulator.firstAt, firstTurn?.at);
	}

	// ---- turns, tool calls, events ---------------------------------------
	const turns: TurnRow[] = [];
	const toolCalls: ToolCallRow[] = [];
	const events: EventRow[] = [];
	const groups = new Map<string, TaggedEvent[]>();
	for (const entry of tagged) {
		const runId = entry.event.runId;
		if (runId === undefined) continue;
		const key = `${entry.source}\u0000${runId}`;
		const list = groups.get(key) ?? [];
		list.push(entry);
		groups.set(key, list);
	}
	const legacyGroups = new Map<string, TaggedEvent[]>();
	for (const entry of tagged) {
		if (entry.event.runId !== undefined) continue;
		const workflowId = entry.event.workflowId;
		if (workflowId === undefined) continue;
		// The oldest generation records no run id at all: one usage row per
		// assistant message and one call row per tool execution. They are kept as a
		// synthetic per-workflow, per-role run, so a workflow whose telemetry never
		// named a run is not silently absent from the call data. Engine events
		// without a run id are workflow-level and stay that way.
		if (!TURN_CALL_EVENT_NAMES.has(entry.event.event)) continue;
		const key = `${entry.source}\u0000${workflowId}\u0000${entry.event.role ?? "unknown"}`;
		const list = legacyGroups.get(key) ?? [];
		list.push(entry);
		legacyGroups.set(key, list);
	}

	for (const [key, group] of groups) {
		const [sourcePart, runIdPart] = key.split("\u0000");
		const source = sourcePart as SourceId;
		const runId = runIdPart ?? "";
		const accumulator = runs.get(runId);
		const workflowId = accumulator?.fields.get("workflow_id") ?? null;
		const runLabel = accumulator?.label ?? null;
		const composed = buildTelemetryTurns(
			group,
			runId,
			runLabel,
			workflowId,
			source,
		);
		turns.push(...composed.turns);
		toolCalls.push(
			...buildTelemetryToolCalls(
				group,
				composed.turnIndexByOrder,
				runId,
				runLabel,
				workflowId,
				source,
			),
		);
	}

	for (const [key, group] of legacyGroups) {
		const [sourcePart, workflowIdPart] = key.split("\u0000");
		const source = sourcePart as SourceId;
		const workflowId = workflowIdPart ?? null;
		const role = group[0]?.event.role ?? null;
		const runId = `${source}#${workflowId}#${role ?? "unknown"}`;
		const accumulator = runOf(runId, "heuristic");
		accumulator.label =
			accumulator.label ?? (role === null ? null : `${role}-legacy`);
		accumulator.sources.add(source);
		accumulator.fields.set("workflow_id", workflowId, sourceRank(source));
		accumulator.fields.set("role", role, sourceRank(source));
		accumulator.fields.set("status", "unknown", sourceRank(source));
		const composed = buildTelemetryTurns(
			group,
			runId,
			accumulator.label,
			workflowId,
			source,
		);
		turns.push(...composed.turns);
		toolCalls.push(
			...buildTelemetryToolCalls(
				group,
				composed.turnIndexByOrder,
				runId,
				accumulator.label,
				workflowId,
				source,
			),
		);
		for (const entry of group) {
			accumulator.fields.set(
				"model",
				entry.event.model,
				sourceRank(entry.source),
			);
			accumulator.fields.set(
				"provider",
				entry.event.provider,
				sourceRank(entry.source),
			);
		}
		const first = group.reduce<string | null>(
			(acc, entry) => minIso(acc, entry.event.at),
			null,
		);
		accumulator.firstAt = minIso(accumulator.firstAt, first ?? undefined);
	}

	for (const item of attributed) {
		const accumulator = runs.get(item.runId);
		turns.push(
			...harnessTurns(
				item.conversation,
				item.runId,
				item.workflowId,
				item.source,
			),
		);
		toolCalls.push(
			...harnessToolCalls(
				item.conversation,
				item.runId,
				item.workflowId,
				item.source,
			),
		);
		for (const compaction of item.conversation.compactions) {
			events.push({
				workflow_id: item.workflowId,
				run_id: item.runId,
				run_label: item.runLabel,
				source: item.source,
				source_rank: sourceRank(item.source),
				at: compaction.at ?? null,
				event: "pi.compaction",
				event_class: "compaction",
				step_id: accumulator?.fields.get("step_id") ?? null,
				role: accumulator?.fields.get("role") ?? null,
				outcome: "summary_placed",
				error_class: null,
				severity: null,
				count: 1,
				trace_id: null,
				// A placed summary carries no reason of its own: the envelope that
				// reported the compaction does (efficiency backlog item 6).
				compaction_kind: null,
				compaction_blocking: null,
				detail: null,
				wait_kind: null,
				repair_effects: null,
				repair_runs: null,
				repair_count: null,
				detail_hash: null,
				detail_bytes: compaction.summaryBytes,
				confidence: item.confidence,
				preferred: 0,
			});
		}
	}

	for (const entry of tagged) {
		const event = entry.event;
		if (TURN_AND_CALL_EVENTS.has(event.event)) continue;
		events.push({
			workflow_id: event.workflowId ?? null,
			run_id: event.runId ?? null,
			run_label:
				event.runId === undefined
					? null
					: (runs.get(event.runId)?.label ?? null),
			source: entry.source,
			source_rank: sourceRank(entry.source),
			at: iso(event.at),
			event: event.event,
			event_class: eventClass(event.event),
			step_id: event.stepId ?? null,
			role: event.role ?? null,
			outcome: event.handoffOutcome ?? event.outcome ?? event.verdict ?? null,
			error_class: errorClassOf(event),
			severity: event.severity ?? null,
			count: 1,
			trace_id: event.traceId ?? null,
			compaction_kind: event.compactionKind ?? null,
			compaction_blocking:
				event.compactionBlocking === undefined
					? null
					: Number(event.compactionBlocking),
			detail: (() => {
				const text = str(
					event.repairReason ??
						event.errorClass ??
						event.handoffReason ??
						event.reasonCode ??
						event.waitSubject ??
						null,
				);
				return text === null ? null : redactBounded(text, 160);
			})(),
			wait_kind: event.waitKind ?? null,
			repair_effects: event.repairEffects ?? null,
			repair_runs: event.repairRuns ?? null,
			repair_count: event.repairCount ?? null,
			detail_hash: event.detail?.hash ?? null,
			detail_bytes: event.detail?.bytes ?? null,
			confidence: "exact",
			preferred: 0,
		});
	}
	for (const { file, read } of herdrFiles) {
		for (const event of read.events) {
			const data = event.data ?? {};
			const outcome = typeof data.outcome === "string" ? data.outcome : null;
			// The durable event's own record of the repair (reason, expired effect ids,
			// retired run ids) is what this source extracts: the ids themselves stay in
			// the store, the dataset keeps their counts and the bounded reason. A
			// developer wait is a projection of state this log already holds, so its
			// boundary is only in the telemetry stream (`wait_kind` stays null here).
			const reason = typeof data.reason === "string" ? data.reason : null;
			const detailText = reason !== null && reason.length > 0 ? reason : null;
			events.push({
				workflow_id: event.workflowId,
				run_id: typeof data.runId === "string" ? data.runId : null,
				run_label: null,
				source: file.source,
				source_rank: sourceRank(file.source),
				at: event.at ?? null,
				event: event.type,
				event_class:
					event.type === "agent.handoff" ? "handoff" : eventClass(event.type),
				step_id: null,
				role: typeof data.role === "string" ? data.role : null,
				outcome,
				error_class: null,
				severity: null,
				count: 1,
				trace_id: null,
				compaction_kind: null,
				compaction_blocking: null,
				detail: detailText === null ? null : redactBounded(detailText, 160),
				wait_kind: null,
				repair_effects: idCount(data.expiredEffects),
				repair_runs: idCount(data.retiredRuns),
				repair_count:
					typeof data.repairCount === "number" ? data.repairCount : null,
				detail_hash: null,
				detail_bytes: null,
				confidence: "exact",
				preferred: 0,
			});
		}
	}

	// ---- table rows ------------------------------------------------------
	const workflowRows: WorkflowRow[] = [...flows.values()].map((flow) => ({
		id: flow.id,
		repo: flow.fields.get("repo"),
		// `type` is the literal alias a reader looks for; it resolves to the
		// definition id where the engine recorded one, and to the workflow type
		// the migration events carry otherwise.
		type: flow.fields.get("definition_id") ?? flow.fields.get("workflow_type"),
		definition_id: flow.fields.get("definition_id"),
		workflow_type: flow.fields.get("workflow_type"),
		branch: flow.fields.get("branch"),
		base_commit: flow.fields.get("base_commit"),
		first_at: flow.firstAt,
		last_at: flow.lastAt,
		status: flow.fields.get("status"),
		current_step: flow.fields.get("current_step"),
		sources: [...flow.sources].sort().join(","),
		source: topSource(flow.sources),
		source_rank: topRank(flow.sources),
		confidence: [...flow.sources].every(
			(source) =>
				SOURCE_BY_ID.get(source)?.kind === "traces" ||
				SOURCE_BY_ID.get(source)?.kind === "harness",
		)
			? "heuristic"
			: "exact",
	}));

	const runRows: RunRow[] = [...runs.values()].map((accumulator) => {
		const workflowId = accumulator.fields.get("workflow_id");
		const status = accumulator.fields.get("status");
		const handoffOutcome = accumulator.fields.get("handoff_outcome");
		return {
			run_id: accumulator.runId,
			run_label: accumulator.label,
			workflow_id: workflowId,
			step_id: accumulator.fields.get("step_id"),
			role: accumulator.fields.get("role"),
			profile: accumulator.fields.get("profile"),
			model: accumulator.fields.get("model"),
			provider: accumulator.fields.get("provider"),
			attempt:
				accumulator.fields.get("attempt") === null
					? null
					: Number(accumulator.fields.get("attempt")),
			generation:
				accumulator.fields.get("generation") === null
					? null
					: Number(accumulator.fields.get("generation")),
			status: status ?? handoffOutcome,
			started_at: accumulator.fields.get("started_at") ?? accumulator.firstAt,
			completed_at:
				accumulator.fields.get("completed_at") ?? accumulator.lastAt,
			duration_ms: accumulator.durationMs,
			handoff_outcome: handoffOutcome,
			handoff_reason: accumulator.fields.get("handoff_reason"),
			sources: [...accumulator.sources].sort().join(","),
			source: topSource(accumulator.sources),
			source_rank: topRank(accumulator.sources),
			confidence: accumulator.confidence,
			preferred: 0,
		};
	});

	return {
		tables: {
			workflows: workflowRows,
			runs: runRows,
			turns,
			toolCalls,
			events,
			sourceFiles,
			notes: notes.concat(discovery.notes),
		},
		discoveryFiles: discovery.files.length,
		discoveryMissing: discovery.missing,
	};
}

export { SOURCE_BY_ID, sourceRank };

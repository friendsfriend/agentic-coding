// Source identities, precedence ranks and dataset row shapes.
//
// The rank is the documented de-duplication precedence: the same run appears in
// the durable store, in telemetry, in the OTel span store and (for newer
// workflows) in a harness transcript, and exactly one of those is treated as
// the preferred record for each table. Turns and tool calls prefer the harness
// because it is the only transcript with a stop reason, thinking tokens and
// result sizes; run identity and status prefer the durable store. Every row
// keeps its own `source`, so a later step can always look at the losers too.

export type SourceId =
	| "herdr.main-store"
	| "herdr.backend"
	| "telemetry.main-store"
	| "telemetry.worktree"
	| "telemetry.backend"
	| "harness.orchestrator"
	| "harness.wiki"
	| "harness.backend"
	| "harness.main-store"
	| "harness.worktree"
	| "traces.otel-tui";

export type SourceKind = "herdr" | "telemetry" | "harness" | "traces";

export interface SourceDescriptor {
	source: SourceId;
	kind: SourceKind;
	rank: number;
	description: string;
}

/** Higher rank wins when the same fact appears in several sources. */
export const SOURCE_LIST: readonly SourceDescriptor[] = [
	{
		source: "herdr.main-store",
		kind: "herdr",
		rank: 190,
		description:
			"Durable workflow store of the agentic-coding repo (plus its 2026-10-14 backup).",
	},
	{
		source: "herdr.backend",
		kind: "herdr",
		rank: 190,
		description:
			"Durable workflow store of the grid-allocation-backend environment setup.",
	},
	{
		source: "harness.worktree",
		kind: "harness",
		rank: 100,
		description: "pi-durable transcript store inside a workflow worktree.",
	},
	{
		source: "harness.backend",
		kind: "harness",
		rank: 98,
		description:
			"pi-durable transcript store of the grid-allocation-backend environment setup.",
	},
	{
		source: "harness.wiki",
		kind: "harness",
		rank: 96,
		description: "pi-durable transcript store of the wiki-workflows host.",
	},
	{
		source: "harness.orchestrator",
		kind: "harness",
		rank: 95,
		description:
			"pi-durable transcript store of the orchestrator conversation.",
	},
	{
		source: "harness.main-store",
		kind: "harness",
		rank: 94,
		description:
			"Stale pi-durable transcript store of the Oct-12 main store layout.",
	},
	{
		source: "telemetry.worktree",
		kind: "telemetry",
		rank: 70,
		description: "Per-worktree telemetry.jsonl in the span format.",
	},
	{
		source: "telemetry.backend",
		kind: "telemetry",
		rank: 68,
		description:
			"Per-run telemetry.jsonl of the grid-allocation-backend environment setup.",
	},
	{
		source: "telemetry.main-store",
		kind: "telemetry",
		rank: 66,
		description:
			"Per-workflow telemetry.jsonl of the main store, mixed legacy and span format.",
	},
	{
		source: "traces.otel-tui",
		kind: "traces",
		rank: 40,
		description:
			"OTel span store of the otel-tui receiver: the widest, coarsest source.",
	},
] as const;

export const SOURCE_BY_ID: ReadonlyMap<SourceId, SourceDescriptor> = new Map(
	SOURCE_LIST.map((descriptor) => [descriptor.source, descriptor]),
);

export function sourceRank(source: SourceId): number {
	return SOURCE_BY_ID.get(source)?.rank ?? 0;
}

export type Confidence = "exact" | "heuristic" | "unknown";

export interface SourceFileRow {
	source: SourceId;
	path: string;
	kind: string;
	records: number;
	parsed: number;
	skipped: number;
	note?: string;
}

export interface WorkflowRow {
	id: string;
	repo: string | null;
	/** The workflow definition id (solo, openspec, verify, ...). */
	type: string | null;
	definition_id: string | null;
	workflow_type: string | null;
	branch: string | null;
	base_commit: string | null;
	first_at: string | null;
	last_at: string | null;
	status: string | null;
	current_step: string | null;
	sources: string;
	source: SourceId;
	source_rank: number;
	confidence: Confidence;
}

export interface RunRow {
	run_id: string;
	run_label: string | null;
	workflow_id: string | null;
	step_id: string | null;
	role: string | null;
	profile: string | null;
	model: string | null;
	provider: string | null;
	attempt: number | null;
	generation: number | null;
	status: string | null;
	started_at: string | null;
	completed_at: string | null;
	duration_ms: number | null;
	handoff_outcome: string | null;
	handoff_reason: string | null;
	source: SourceId;
	source_rank: number;
	sources: string;
	confidence: Confidence;
	preferred: number;
}

export interface TurnRow {
	run_id: string;
	run_label: string | null;
	workflow_id: string | null;
	source: SourceId;
	source_rank: number;
	turn_index: number;
	started_at: string | null;
	ended_at: string | null;
	duration_ms: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	total_tokens: number | null;
	cost: number | null;
	thinking_tokens: number | null;
	stop_reason: string | null;
	tool_calls: number | null;
	model: string | null;
	provider: string | null;
	confidence: Confidence;
	preferred: number;
}

/** Which recording a tool call came from. The telemetry generations differ in
 * what they carry, so a per-generation share is the only honest way to say
 * "unknown = 0" for the newest one. */
export type ToolCallRecording = "legacy" | "span" | "harness";

export interface ToolCallRow {
	run_id: string;
	run_label: string | null;
	workflow_id: string | null;
	source: SourceId;
	source_rank: number;
	turn_index: number | null;
	call_id: string | null;
	dedupe_key: string;
	tool: string;
	started_at: string | null;
	ended_at: string | null;
	duration_ms: number | null;
	/** 1 ok, 0 failed, null unknown. */
	ok: number | null;
	error_class: string | null;
	/** Machine-readable failure kind (`not-found`, `no-match`, `denied`,
	 * `host-error`, `timeout`, `aborted`, `invalid-args`, `other`), null when the
	 * recording has no vocabulary for the failure. */
	failure_kind: string | null;
	args_hash: string | null;
	args_digest: string | null;
	args_bytes: number | null;
	result_bytes: number | null;
	result_lines: number | null;
	result_truncated: number | null;
	recording: ToolCallRecording;
	confidence: Confidence;
	preferred: number;
}

export type EventClass =
	| "lifecycle"
	| "handoff"
	| "effect"
	| "gate"
	| "verifier"
	| "triage"
	| "compaction"
	| "delivery"
	| "routing"
	| "wait"
	| "other";

export interface EventRow {
	workflow_id: string | null;
	run_id: string | null;
	run_label: string | null;
	source: SourceId;
	source_rank: number;
	at: string | null;
	event: string;
	event_class: EventClass;
	step_id: string | null;
	role: string | null;
	outcome: string | null;
	error_class: string | null;
	severity: string | null;
	count: number;
	trace_id: string | null;
	/** The envelope's own compaction kind and blocking flag, when it carried one. */
	compaction_kind: string | null;
	compaction_blocking: number | null;
	/** A free-text detail about the event, bounded and credential-masked. A repair
	 * carries its bounded reason here and a waiting event its subject id. */
	detail: string | null;
	/** The wait kind a `workflow.waiting`/`workflow.waiting.ended` row reports
	 * (efficiency backlog item 12). Append-only: an older dataset reads NULL. */
	wait_kind: string | null;
	/** How many effects the repair expired and how many runs it retired. */
	repair_effects: number | null;
	repair_runs: number | null;
	/** The workflow-level repair counter the engine recorded with the row: how
	 * many repairs the workflow had by then, this one included. */
	repair_count: number | null;
	detail_hash: string | null;
	detail_bytes: number | null;
	confidence: Confidence;
	preferred: number;
}

export interface ExtractedTables {
	workflows: WorkflowRow[];
	runs: RunRow[];
	turns: TurnRow[];
	toolCalls: ToolCallRow[];
	events: EventRow[];
	sourceFiles: SourceFileRow[];
	notes: string[];
}

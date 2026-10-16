// The ready-made analysis queries later steps reuse.
//
// Every query reads the preferred rows only (`v_runs`, `v_turns`,
// `v_tool_calls`, `v_events`), so a workflow that appears in three sources is
// counted once. The base tables keep the losing rows: `reconciliation` is the
// one query that deliberately looks at all of them, to check that the sources
// agree about a run.

export interface AnalysisQuery {
	/** Subcommand name of `analyze.ts`. */
	name: string;
	summary: string;
	sql: string;
	/** One example invocation, quoted in the docs. */
	example: string;
	/** Apply the CLI's `--limit` to this query. */
	limitable?: boolean;
	/** Default row bound for a limitable query. */
	limit?: number;
	columns: string[];
}

const RUN_SUMMARY_COLUMNS = [
	"run_id",
	"workflow_id",
	"role",
	"step_id",
	"status",
	"turns",
	"tool_calls",
	"failed_calls",
	"input_tokens",
	"output_tokens",
	"cost",
];

export const QUERIES: readonly AnalysisQuery[] = [
	{
		name: "summary",
		summary: "Totals per table for the preferred rows, as a sanity baseline.",
		example:
			"bun run scripts/efficiency/analyze.ts summary --dataset ~/ev/dataset-2026",
		sql: `SELECT
	(SELECT COUNT(*) FROM workflows) AS workflows,
	(SELECT COUNT(*) FROM v_runs) AS runs,
	(SELECT COUNT(*) FROM v_turns) AS turns,
	(SELECT COUNT(*) FROM v_tool_calls) AS tool_calls,
	(SELECT COUNT(*) FROM v_events) AS events,
	(SELECT SUM(input_tokens) FROM v_turns) AS input_tokens,
	(SELECT SUM(output_tokens) FROM v_turns) AS output_tokens,
	(SELECT SUM(cache_read_tokens) FROM v_turns) AS cache_read_tokens,
	(SELECT SUM(cache_write_tokens) FROM v_turns) AS cache_write_tokens,
	(SELECT ROUND(SUM(cost), 4) FROM v_turns) AS cost,
	(SELECT COUNT(*) FROM v_runs WHERE confidence <> 'exact') AS heuristic_runs,
	(SELECT COUNT(*) FROM v_tool_calls WHERE args_hash IS NOT NULL) AS calls_with_args`,
		columns: [
			"workflows",
			"runs",
			"turns",
			"tool_calls",
			"events",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"cost",
			"heuristic_runs",
			"calls_with_args",
		],
	},
	{
		name: "roles",
		summary: "Usage, cost and call volume per role and step.",
		example:
			"bun run scripts/efficiency/analyze.ts roles --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 100,
		columns: [
			"role",
			"step_id",
			"runs",
			"turns",
			"tool_calls",
			"failed_calls",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cost",
		],
		sql: `SELECT
	role,
	step_id,
	COUNT(*) AS runs,
	SUM(turns) AS turns,
	SUM(tool_calls) AS tool_calls,
	SUM(failed_calls) AS failed_calls,
	SUM(input_tokens) AS input_tokens,
	SUM(output_tokens) AS output_tokens,
	SUM(cache_read_tokens) AS cache_read_tokens,
	ROUND(SUM(cost), 4) AS cost
FROM v_run_summary
GROUP BY role, step_id
ORDER BY cost IS NULL, cost DESC, runs DESC`,
	},
	{
		name: "tools",
		summary: "Tool-call frequency and result volume per role.",
		example:
			"bun run scripts/efficiency/analyze.ts tools --dataset ~/ev/dataset-2026 --limit 40",
		limitable: true,
		limit: 60,
		columns: [
			"role",
			"tool",
			"calls",
			"failures",
			"result_bytes",
			"result_lines",
		],
		sql: `SELECT
	r.role AS role,
	c.tool AS tool,
	COUNT(*) AS calls,
	SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS failures,
	SUM(COALESCE(c.result_bytes, 0)) AS result_bytes,
	SUM(COALESCE(c.result_lines, 0)) AS result_lines
FROM v_tool_calls c
JOIN v_runs r ON r.run_id = c.run_id
GROUP BY r.role, c.tool
ORDER BY calls DESC`,
	},
	{
		name: "repeated-calls",
		summary:
			"Identical calls inside one run (same tool and argument hash), with the result bytes a repeat cost.",
		example:
			"bun run scripts/efficiency/analyze.ts repeated-calls --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 200,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"tool",
			"args_hash",
			"calls",
			"digest",
			"total_result_bytes",
			"wasted_result_bytes",
		],
		sql: `SELECT
	c.run_id AS run_id,
	r.workflow_id AS workflow_id,
	r.role AS role,
	c.tool AS tool,
	c.args_hash AS args_hash,
	COUNT(*) AS calls,
	MAX(c.args_digest) AS digest,
	SUM(COALESCE(c.result_bytes, 0)) AS total_result_bytes,
	SUM(COALESCE(c.result_bytes, 0)) - MAX(COALESCE(c.result_bytes, 0)) AS wasted_result_bytes
FROM v_tool_calls c
JOIN v_runs r ON r.run_id = c.run_id
WHERE c.args_hash IS NOT NULL
GROUP BY c.run_id, c.tool, c.args_hash
HAVING COUNT(*) > 1
ORDER BY wasted_result_bytes DESC`,
	},
	{
		name: "repeated-reads",
		summary: "The same file read more than once inside one run.",
		example:
			"bun run scripts/efficiency/analyze.ts repeated-reads --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 200,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"path_digest",
			"reads",
			"result_bytes",
		],
		sql: `SELECT
	c.run_id AS run_id,
	r.workflow_id AS workflow_id,
	r.role AS role,
	c.args_digest AS path_digest,
	COUNT(*) AS reads,
	SUM(COALESCE(c.result_bytes, 0)) AS result_bytes
FROM v_tool_calls c
JOIN v_runs r ON r.run_id = c.run_id
WHERE c.tool IN ('read', 'cat', 'head', 'tail')
	AND c.args_digest IS NOT NULL
GROUP BY c.run_id, c.args_digest
HAVING COUNT(*) > 1
ORDER BY result_bytes DESC`,
	},
	{
		name: "calls-per-turn",
		summary: "Distribution of tool calls per turn.",
		example:
			"bun run scripts/efficiency/analyze.ts calls-per-turn --dataset ~/ev/dataset-2026",
		columns: ["bucket", "turns"],
		sql: `SELECT bucket, COUNT(*) AS turns FROM (
	SELECT CASE
		WHEN tool_calls IS NULL THEN 'unknown'
		WHEN tool_calls = 0 THEN '0'
		WHEN tool_calls = 1 THEN '1'
		WHEN tool_calls <= 3 THEN '2-3'
		WHEN tool_calls <= 10 THEN '4-10'
		ELSE '11+' END AS bucket
	FROM v_turns
)
GROUP BY bucket
ORDER BY CASE bucket
	WHEN 'unknown' THEN 0 WHEN '0' THEN 1 WHEN '1' THEN 2 WHEN '2-3' THEN 3
	WHEN '4-10' THEN 4 ELSE 5 END`,
	},
	{
		name: "failed-chains",
		summary:
			"Runs whose failing calls cluster into consecutive chains (a retry loop, not isolated errors).",
		example:
			"bun run scripts/efficiency/analyze.ts failed-chains --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"failed_calls",
			"chains",
			"longest_chain",
		],
		sql: `WITH ordered AS (
	SELECT
		c.id AS id,
		c.run_id AS run_id,
		r.workflow_id AS workflow_id,
		r.role AS role,
		c.tool AS tool,
		c.ok AS ok,
		COALESCE(c.started_at, '') AS at,
		SUM(CASE WHEN c.ok = 0 THEN 0 ELSE 1 END)
			OVER (PARTITION BY c.run_id ORDER BY COALESCE(c.started_at, ''), c.id) AS success_prefix
	FROM v_tool_calls c
	JOIN v_runs r ON r.run_id = c.run_id
),
chains AS (
	SELECT run_id, workflow_id, role, success_prefix, COUNT(*) AS chain_len
	FROM ordered
	WHERE ok = 0
	GROUP BY run_id, success_prefix
)
SELECT
	run_id,
	workflow_id,
	role,
	SUM(chain_len) AS failed_calls,
	COUNT(*) AS chains,
	MAX(chain_len) AS longest_chain
FROM chains
GROUP BY run_id
ORDER BY longest_chain DESC, failed_calls DESC`,
	},
	{
		name: "turn-gaps",
		summary: "Idle gaps between consecutive turns of a run, largest first.",
		example:
			"bun run scripts/efficiency/analyze.ts turn-gaps --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"turn_index",
			"previous_end",
			"started_at",
			"gap_seconds",
		],
		sql: `WITH ordered AS (
	SELECT
		t.run_id AS run_id,
		r.workflow_id AS workflow_id,
		r.role AS role,
		t.turn_index AS turn_index,
		t.started_at AS started_at,
		LAG(t.ended_at) OVER (PARTITION BY t.run_id ORDER BY t.turn_index) AS previous_end
	FROM v_turns t
	JOIN v_runs r ON r.run_id = t.run_id
	WHERE t.started_at IS NOT NULL
)
SELECT
	run_id,
	workflow_id,
	role,
	turn_index,
	previous_end,
	started_at,
	CAST((julianday(started_at) - julianday(previous_end)) * 86400 AS INTEGER) AS gap_seconds
FROM ordered
WHERE previous_end IS NOT NULL
ORDER BY gap_seconds DESC`,
	},
	{
		name: "usage-by-workflow",
		summary: "Usage and cost per workflow.",
		example:
			"bun run scripts/efficiency/analyze.ts usage-by-workflow --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"workflow_id",
			"repo",
			"runs",
			"turns",
			"tool_calls",
			"input_tokens",
			"output_tokens",
			"cost",
		],
		sql: `SELECT
	s.workflow_id AS workflow_id,
	w.repo AS repo,
	s.runs AS runs,
	s.turns AS turns,
	s.tool_calls AS tool_calls,
	s.input_tokens AS input_tokens,
	s.output_tokens AS output_tokens,
	ROUND(s.cost, 4) AS cost
FROM (
	SELECT
		workflow_id,
		COUNT(*) AS runs,
		SUM(turns) AS turns,
		SUM(tool_calls) AS tool_calls,
		SUM(input_tokens) AS input_tokens,
		SUM(output_tokens) AS output_tokens,
		SUM(cost) AS cost
	FROM v_run_summary
	GROUP BY workflow_id
) s
LEFT JOIN workflows w ON w.id = s.workflow_id
ORDER BY s.cost IS NULL, s.cost DESC, s.turns DESC`,
	},
	{
		name: "context-growth",
		summary:
			"Average and peak input tokens by turn position: how fast context grows.",
		example:
			"bun run scripts/efficiency/analyze.ts context-growth --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 200,
		columns: [
			"turn_index",
			"turns",
			"avg_input_tokens",
			"max_input_tokens",
			"avg_cache_read_tokens",
		],
		sql: `SELECT
	turn_index AS turn_index,
	COUNT(*) AS turns,
	CAST(AVG(input_tokens) AS INTEGER) AS avg_input_tokens,
	MAX(input_tokens) AS max_input_tokens,
	CAST(AVG(cache_read_tokens) AS INTEGER) AS avg_cache_read_tokens
FROM v_turns
WHERE input_tokens IS NOT NULL
GROUP BY turn_index
ORDER BY turn_index`,
	},
	{
		name: "cache-hit",
		summary:
			"Cache hit rate per run (cache reads over input plus cache reads).",
		example:
			"bun run scripts/efficiency/analyze.ts cache-hit --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"input_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"cache_hit_rate",
		],
		sql: `SELECT
	run_id,
	workflow_id,
	role,
	input_tokens,
	cache_read_tokens,
	cache_write_tokens,
	CASE
		WHEN COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0) > 0
		THEN ROUND(
			1.0 * COALESCE(cache_read_tokens, 0)
				/ (COALESCE(input_tokens, 0) + COALESCE(cache_read_tokens, 0)),
			3
		)
	END AS cache_hit_rate
FROM v_run_summary
WHERE input_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL
ORDER BY cache_hit_rate IS NULL, cache_hit_rate ASC`,
	},
	{
		name: "coverage",
		summary:
			"The per-workflow coverage matrix: which sources exist and what they carry.",
		example:
			"bun run scripts/efficiency/analyze.ts coverage --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 200,
		columns: [
			"id",
			"repo",
			"runs",
			"sources",
			"has_transcript",
			"has_usage",
			"has_tool_calls",
			"has_tool_args",
			"has_call_durations",
			"has_verifier_events",
		],
		sql: `SELECT
	id,
	repo,
	runs,
	sources,
	has_transcript,
	has_usage,
	has_tool_calls,
	has_tool_args,
	has_call_durations,
	has_verifier_events
FROM v_workflow_coverage
ORDER BY runs DESC, id`,
	},
	{
		name: "skipped",
		summary: "Per-source parse counts: how much of each file was unparseable.",
		example:
			"bun run scripts/efficiency/analyze.ts skipped --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 50,
		columns: ["source", "path", "kind", "records", "parsed", "skipped", "note"],
		sql: `SELECT source, path, kind, records, parsed, skipped, note
FROM source_files
ORDER BY skipped DESC, records DESC`,
	},
	{
		name: "reconciliation",
		summary:
			"For runs seen in more than one source, whether the sources agree on turn and tool counts.",
		example:
			"bun run scripts/efficiency/analyze.ts reconciliation --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 200,
		columns: ["run_id", "workflow_id", "role", "source", "turns", "tool_calls"],
		sql: `WITH turn_counts AS (
	SELECT run_id, source, COUNT(*) AS turns FROM turns GROUP BY run_id, source
),
call_counts AS (
	SELECT run_id, source, COUNT(*) AS tool_calls FROM tool_calls GROUP BY run_id, source
),
multi AS (
	SELECT run_id FROM turns GROUP BY run_id HAVING COUNT(DISTINCT source) > 1
)
SELECT
	t.run_id AS run_id,
	r.workflow_id AS workflow_id,
	r.role AS role,
	t.source AS source,
	t.turns AS turns,
	c.tool_calls AS tool_calls
FROM turn_counts t
JOIN multi m ON m.run_id = t.run_id
LEFT JOIN v_runs r ON r.run_id = t.run_id
LEFT JOIN call_counts c ON c.run_id = t.run_id AND c.source = t.source
ORDER BY t.run_id, t.source`,
	},
	{
		name: "events",
		summary: "Event counts by class and name.",
		example:
			"bun run scripts/efficiency/analyze.ts events --dataset ~/ev/dataset-2026 --limit 30",
		limitable: true,
		limit: 100,
		columns: ["event_class", "event", "outcome", "count", "workflows"],
		sql: `SELECT
	event_class AS event_class,
	event AS event,
	COALESCE(outcome, '') AS outcome,
	SUM(count) AS count,
	COUNT(DISTINCT workflow_id) AS workflows
FROM v_events
GROUP BY event_class, event, outcome
ORDER BY count DESC`,
	},
	{
		name: "handoffs",
		summary:
			"Handoff outcomes, including the status that explains a blocked handoff.",
		example:
			"bun run scripts/efficiency/analyze.ts handoffs --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 200,
		columns: ["workflow_id", "run_id", "role", "outcome", "status", "at"],
		sql: `SELECT
	e.workflow_id AS workflow_id,
	e.run_id AS run_id,
	e.role AS role,
	COALESCE(e.outcome, '(none)') AS outcome,
	COALESCE(e.error_class, '') AS status,
	e.at AS at
FROM v_events e
WHERE e.event = 'agent.handoff'
ORDER BY e.at`,
	},
	{
		name: "effect-failures",
		summary: "Effect results that did not succeed, with their error class.",
		example:
			"bun run scripts/efficiency/analyze.ts effect-failures --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 200,
		columns: ["workflow_id", "step_id", "outcome", "error_class", "at"],
		sql: `SELECT workflow_id, step_id, outcome, error_class, at
FROM v_events
WHERE event = 'effect.result' AND (outcome IS NULL OR outcome <> 'ok' OR error_class IS NOT NULL)
ORDER BY at`,
	},
	{
		name: "verifier-findings",
		summary: "Verifier findings by severity and role.",
		example:
			"bun run scripts/efficiency/analyze.ts verifier-findings --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 100,
		columns: ["workflow_id", "role", "severity", "count"],
		sql: `SELECT
	workflow_id AS workflow_id,
	COALESCE(role, '') AS role,
	COALESCE(severity, 'unknown') AS severity,
	SUM(count) AS count
FROM v_events
WHERE event LIKE 'verification_finding%'
GROUP BY workflow_id, role, severity
ORDER BY count DESC`,
	},
	{
		name: "runs",
		summary:
			"Per-run rollup straight from the dataset, for eyeballing one workflow.",
		example:
			"bun run scripts/efficiency/analyze.ts runs --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: RUN_SUMMARY_COLUMNS,
		sql: `SELECT ${RUN_SUMMARY_COLUMNS.join(", ")}
FROM v_run_summary
ORDER BY workflow_id, started_at`,
	},
];

export function queryByName(name: string): AnalysisQuery | undefined {
	return QUERIES.find((query) => query.name === name);
}

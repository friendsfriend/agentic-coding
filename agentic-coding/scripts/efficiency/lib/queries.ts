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
		name: "orientation-cost",
		summary:
			"How much of a role's turns and cost is spent before it writes its first artifact (a write/edit call).",
		example:
			"bun run scripts/efficiency/analyze.ts orientation-cost --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 100,
		columns: [
			"role",
			"step_id",
			"runs",
			"runs_with_artifact",
			"avg_first_artifact_turn",
			"turns",
			"turns_before",
			"turn_share_before",
			"cost",
			"cost_before",
			"cost_share_before",
		],
		sql: `WITH per_run AS (
	SELECT
		r.run_id AS run_id,
		r.role AS role,
		COALESCE(NULLIF(r.step_id, ''), '(none)') AS step_id,
		(SELECT COUNT(*) FROM v_turns t WHERE t.run_id = r.run_id) AS turns,
		(SELECT COALESCE(SUM(t.cost), 0) FROM v_turns t WHERE t.run_id = r.run_id) AS cost,
		(SELECT MIN(c.turn_index) FROM v_tool_calls c
			WHERE c.run_id = r.run_id AND c.tool IN ('write', 'edit')) AS first_artifact_turn
	FROM v_runs r
),
split AS (
	SELECT
		p.*,
		(SELECT COUNT(*) FROM v_turns t
			WHERE t.run_id = p.run_id AND t.turn_index < p.first_artifact_turn) AS turns_before,
		(SELECT COALESCE(SUM(t.cost), 0) FROM v_turns t
			WHERE t.run_id = p.run_id AND t.turn_index < p.first_artifact_turn) AS cost_before
	FROM per_run p
)
SELECT
	role,
	step_id,
	COUNT(*) AS runs,
	SUM(CASE WHEN first_artifact_turn IS NOT NULL THEN 1 ELSE 0 END) AS runs_with_artifact,
	ROUND(AVG(first_artifact_turn), 1) AS avg_first_artifact_turn,
	SUM(turns) AS turns,
	SUM(turns_before) AS turns_before,
	ROUND(1.0 * SUM(turns_before) / NULLIF(SUM(turns), 0), 3) AS turn_share_before,
	ROUND(SUM(cost), 4) AS cost,
	ROUND(SUM(cost_before), 4) AS cost_before,
	ROUND(1.0 * SUM(cost_before) / NULLIF(SUM(cost), 0), 3) AS cost_share_before
FROM split
GROUP BY role, step_id
ORDER BY SUM(cost) IS NULL, SUM(cost) DESC, runs DESC`,
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
		name: "cache-expiry",
		summary:
			"Turns bucketed by the idle gap before them, with their cache reads/writes and cost: a provider prompt cache expires between turns, so a gapped turn re-writes the whole prefix at the write rate instead of reading it.",
		example:
			"bun run scripts/efficiency/analyze.ts cache-expiry --dataset ~/ev/dataset-2026",
		limit: 10,
		columns: [
			"idle_bucket",
			"turns",
			"avg_gap_seconds",
			"cache_write_tokens",
			"cache_read_tokens",
			"cost",
		],
		sql: `WITH ordered AS (
	SELECT
		run_id AS run_id,
		turn_index AS turn_index,
		started_at AS started_at,
		cost AS cost,
		input_tokens AS input_tokens,
		cache_read_tokens AS cache_read_tokens,
		cache_write_tokens AS cache_write_tokens,
		LAG(ended_at) OVER (PARTITION BY run_id ORDER BY turn_index) AS previous_end
	FROM v_turns
	WHERE started_at IS NOT NULL
),
gapped AS (
	SELECT
		*,
		CAST((julianday(started_at) - julianday(previous_end)) * 86400 AS INTEGER) AS gap_seconds
	FROM ordered
	WHERE previous_end IS NOT NULL
)
SELECT
	CASE
		WHEN gap_seconds < 60 THEN '<1m'
		WHEN gap_seconds < 300 THEN '1-5m'
		WHEN gap_seconds < 600 THEN '5-10m'
		WHEN gap_seconds < 3600 THEN '10-60m'
		ELSE '>1h'
	END AS idle_bucket,
	COUNT(*) AS turns,
	CAST(AVG(gap_seconds) AS INTEGER) AS avg_gap_seconds,
	SUM(cache_write_tokens) AS cache_write_tokens,
	SUM(cache_read_tokens) AS cache_read_tokens,
	ROUND(SUM(cost), 4) AS cost
FROM gapped
GROUP BY idle_bucket
ORDER BY MIN(gap_seconds)`,
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
		name: "verifier-rounds",
		summary:
			"Verifier rounds reconstructed from run timing (20-minute gap), with roles, runs, turns, calls and cost per round. Runs without a start time are excluded.",
		example:
			"bun run scripts/efficiency/analyze.ts verifier-rounds --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"workflow_id",
			"round_index",
			"roles",
			"runs",
			"turns",
			"tool_calls",
			"cost",
		],
		sql: `WITH verifier_runs AS (
	SELECT
		r.workflow_id AS workflow_id,
		r.started_at AS started_at,
		r.role AS role,
		(SELECT COUNT(*) FROM v_turns t WHERE t.run_id = r.run_id) AS turns,
		(SELECT COUNT(*) FROM v_tool_calls c WHERE c.run_id = r.run_id) AS tool_calls,
		COALESCE((SELECT SUM(cost) FROM v_turns t WHERE t.run_id = r.run_id), 0) AS cost
	FROM v_runs r
	WHERE r.role LIKE '%verifier%' AND r.started_at IS NOT NULL
),
marked AS (
	SELECT
		*,
		CASE
			WHEN julianday(started_at) - julianday(LAG(started_at) OVER (PARTITION BY workflow_id ORDER BY started_at)) > (20.0 / 1440.0)
			THEN 1
			ELSE 0
		END AS new_round
	FROM verifier_runs
),
numbered AS (
	SELECT
		*,
		SUM(new_round) OVER (PARTITION BY workflow_id ORDER BY started_at) + 1 AS round_index
	FROM marked
)
SELECT
	workflow_id AS workflow_id,
	round_index AS round_index,
	COUNT(DISTINCT role) AS roles,
	COUNT(*) AS runs,
	SUM(turns) AS turns,
	SUM(tool_calls) AS tool_calls,
	ROUND(SUM(cost), 4) AS cost
FROM numbered
GROUP BY workflow_id, round_index
ORDER BY cost DESC`,
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
	{
		name: "edit-latency",
		summary:
			"Orientation cost per run: how many calls and result bytes come before the first edit.",
		example:
			"bun run scripts/efficiency/analyze.ts edit-latency --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"calls",
			"first_edit_call",
			"pre_edit_calls",
			"pre_edit_call_pct",
			"pre_edit_result_bytes",
			"pre_edit_reads",
			"pre_edit_bash",
		],
		sql: `WITH ranked AS (
	SELECT
		c.run_id AS run_id,
		c.tool AS tool,
		COALESCE(c.result_bytes, 0) AS bytes,
		ROW_NUMBER() OVER (
			PARTITION BY c.run_id
			ORDER BY COALESCE(c.turn_index, 1000000), c.started_at, c.id
		) AS rn
	FROM v_tool_calls c
), first_edit AS (
	SELECT run_id, MIN(rn) AS edit_at
	FROM ranked
	WHERE tool IN ('edit', 'write')
	GROUP BY run_id
), scoped AS (
	SELECT
		x.run_id AS run_id,
		x.tool AS tool,
		x.bytes AS bytes,
		(f.edit_at IS NULL OR x.rn < f.edit_at) AS is_pre
	FROM ranked x
	LEFT JOIN first_edit f ON f.run_id = x.run_id
)
SELECT
	s.run_id AS run_id,
	r.workflow_id AS workflow_id,
	r.role AS role,
	COUNT(*) AS calls,
	MAX(f.edit_at) AS first_edit_call,
	SUM(CASE WHEN s.is_pre THEN 1 ELSE 0 END) AS pre_edit_calls,
	ROUND(100.0 * SUM(CASE WHEN s.is_pre THEN 1 ELSE 0 END) / COUNT(*), 1) AS pre_edit_call_pct,
	SUM(CASE WHEN s.is_pre THEN s.bytes ELSE 0 END) AS pre_edit_result_bytes,
	SUM(CASE WHEN s.is_pre AND s.tool IN ('read', 'grep') THEN 1 ELSE 0 END) AS pre_edit_reads,
	SUM(CASE WHEN s.is_pre AND s.tool = 'bash' THEN 1 ELSE 0 END) AS pre_edit_bash
FROM scoped s
JOIN v_runs r ON r.run_id = s.run_id
LEFT JOIN first_edit f ON f.run_id = s.run_id
GROUP BY s.run_id
ORDER BY pre_edit_result_bytes DESC, s.run_id`,
	},
	{
		name: "bash-vs-tools",
		summary:
			"Where a run's arguments survive: bash calls that a dedicated read/grep tool already covers.",
		example:
			"bun run scripts/efficiency/analyze.ts bash-vs-tools --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"profile",
			"bash_calls",
			"shell_for_a_tool",
			"shell_share_pct",
			"read_tool",
			"grep_tool",
		],
		sql: `SELECT
	c.run_id AS run_id,
	r.workflow_id AS workflow_id,
	COALESCE(r.profile, '(unset)') AS profile,
	SUM(CASE WHEN c.tool = 'bash' THEN 1 ELSE 0 END) AS bash_calls,
	SUM(CASE WHEN c.tool = 'bash' AND c.args_digest IN (
		'bash grep', 'bash rg', 'bash sed', 'bash cat', 'bash head',
		'bash tail', 'bash ls', 'bash find', 'bash awk', 'bash wc'
	) THEN 1 ELSE 0 END) AS shell_for_a_tool,
	ROUND(
		100.0 * SUM(CASE WHEN c.tool = 'bash' AND c.args_digest IN (
			'bash grep', 'bash rg', 'bash sed', 'bash cat', 'bash head',
			'bash tail', 'bash ls', 'bash find', 'bash awk', 'bash wc'
		) THEN 1 ELSE 0 END)
		/ NULLIF(SUM(CASE WHEN c.tool = 'bash' AND c.args_digest IS NOT NULL THEN 1 ELSE 0 END), 0),
		1
	) AS shell_share_pct,
	SUM(CASE WHEN c.tool = 'read' THEN 1 ELSE 0 END) AS read_tool,
	SUM(CASE WHEN c.tool = 'grep' THEN 1 ELSE 0 END) AS grep_tool
FROM v_tool_calls c
JOIN v_runs r ON r.run_id = c.run_id
WHERE c.args_digest IS NOT NULL
GROUP BY c.run_id
ORDER BY shell_for_a_tool DESC, c.run_id`,
	},
	{
		name: "stalled-runs",
		summary:
			"Runs that were started and produced two turns or fewer: engine and queue waste.",
		example:
			"bun run scripts/efficiency/analyze.ts stalled-runs --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"run_label",
			"role",
			"profile",
			"status",
			"turns",
			"calls",
			"started_at",
		],
		sql: `SELECT
	r.run_id AS run_id,
	r.workflow_id AS workflow_id,
	r.run_label AS run_label,
	r.role AS role,
	COALESCE(r.profile, '(unset)') AS profile,
	r.status AS status,
	COALESCE(t.turns, 0) AS turns,
	COALESCE(c.calls, 0) AS calls,
	r.started_at AS started_at
FROM v_runs r
LEFT JOIN (SELECT run_id, COUNT(*) AS turns FROM v_turns GROUP BY run_id) t
	ON t.run_id = r.run_id
LEFT JOIN (SELECT run_id, COUNT(*) AS calls FROM v_tool_calls GROUP BY run_id) c
	ON c.run_id = r.run_id
WHERE COALESCE(t.turns, 0) <= 2
ORDER BY r.started_at, r.run_id`,
	},
	{
		name: "source-gaps",
		summary:
			"Snapshot files the build parsed into zero rows: a whole source can be lost while every workflow count still looks plausible.",
		example:
			"bun run scripts/efficiency/analyze.ts source-gaps --dataset ~/ev/dataset-2026",
		limitable: true,
		limit: 50,
		columns: ["source", "path", "kind", "records", "parsed", "skipped", "note"],
		sql: `SELECT source, path, kind, records, parsed, skipped, note
FROM source_files
WHERE parsed = 0
ORDER BY source, path`,
		name: "delivery-timeline",
		summary:
			"Per workflow: the archive and push latencies the delivery events record, the developer wait after a push and after a wiki approval, and the effect/git failure counts beside them.",
		example:
			"bun run scripts/efficiency/analyze.ts delivery-timeline --dataset ~/ev/dataset-2026",
		columns: [
			"workflow_id",
			"archive_started_at",
			"archive_seconds",
			"push_seconds",
			"pushed_to_closed_minutes",
			"wiki_approval_at",
			"wiki_approval_to_archive_minutes",
			"archive_runs",
			"wiki_runs",
			"effect_results",
			"git_failures",
		],
		sql: `WITH phase AS (
	SELECT
		workflow_id AS workflow_id,
		MIN(CASE WHEN event = 'archive_started' THEN substr(at, 1, 23) END) AS archive_started_at,
		MIN(CASE WHEN event = 'archive_completed' THEN substr(at, 1, 23) END) AS archive_completed_at,
		MIN(CASE WHEN event = 'git_operations_started' THEN substr(at, 1, 23) END) AS git_started_at,
		MIN(CASE WHEN event = 'git_operations_pushed' THEN substr(at, 1, 23) END) AS pushed_at,
		MIN(CASE WHEN event = 'workflow_closed' THEN substr(at, 1, 23) END) AS closed_at,
		SUM(CASE WHEN event = 'git_operations_failed' THEN 1 ELSE 0 END) AS git_failures,
		SUM(CASE WHEN event_class = 'effect' THEN 1 ELSE 0 END) AS effect_results
	FROM v_events
	GROUP BY workflow_id
),
approval AS (
	SELECT
		workflow_id AS workflow_id,
		MIN(CASE WHEN event = 'agent.handoff' AND step_id = 'core.wiki-approval' THEN substr(at, 1, 23) END) AS wiki_approval_at
	FROM v_events
	GROUP BY workflow_id
),
next_archive_action AS (
	SELECT e.workflow_id AS workflow_id, MIN(substr(e.at, 1, 23)) AS at
	FROM v_events e
	JOIN approval a ON a.workflow_id = e.workflow_id
	WHERE e.event = 'developer.action'
		AND e.step_id IN ('core.archive', 'core.route-archive')
		AND a.wiki_approval_at IS NOT NULL
		AND substr(e.at, 1, 23) >= a.wiki_approval_at
	GROUP BY e.workflow_id
),
role_runs AS (
	SELECT workflow_id AS workflow_id,
		SUM(CASE WHEN role = 'archive' THEN 1 ELSE 0 END) AS archive_runs,
		SUM(CASE WHEN role = 'wiki' THEN 1 ELSE 0 END) AS wiki_runs
	FROM v_runs
	GROUP BY workflow_id
)
SELECT
	p.workflow_id AS workflow_id,
	p.archive_started_at AS archive_started_at,
	ROUND((julianday(p.archive_completed_at) - julianday(p.archive_started_at)) * 86400.0, 1) AS archive_seconds,
	ROUND((julianday(p.pushed_at) - julianday(p.git_started_at)) * 86400.0, 1) AS push_seconds,
	ROUND((julianday(p.closed_at) - julianday(p.pushed_at)) * 1440.0, 1) AS pushed_to_closed_minutes,
	a.wiki_approval_at AS wiki_approval_at,
	ROUND((julianday(n.at) - julianday(a.wiki_approval_at)) * 1440.0, 1) AS wiki_approval_to_archive_minutes,
	COALESCE(r.archive_runs, 0) AS archive_runs,
	COALESCE(r.wiki_runs, 0) AS wiki_runs,
	p.effect_results AS effect_results,
	p.git_failures AS git_failures
FROM phase p
LEFT JOIN approval a ON a.workflow_id = p.workflow_id
LEFT JOIN next_archive_action n ON n.workflow_id = p.workflow_id
LEFT JOIN role_runs r ON r.workflow_id = p.workflow_id
WHERE p.archive_started_at IS NOT NULL
	OR p.git_started_at IS NOT NULL
	OR a.wiki_approval_at IS NOT NULL
ORDER BY p.closed_at, p.workflow_id`,
		name: "run-window-drift",
		summary:
			"Runs whose turns continue well past the run's own recorded window: a resumed session still attributed to a finished run.",
		example:
			"bun run scripts/efficiency/analyze.ts run-window-drift --dataset ~/ev/dataset-2026 --limit 20",
		limitable: true,
		limit: 100,
		columns: [
			"run_id",
			"workflow_id",
			"role",
			"status",
			"run_started_at",
			"run_completed_at",
			"turns",
			"first_turn_at",
			"last_turn_at",
			"tail_seconds",
		],
		sql: `WITH turn_window AS (
	SELECT
		t.run_id AS run_id,
		MIN(t.started_at) AS first_turn_at,
		MAX(COALESCE(t.ended_at, t.started_at)) AS last_turn_at,
		COUNT(*) AS turns
	FROM v_turns t
	WHERE t.started_at IS NOT NULL
	GROUP BY t.run_id
)
SELECT
	r.run_id AS run_id,
	r.workflow_id AS workflow_id,
	COALESCE(r.role, '(unset)') AS role,
	COALESCE(r.status, '(unset)') AS status,
	r.started_at AS run_started_at,
	r.completed_at AS run_completed_at,
	w.turns AS turns,
	w.first_turn_at AS first_turn_at,
	w.last_turn_at AS last_turn_at,
	CAST((julianday(w.last_turn_at) - julianday(r.completed_at)) * 86400 AS INTEGER) AS tail_seconds
FROM v_runs r
JOIN turn_window w ON w.run_id = r.run_id
WHERE r.completed_at IS NOT NULL
	AND julianday(w.last_turn_at) - julianday(r.completed_at) > (1.0 / 1440.0)
ORDER BY tail_seconds DESC, r.run_id`,
	},
];

export function queryByName(name: string): AnalysisQuery | undefined {
	return QUERIES.find((query) => query.name === name);
}

// The data-inventory report.
//
// This is the only artifact the tooling writes into the repository, and it is
// generated: every number comes from the dataset, every list of affected
// workflows is computed, and nothing but ids, counts, source paths and digests
// reaches it. Its job is to say, before any judgement is made, what the data
// can and cannot answer.

import { Database } from "bun:sqlite";
import type { EvidenceDiscovery } from "./sources.ts";
import { SOURCE_LIST } from "./types.ts";

export interface InventoryInput {
	datasetPath: string;
	evidenceDir: string;
	discovery: EvidenceDiscovery;
	notes: string[];
	/** Workflows listed per gap table before the rest are counted. */
	top: number;
}

interface CoverageRow {
	id: string;
	repo: string | null;
	first_at: string | null;
	last_at: string | null;
	sources: string;
	confidence: string;
	runs: number;
	has_transcript: number;
	has_spans: number;
	has_durable_store: number;
	has_turns: number;
	has_usage: number;
	has_stop_reason: number;
	has_thinking: number;
	has_tool_calls: number;
	has_tool_args: number;
	has_result_sizes: number;
	has_call_durations: number;
	has_verifier_events: number;
	has_gate_events: number;
	has_compaction_events: number;
}

type CoverageClass =
	| "full (transcript + args)"
	| "calls with args"
	| "calls only"
	| "turns only"
	| "stub (no turns, no calls)";

function classify(row: CoverageRow): CoverageClass {
	if (!row.has_turns && !row.has_tool_calls) return "stub (no turns, no calls)";
	if (row.has_transcript && row.has_tool_args)
		return "full (transcript + args)";
	if (row.has_tool_args) return "calls with args";
	if (row.has_tool_calls) return "calls only";
	return "turns only";
}

function table(
	headers: readonly string[],
	rows: ReadonlyArray<readonly unknown[]>,
): string {
	const line = (cells: readonly unknown[]) => `| ${cells.join(" | ")} |`;
	return [
		line(headers),
		line(headers.map(() => "---")),
		...rows.map((row) =>
			line(
				row.map((cell) =>
					cell === null || cell === undefined ? "" : String(cell),
				),
			),
		),
	].join("\n");
}

function listOrNone(
	items: readonly string[],
	max: number,
	total: number,
): string {
	if (items.length === 0) return "none";
	const shown = items
		.slice(0, max)
		.map((item) => `\`${item}\``)
		.join(", ");
	const hidden = total - Math.min(items.length, max);
	return hidden > 0 ? `${shown} … (${hidden} more)` : shown;
}

export function buildInventory(input: InventoryInput): string {
	const db = new Database(input.datasetPath, { readonly: true });
	const all = <T>(sql: string): T[] => db.query<T, []>(sql).all();
	try {
		const headline =
			all<Record<string, number | null>>(
				`SELECT
	(SELECT COUNT(*) FROM workflows) AS workflows,
	(SELECT COUNT(*) FROM runs) AS runs,
	(SELECT COUNT(*) FROM turns) AS turns,
	(SELECT COUNT(*) FROM tool_calls) AS tool_calls,
	(SELECT COUNT(*) FROM events) AS events,
	(SELECT SUM(input_tokens) FROM v_turns) AS input_tokens,
	(SELECT SUM(output_tokens) FROM v_turns) AS output_tokens,
	(SELECT SUM(cache_read_tokens) FROM v_turns) AS cache_read_tokens,
	(SELECT SUM(cache_write_tokens) FROM v_turns) AS cache_write_tokens,
	(SELECT ROUND(SUM(cost), 4) FROM v_turns) AS cost`,
			)[0] ?? {};

		const coverage = all<CoverageRow>("SELECT * FROM v_workflow_coverage");
		const classes = new Map<CoverageClass, CoverageRow[]>();
		for (const row of coverage) {
			const key = classify(row);
			const list = classes.get(key) ?? [];
			list.push(row);
			classes.set(key, list);
		}
		const coverageOrder: CoverageClass[] = [
			"full (transcript + args)",
			"calls with args",
			"calls only",
			"turns only",
			"stub (no turns, no calls)",
		];

		const sourceTotals = all<{
			source: string;
			kind: string;
			files: number;
			records: number;
			parsed: number;
			skipped: number;
		}>(
			`SELECT source, kind, COUNT(*) AS files, COALESCE(SUM(records), 0) AS records,
			 COALESCE(SUM(parsed), 0) AS parsed, COALESCE(SUM(skipped), 0) AS skipped
			 FROM source_files GROUP BY source, kind ORDER BY source`,
		);
		const sourceFiles = all<{
			source: string;
			path: string;
			kind: string;
			records: number;
			parsed: number;
			skipped: number;
			note: string | null;
		}>(
			`SELECT source, path, kind, records, parsed, skipped, note FROM source_files
			 WHERE skipped > 0 OR note IS NOT NULL ORDER BY skipped DESC, path`,
		);

		const runSummary = all<Record<string, unknown>>(
			`SELECT * FROM v_run_summary ORDER BY workflow_id, started_at`,
		);
		const roleTotals = all<Record<string, unknown>>(
			`SELECT role, COUNT(*) AS runs,
			 COALESCE(SUM(turns), 0) AS turns,
			 COALESCE(SUM(tool_calls), 0) AS tool_calls,
			 COALESCE(SUM(failed_calls), 0) AS failed_calls,
			 SUM(input_tokens) AS input_tokens,
			 SUM(output_tokens) AS output_tokens,
			 SUM(cache_read_tokens) AS cache_read_tokens,
			 ROUND(SUM(cost), 4) AS cost
			 FROM v_run_summary GROUP BY role ORDER BY cost IS NULL, cost DESC`,
		);
		const roleTurns = all<Record<string, unknown>>(
			`SELECT r.role AS role,
			 SUM(CASE WHEN t.source LIKE 'harness%' THEN 1 ELSE 0 END) AS transcript_turns,
			 SUM(CASE WHEN t.input_tokens IS NOT NULL THEN 1 ELSE 0 END) AS usage_turns,
			 SUM(CASE WHEN t.stop_reason IS NOT NULL THEN 1 ELSE 0 END) AS stop_turns,
			 SUM(CASE WHEN t.thinking_tokens IS NOT NULL THEN 1 ELSE 0 END) AS thinking_turns
			 FROM v_turns t JOIN v_runs r ON r.run_id = t.run_id GROUP BY r.role`,
		);
		const roleCalls = all<Record<string, unknown>>(
			`SELECT r.role AS role, COUNT(*) AS calls,
			 SUM(CASE WHEN c.args_hash IS NOT NULL THEN 1 ELSE 0 END) AS with_args,
			 SUM(CASE WHEN c.result_bytes IS NOT NULL THEN 1 ELSE 0 END) AS with_bytes,
			 SUM(CASE WHEN c.duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS with_duration,
			 SUM(CASE WHEN c.ok = 0 THEN 1 ELSE 0 END) AS failures
			 FROM v_tool_calls c JOIN v_runs r ON r.run_id = c.run_id GROUP BY r.role`,
		);
		const eventTotals = all<Record<string, unknown>>(
			`SELECT event_class, event, COUNT(*) AS rows, SUM(count) AS occurrences,
			 COUNT(DISTINCT workflow_id) AS workflows
			 FROM v_events GROUP BY event_class, event ORDER BY occurrences DESC`,
		);
		const multiSourceRuns = all<{
			run_id: string;
			source: string;
			turns: number;
			tool_calls: number | null;
		}>(
			`SELECT t.run_id AS run_id, t.source AS source, t.turns AS turns, c.tool_calls AS tool_calls
			 FROM (SELECT run_id, source, COUNT(*) AS turns FROM turns GROUP BY run_id, source) t
			 LEFT JOIN (SELECT run_id, source, COUNT(*) AS tool_calls FROM tool_calls GROUP BY run_id, source) c
			   ON c.run_id = t.run_id AND c.source = t.source
			 WHERE t.run_id IN (SELECT run_id FROM turns GROUP BY run_id HAVING COUNT(DISTINCT source) > 1)
			 ORDER BY t.run_id, t.source`,
		);
		const harnessRuns = all<Record<string, unknown>>(
			`SELECT source, COUNT(*) AS runs, SUM(CASE WHEN confidence <> 'exact' THEN 1 ELSE 0 END) AS heuristic
			 FROM runs WHERE source LIKE 'harness%' GROUP BY source ORDER BY source`,
		);
		const unattributed = all<{
			run_id: string;
			workflow_id: string | null;
			source: string;
			confidence: string;
		}>(
			`SELECT run_id, workflow_id, source, confidence FROM runs
			 WHERE confidence <> 'exact' ORDER BY source, run_id`,
		);
		const tableSizes = all<{ name: string; rows: number }>(
			`SELECT 'meta' AS name, COUNT(*) AS rows FROM meta`,
		).length;
		void tableSizes;

		const groups = new Map<
			string,
			Array<{ source: string; turns: number; tool_calls: number | null }>
		>();
		for (const row of multiSourceRuns) {
			const list = groups.get(row.run_id) ?? [];
			list.push({
				source: row.source,
				turns: row.turns,
				tool_calls: row.tool_calls,
			});
			groups.set(row.run_id, list);
		}

		const worktreeTelemetry = input.discovery.files.filter(
			(file) => file.source === "telemetry.worktree",
		);
		const worktreeHarness = input.discovery.files.filter(
			(file) => file.source === "harness.worktree",
		);
		// Every workflow that had a worktree directory in the snapshot, whether or
		// not a harness store survived inside it.
		const worktreeDirs = new Set(
			input.discovery.files
				.map((file) => file.relative.match(/^worktrees\/([^/]+)\//)?.[1])
				.filter((name): name is string => name !== undefined),
		);

		const sections: string[] = [];
		sections.push(`# Efficiency dataset — data inventory

Generated by \`bun run scripts/efficiency/build-dataset.ts --evidence <evidence> --inventory docs/efficiency/00-data-inventory.md\`.
Do not hand-edit: re-run the builder. The dataset itself (\`dataset.sqlite\`) and
the evidence snapshot stay outside the repository; this document carries ids,
counts, source-relative paths and digests only — no prompt, transcript, tool
argument or tool result text.

Dataset schema version 1, snapshot \`<evidence>\` (see its \`MANIFEST.md\`).

## 1. Headline totals (preferred rows)

${table(
	["metric", "value"],
	[
		["workflows", headline.workflows],
		["runs", headline.runs],
		["turns", headline.turns],
		["tool calls", headline.tool_calls],
		["events", headline.events],
		["input tokens", headline.input_tokens],
		["output tokens", headline.output_tokens],
		["cache read tokens", headline.cache_read_tokens],
		["cache write tokens", headline.cache_write_tokens],
		["cost (provider units)", headline.cost],
	],
)}

## 2. Sources

${table(
	["source", "kind", "rank", "files", "records", "parsed", "skipped"],
	SOURCE_LIST.map((descriptor) => {
		const total = sourceTotals.find((row) => row.source === descriptor.source);
		return [
			descriptor.source,
			descriptor.kind,
			descriptor.rank,
			total?.files ?? 0,
			total?.records ?? 0,
			total?.parsed ?? 0,
			total?.skipped ?? 0,
		];
	}),
)}

Sources absent from this snapshot: ${input.discovery.missing.length === 0 ? "none" : input.discovery.missing.map((path) => `\`${path}\``).join(", ")}.

### Files with skipped or unreadable records

${
	sourceFiles.length === 0
		? "None: every record in every file parsed."
		: table(
				["source", "path", "kind", "records", "parsed", "skipped", "note"],
				sourceFiles.map((file) => [
					file.source,
					file.path,
					file.kind,
					file.records,
					file.parsed,
					file.skipped,
					file.note ?? "",
				]),
			)
}

## 3. Coverage headline

${table(
	["coverage class", "workflows", "share"],
	coverageOrder.map((key) => {
		const count = classes.get(key)?.length ?? 0;
		return [
			key,
			count,
			coverage.length === 0
				? ""
				: `${Math.round((count / coverage.length) * 100)}%`,
		];
	}),
)}

- **full (transcript + args)** — a pi-durable transcript exists, so per-turn
  usage, stop reasons, thinking tokens, per-call argument digests, result sizes
  and truncation flags are all available.
- **calls with args** — a call carries a recorded argument digest, so it can be
  de-duplicated by arguments; a recording that also carries the measured result
  size, duration and failure kind is analysable byte by byte (see
  \`source-recording\` for the per-generation share of each field).
- **calls only** — tool names and outcomes only: frequency and failure chains are
  analysable, repeat detection by argument is not, and the failure vocabulary is
  whichever the recording had (\`failure_kind\` stays NULL where it had none).
- **turns only** — usage/cost per turn, but no call-level detail.
- **stub** — the workflow exists in some index (a \`workflow.started\` line, a
  span id) but nothing about its work survives.

## 4. Per-workflow matrix

Every workflow found in any source. \`calls\`/\`turns\` are preferred-row counts;
\`args\`/\`bytes\`/\`dur\` say whether call arguments, result sizes and call durations
exist; \`transcript\` whether a pi-durable transcript exists; \`ver\`/\`gate\`/\`cmp\`
whether verifier, gate and compaction events exist.

${table(
	[
		"workflow",
		"repo",
		"first",
		"last",
		"runs",
		"turns",
		"calls",
		"args",
		"bytes",
		"dur",
		"input",
		"output",
		"cost",
		"transcript",
		"ver",
		"gate",
		"cmp",
		"class",
	],
	coverage.map((row) => {
		const totals = runSummary.filter((run) => run.workflow_id === row.id);
		const inputTokens = totals.reduce(
			(sum, run) => sum + Number(run.input_tokens ?? 0),
			0,
		);
		const outputTokens = totals.reduce(
			(sum, run) => sum + Number(run.output_tokens ?? 0),
			0,
		);
		const cost = totals.reduce((sum, run) => sum + Number(run.cost ?? 0), 0);
		return [
			row.id,
			row.repo ?? "",
			row.first_at ?? "",
			row.last_at ?? "",
			row.runs,
			row.has_turns ? "yes" : "",
			row.has_tool_calls ? "yes" : "",
			row.has_tool_args ? "yes" : "",
			row.has_result_sizes ? "yes" : "",
			row.has_call_durations ? "yes" : "",
			inputTokens > 0 ? inputTokens : "",
			outputTokens > 0 ? outputTokens : "",
			cost > 0 ? cost.toFixed(4) : "",
			row.has_transcript ? "yes" : "",
			row.has_verifier_events ? "yes" : "",
			row.has_gate_events ? "yes" : "",
			row.has_compaction_events ? "yes" : "",
			classify(row),
		];
	}),
)}

## 5. Per-role baseline

${table(
	[
		"role",
		"runs",
		"turns",
		"calls",
		"failed calls",
		"input tokens",
		"output tokens",
		"cache read",
		"cost",
		"transcript turns",
		"usage turns",
		"stop reasons",
		"thinking",
		"calls with args",
		"calls with bytes",
		"calls with duration",
	],
	roleTotals.map((role) => {
		const name = String(role.role ?? "(unknown)");
		const turnRow = roleTurns.find((row) => row.role === role.role) ?? {};
		const callRow = roleCalls.find((row) => row.role === role.role) ?? {};
		return [
			name,
			role.runs,
			role.turns,
			role.tool_calls,
			role.failed_calls,
			role.input_tokens ?? "",
			role.output_tokens ?? "",
			role.cache_read_tokens ?? "",
			role.cost ?? "",
			turnRow.transcript_turns ?? 0,
			turnRow.usage_turns ?? 0,
			turnRow.stop_turns ?? 0,
			turnRow.thinking_turns ?? 0,
			callRow.with_args ?? 0,
			callRow.with_bytes ?? 0,
			callRow.with_duration ?? 0,
		];
	}),
)}

## 6. Events

${table(
	["class", "event", "rows", "occurrences", "workflows"],
	eventTotals.map((event) => [
		event.event_class,
		event.event,
		event.rows,
		event.occurrences,
		event.workflows,
	]),
)}

## 7. Reconciliation: runs seen in more than one source

A run appears in the durable store, in telemetry, in the OTel span store and in
a harness transcript. Where more than one source described the same run, do the
turn and tool-call counts agree? Differences are reported, not smoothed over.

${
	groups.size === 0
		? "No run in this snapshot is described by more than one turn source."
		: table(
				[
					"run",
					"sources",
					"turns per source",
					"tool calls per source",
					"agree",
				],
				[...groups.entries()].map(([runId, list]) => {
					const turnCounts = new Set(list.map((item) => item.turns));
					const callCounts = new Set(list.map((item) => item.tool_calls ?? -1));
					const agree = turnCounts.size === 1 && callCounts.size === 1;
					return [
						`\`${runId}\``,
						list.map((item) => item.source).join(", "),
						list.map((item) => `${item.source}=${item.turns}`).join("; "),
						list
							.map((item) => `${item.source}=${item.tool_calls ?? "n/a"}`)
							.join("; "),
						agree ? "yes" : "no",
					];
				}),
			)
}

## 8. Harness attribution

${table(
	["harness source", "runs", "heuristic"],
	harnessRuns.map((row) => [row.source, row.runs, row.heuristic]),
)}

A run is attributed from a transcript **exactly** when the conversation's handle
name is still known to a durable store. Otherwise the run id is synthetic and
the row is marked \`heuristic\`, which is reported here so a later step can
exclude those rows instead of trusting them:

${listOrNone(
	unattributed.map(
		(row) =>
			`${row.run_id} (${row.source}, workflow ${row.workflow_id ?? "unknown"})`,
	),
	input.top,
	unattributed.length,
)}

## 9. Known gaps

### 9.1 Stub workflows (no turns, no calls)

${(() => {
	const stubs = classes.get("stub (no turns, no calls)") ?? [];
	const withWorktree = stubs.filter((row) => worktreeDirs.has(row.id));
	const storeOnly = stubs.filter(
		(row) => !worktreeDirs.has(row.id) && row.has_durable_store === 1,
	);
	const oldTelemetry = stubs.filter(
		(row) => !worktreeDirs.has(row.id) && row.has_durable_store !== 1,
	);
	const runsOf = (id: string) =>
		runSummary.filter((run) => run.workflow_id === id).length;
	return `${stubs.length} of ${coverage.length} workflows have no turns and no tool calls at
all. Three different losses produce them, and they need different reading:

**a. The worktree survived, its harness store did not (${withWorktree.length}).**
These are the workflows of the 2026-10-14..16 merge round: the worktree
directory is still in the snapshot but its \`harness.sqlite\` is not, so nothing
holds the turns, tool calls, tokens, costs or verifier rounds any more — for the
workflows that still have a durable run row, only the run's id, step, role and
status survive. Exactly these workflows are affected:

${table(
	["workflow", "durable runs", "worktree telemetry"],
	withWorktree.map((row) => [
		`\`${row.id}\``,
		runsOf(row.id),
		worktreeTelemetry.some((file) => file.workflowId === row.id)
			? "present"
			: "absent",
	]),
)}

**b. The durable store knows runs, but no worktree survives (${storeOnly.length}).**
The run rows are there; everything per-turn is not:
${listOrNone(
	storeOnly.map((row) => `${row.id} (${runsOf(row.id)} run(s))`),
	input.top,
	storeOnly.length,
)}

**c. The oldest telemetry generation never wrote per-turn events (${oldTelemetry.length}).**
Nothing was deleted here: these files only ever carried a \`workflow.started\`
line. The first few are named, the rest counted, because the list is not
actionable:
${listOrNone(
	oldTelemetry.map((row) => row.id),
	Math.min(input.top, 10),
	oldTelemetry.length,
)}

Nothing in this snapshot can reconstruct those runs' turns, tool calls, tokens
or costs. Any per-role or per-workflow total that includes them is a lower
bound.`;
})()}

### 9.2 Missing per-turn usage

${(() => {
	const missing = coverage
		.filter((row) => row.has_turns === 1 && !row.has_usage)
		.map((row) => row.id);
	const noTurns = coverage.filter((row) => !row.has_turns).length;
	const covered = coverage.filter((row) => row.has_turns === 1).length;
	return missing.length === 0
		? `Every workflow with turns (${covered}) carries usage counters.`
		: `${missing.length} of the ${covered} workflow(s) that have turns carry no token or
cost counter: ${listOrNone(missing, input.top, missing.length)}. These can be analysed
for call shape but not for cost. (The ${noTurns} workflows with no turns are covered in 9.1.)`;
})()}

### 9.3 Missing call arguments, result sizes and durations

${(() => {
	const noArgs = coverage.filter(
		(row) => row.has_tool_calls && !row.has_tool_args,
	);
	const noBytes = coverage.filter(
		(row) => row.has_tool_calls && !row.has_result_sizes,
	);
	const noDuration = coverage.filter(
		(row) => row.has_tool_calls && !row.has_call_durations,
	);
	return [
		`- calls but no argument digest (no exact repeat detection): ${noArgs.length} workflow(s) — ${listOrNone(
			noArgs.map((row) => row.id),
			input.top,
			noArgs.length,
		)}`,
		`- calls but no result size (waste cannot be measured in bytes): ${noBytes.length} workflow(s) — ${listOrNone(
			noBytes.map((row) => row.id),
			input.top,
			noBytes.length,
		)}`,
		`- calls but no duration (no latency or idle analysis): ${noDuration.length} workflow(s) — ${listOrNone(
			noDuration.map((row) => row.id),
			input.top,
			noDuration.length,
		)}`,
	].join("\n");
})()}

### 9.4 Transcripts

${(() => {
	const withTranscript = coverage.filter((row) => row.has_transcript).length;
	const missing = [...worktreeDirs]
		.filter((name) => !worktreeHarness.some((file) => file.workflowId === name))
		.sort();
	return `${withTranscript} workflow(s) have a pi-durable transcript, which is the only
place stop reasons, thinking tokens and result sizes exist. ${worktreeHarness.length} of
the ${worktreeDirs.size} worktrees in the snapshot still carry a \`harness.sqlite\`;
the rest kept only their telemetry file, so their conversations are gone:
${listOrNone(missing, input.top, missing.length)}

The harness stores themselves are \`${["orchestrator", "wiki-workflows", "backend", "main-store"].join("`, `")}\` only — i.e. the orchestrator's own conversation, the wiki host, the environment-setup author and the stale Oct-12 store. There is no harness for any other role.`;
})()}

### 9.5 Sources that cannot be decoded

${
	input.notes.length === 0
		? "None: every source in the snapshot decoded."
		: input.notes
				.slice(0, 100)
				.map((note) => `- ${note}`)
				.join("\n")
}

### 9.6 Schema notes per source

- **\`otel-tui/traces.sqlite\`** — \`traces\` holds one OTel span per row with the
  engine attributes flattened into \`herdr.*\`/\`pi.*\`; \`change_id\` is the workflow
  id, but older spans identify their workflow only through a \`change\`
  attribute (the OpenSpec change name), which is used as the fallback id. The
  \`logs\` and \`metrics\` tables are empty in this snapshot, so there is no log or
  metric telemetry. \`workspace_files\` only marks how far each file was ingested.
- **\`*/telemetry/*.jsonl\`** — generations of the same stream: a legacy
  envelope (\`model_usage\`, \`provider_response\`, \`tool_error\`, \`pi_agent_*\`,
  \`verification_finding\`) with no run id, the span envelope that adds
  \`pi.tool.duration_ms\`/\`pi.tool.result_bytes\`/\`herdr.content.tool_input\`, the
  envelope that kept only tool names and outcomes, and the current one, which
  records for every call \`pi.tool.args_hash\`, a bounded secret-free
  \`pi.tool.args_digest\`, \`pi.tool.argument_bytes\`, \`pi.tool.duration_ms\`,
  \`pi.tool.result_bytes\`/\`result_lines\`/\`result_truncated\`, \`pi.tool.ok\` and a
  machine-readable \`pi.tool.failure_kind\` — never payload text. All generations
  are normalized field-by-field; a field a generation does not carry stays NULL.
- **\`harness.sqlite\`** — pi-durable: \`conversations\`, \`entries\`, \`tasks\`,
  \`documents\`, \`document_revisions\`. An \`entries.record\` is a JSON object with
  a \`kind\` (\`pi.assistant\`, \`pi.tool-result\`, \`pi.user\`, \`pi.system\`,
  \`pi.compaction\`). Documents are revisioned (a \`base\` plus \`delta\` patches);
  \`agentic.runs\` maps an agent handle to a conversation id and \`pi.agent\`
  carries the model and working directory.
- **\`herdr.db\`** — \`workflow_instances\` (status, current step, a snapshot with
  the definition, gate decisions and assignment metadata), \`workflow_runs\` (run
  id, step, role, attempt, generation, status and the agent handle) and
  \`workflow_events\` (a revision log of handoffs and effect results). The run
  table is the only authoritative run list; the snapshot here holds the current
  store, the Oct-14 backup and the grid-allocation-backend store.

### 9.7 Stores that are not in the snapshot

The live stores under the developer's configuration directory and the live
\`.herdr-workflow\` store are deliberately excluded. Any run that started after
the snapshot, and every workflow whose store lives only there, is absent.

## 10. What each later step can and cannot analyse

| step | can | cannot |
| --- | --- | --- |
| planners | turns, usage, cost and call shape for planner runs in every covered workflow; gate events for plan approval and plan-quality decisions | the plan text itself; per-task difficulty; anything about a stub workflow |
| workers | the richest slice: transcripts for a few workflows, argument digests, result sizes, truncation flags, failure chains and repeat detection wherever \`args\` is \`yes\` | repeat detection by argument for \`calls only\` workflows; result sizes where \`bytes\` is empty |
| verifiers | verifier events (findings by severity, verifier results, empty settles, verification started/failed) and verifier runs' usage and cost | findings' text (only a bounded digest is stored); the file-level triage detail for workflows without triage events |
| triage / gates | gate decisions (phase changes, plan quality, developer actions, review comments, model selection, routing decisions) as event rows | the decision rationale; classifier prompts; anything about gates in stub workflows |
| wiki / archive / delivery | archive and delivery events, wiki-role turns and cost, \`git_operations_*\` and \`workflow_closed\` events, the wiki host's own transcript | wiki document contents; PR/commit bodies |
| env-setup author | the grid-allocation-backend store and harness, its runs, turns and calls | env-setup for any other repository |
| research / debug | debug-run launches as events; research/debug roles' turns and calls where spans or telemetry exist | debug report bodies; the debug sub-store under a worktree |
| orchestrator conversation | the orchestrator harness: its turns, usage, cost, and every tool call it made (start/list/status/action) | tool *arguments* only as a bounded digest; the developer's own replies' text |
| any step | the exact data provenance: every row carries \`source\`, \`confidence\` and a \`preferred\` flag | — |

## 11. Analysis helpers

\`bun run scripts/efficiency/analyze.ts --help\` lists every query. All of them
read the preferred rows and run in seconds:

${[
	"summary",
	"roles",
	"tools",
	"repeated-calls",
	"repeated-reads",
	"calls-per-turn",
	"failed-chains",
	"turn-gaps",
	"usage-by-workflow",
	"context-growth",
	"cache-hit",
	"coverage",
	"skipped",
	"reconciliation",
	"events",
	"handoffs",
	"effect-failures",
	"verifier-findings",
	"runs",
]
	.map((name) => `- \`analyze.ts ${name}\``)
	.join("\n")}

Examples:

\`\`\`bash
bun run scripts/efficiency/analyze.ts repeated-calls --dataset <out> --limit 20
bun run scripts/efficiency/analyze.ts calls-per-turn --dataset <out>
bun run scripts/efficiency/analyze.ts reconciliation --dataset <out>
\`\`\`
`);

		return sections.join("\n");
	} finally {
		db.close();
	}
}

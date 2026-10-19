#!/usr/bin/env bun
// The dataset schema README, written next to dataset.sqlite so the OUT
// directory explains itself without the repository docs.

import { DATASET_SCHEMA_VERSION } from "./dataset.ts";

export interface ReadmeCounts {
	[key: string]: number;
}

export function datasetReadme(
	meta: Record<string, string>,
	counts: ReadmeCounts,
	sourceFiles: number,
): string {
	const rows = Object.entries(counts)
		.map(([table, count]) => `| \`${table}\` | ${count} |`)
		.join("\n");
	return `# Efficiency dataset

Built by \`agentic-coding/scripts/efficiency/build-dataset.ts\` (dataset schema
version ${DATASET_SCHEMA_VERSION}). This file and \`dataset.sqlite\` are generated
output and must never be committed.

${Object.entries(meta)
	.map(([key, value]) => `- ${key}: \`${value}\``)
	.join("\n")}
- source files read: ${sourceFiles}

## Tables

| table | rows |
| --- | --- |
${rows}

### workflows

One row per workflow id seen in any source. \`type\` is the workflow definition
id (\`solo\`, \`openspec\`, \`verify\`, ...), kept as both the literal \`type\`
column and \`definition_id\`; \`sources\` is a comma-separated list
of the sources that carried it; \`confidence\` is \`heuristic\` when the id was
only ever seen through spans or a harness transcript.

### runs

One row per run id. \`source\` is the highest-precedence source that contributed
(see the precedence section), \`sources\` lists all of them, \`confidence\` is
\`heuristic\` when a harness conversation had to be attributed to a run without a
durable handle. \`handoff_reason\` carries the engine status a handoff ended in
(for example \`attention-required\` for a blocked handoff).

### turns

One row per (run, source, turn index). \`thinking_tokens\` and \`stop_reason\` are
only available from a harness transcript; telemetry carries a thinking *level*
string, which is not a token count and is deliberately not substituted.
\`tool_calls\` is the number of calls the turn made (NULL when the source does not
say).

### tool_calls

One row per (run, source, call). \`args_hash\` is the full argument JSON hashed,
so two identical calls join exactly; \`args_digest\` is a short, secret-free
summary (a path, a search path and pattern, or a command head). No argument text
is stored. \`result_bytes\`/\`result_lines\` are sizes, \`result_truncated\` is the
flag the recording reported (or the transcript's own truncation flag). \`ok\` is
1/0/null (null = the call never reported an outcome). \`failure_kind\` is the
machine-readable failure vocabulary (\`not-found\`, \`no-match\`, \`denied\`,
\`host-error\`, \`timeout\`, \`aborted\`, \`invalid-args\`, \`other\`) and stays NULL
where the recording had none. \`recording\` names which recording the row came
from: \`legacy\`, \`span\` or \`harness\` — the axis the \`source-recording\` query
reports per-generation completeness on.

### events

One row per noteworthy engine or adapter event: handoffs, effect results, gate
decisions, verifier findings, compaction, delivery. \`event_class\` groups them.
\`detail\` is a bounded, redacted error class; \`detail_hash\`/\`detail_bytes\`
describe the free text that was *not* stored. \`compaction_kind\` and
\`compaction_blocking\` carry a compaction envelope's own vocabulary
(\`auto-ceiling\`/\`auto-overflow\`/\`manual\`, and whether it blocked the
request), which is what the \`compactions\` query counts per run.
\`repair_effects\`, \`repair_runs\` and \`repair_count\` carry what an
\`operator.repair\` retired (the ids themselves stay in the store they were
recorded in); \`wait_kind\` names the developer wait a \`workflow.waiting\` row
opened, whose subject is the \`detail\` of the row and whose duration is the
distance to the \`workflow.waiting.ended\` row that closes it.

## De-duplication precedence

The same run can appear in the durable store, in telemetry, in per-span OTel
rows and in a harness transcript. Exactly one row per table group is marked
\`preferred = 1\`, by source rank:

\`\`\`
herdr.*         190   run identity, status, attempt, generation
harness.*       100   turns and tool calls (stop reason, thinking, sizes)
telemetry.*      70   lifecycle, handoffs, effects, usage
traces.*         40   the wide but coarse span store
\`\`\`

Groups are: the run id for \`runs\`, \`turns\` and \`tool_calls\`; workflow + run +
event + second for \`events\`. The losing rows stay in the tables, which is what
makes the \`reconciliation\` query possible.

## Views

| view | meaning |
| --- | --- |
| \`v_runs\`, \`v_turns\`, \`v_tool_calls\`, \`v_events\` | preferred rows only |
| \`v_run_summary\` | per-run totals, with peak input tokens |
| \`v_workflow_summary\` | per-workflow totals |
| \`v_workflow_coverage\` | what each workflow can and cannot be analysed from |
| \`v_harness_sources\` | which harness sources exist |

Use \`bun run scripts/efficiency/analyze.ts <query> --dataset <this directory>\`
for the documented queries (\`analyze.ts --help\` lists them).
`;
}

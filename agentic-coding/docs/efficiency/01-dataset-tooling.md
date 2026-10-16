# Efficiency dataset tooling

The dataset and the analysis helpers that later efficiency steps run on. Step 1
builds the evidence and says what it can and cannot answer; it makes **no**
judgement about useless calls or any other inefficiency. The measurements live
in [`00-data-inventory.md`](./00-data-inventory.md), which is generated.

Everything here is read-only with respect to the product: nothing under `src/`
changes, the store schema stays at version 6, and the dataset is written
**outside the repository**. The only file these tools write into the repo is the
generated inventory markdown.

## Building the dataset

```bash
# from agentic-coding/
bun run scripts/efficiency/build-dataset.ts --evidence <evidence-dir> [--out <dir>]
```

- `--evidence` is the read-only snapshot root (the directory holding
  `MANIFEST.md`). It is never written to.
- `--out` defaults to `<evidence>/dataset-<timestamp>`, is created with mode
  `0700`, and holds:
  - `dataset.sqlite` — the normalized tables and views (mode `0600`),
  - `README.md` — the schema of that file, generated.
- `--inventory <path>` optionally also writes the data-inventory markdown.
- `--top <n>` bounds how many workflow ids the inventory names per gap table.

The builder finishes in about two seconds on the full snapshot (508 source
files, ~103k records) and prints a JSON summary: per-table row counts, the byte
size, the sources it found, sources it expected but did not find, the number of
unparseable records and the number of notes.

```bash
bun run scripts/efficiency/build-dataset.ts \
  --evidence ~/agentic-coding-efficiency-evidence/latest \
  --inventory docs/efficiency/00-data-inventory.md
```

## Sources and schema

| source | what it is | what only it has |
| --- | --- | --- |
| `herdr.main-store`, `herdr.backend` | durable workflow store (`workflow_instances`, `workflow_runs`, `workflow_events`) | run identity, attempt, generation, status, agent-handle name |
| `harness.*` | pi-durable transcript store (`conversations`, `entries`, `documents`) | stop reason, thinking tokens, argument bodies, result sizes, truncation |
| `telemetry.worktree`, `telemetry.backend`, `telemetry.main-store` | per-workflow `telemetry.jsonl` | lifecycle, handoffs, effects, gate decisions, captured tool inputs |
| `traces.otel-tui` | OTel span store | the widest coverage (495 workflows) and the older tool metrics |

The telemetry files come in three generations (a legacy envelope with no run id,
a span envelope with tool metrics, and the newest minimal span envelope). Both
the JSONL files and the OTel spans are normalized by one function
(`scripts/efficiency/lib/normalize.ts`), field by field, so a field a generation
does not carry stays `NULL` rather than becoming a guess. The inventory's section
9.6 records the schema of each source as it was found.

## Tables

`workflows`, `runs`, `turns`, `tool_calls`, `events`, plus `sources`,
`source_files` (one row per file with its record/parsed/skipped counts) and
`meta`. `dataset.sqlite/README.md` describes each column; the short version:

- Every table carries `source`, `source_rank`, `confidence` and `preferred`.
  `confidence` is `heuristic` where a fact had to be inferred (a run id that only
  a synthetic per-workflow run could carry, a harness conversation that no
  durable handle names) and `exact` otherwise.
- `turns` holds one row per (run, source, turn index) with tokens, cost, stop
  reason, thinking tokens and the turn's call count.
- `tool_calls` holds one row per (run, source, call) with `args_hash` (the full
  argument JSON, hashed), `args_digest` (a bounded path or command head),
  `args_bytes`, `result_bytes`, `result_lines`, `result_truncated` and `ok`.
- `events` holds one row per noteworthy engine/adapter event with an
  `event_class` (`handoff`, `effect`, `gate`, `verifier`, `triage`, `compaction`,
  `delivery`, `routing`, `lifecycle`, `other`).

## De-duplication precedence

The same run appears in several sources, so exactly one row per group is marked
`preferred = 1`:

```
herdr.*      190   run identity, status, attempt, generation
harness.*    100   turns and tool calls (richest transcript)
telemetry.*   70   lifecycle, handoffs, effects, usage
traces.*      40   the wide but coarse span store
```

Groups: the run id for `runs`, `turns` and `tool_calls`; workflow + run + event +
second for `events`. Losing rows stay in the tables, which is what makes the
`reconciliation` query possible: for every run two sources saw, it reports both
turn and call counts so a disagreement is visible rather than averaged away.

Use the preferred views (`v_runs`, `v_turns`, `v_tool_calls`, `v_events`) for
totals, and the base tables only for reconciliation.

## Redaction

Nothing raw reaches the dataset:

- tool arguments are hashed (`args_hash`) and reduced to a bounded digest
  (`args_digest`) — a path for a file tool, a command head for a shell tool,
  never the arguments themselves;
- free text (an error class, a finding description, a compaction summary) is
  replaced by a hash and a byte count;
- every stored short text passes through `redactText`, which removes private
  keys, known key prefixes, bearer tokens, URL userinfo, `key=value` secrets and
  standalone opaque blobs;
- a call id recorded by one older runtime as `<id>|<opaque payload>` keeps the id
  and drops the payload.

`test/efficiency/efficiency-dataset.test.ts` asserts that no text column of the
built dataset contains a secret-shaped or transcript-shaped value.

## Analysis queries

```bash
bun run scripts/efficiency/analyze.ts --help
bun run scripts/efficiency/analyze.ts <query> --dataset <out-dir> [--limit <n>] [--json]
```

Every query reads the preferred rows and runs in a second or less.

| query | what it measures | example |
| --- | --- | --- |
| `summary` | totals per table plus heuristic-run and with-args counts | `analyze.ts summary --dataset <out>` |
| `roles` | usage, cost and call volume per role and step | `analyze.ts roles --dataset <out>` |
| `tools` | tool-call frequency per role, with failures and result volume | `analyze.ts tools --dataset <out> --limit 40` |
| `repeated-calls` | identical calls inside one run (same tool + `args_hash`), with the result bytes a repeat cost | `analyze.ts repeated-calls --dataset <out> --limit 20` |
| `repeated-reads` | the same path read more than once inside one run | `analyze.ts repeated-reads --dataset <out> --limit 20` |
| `calls-per-turn` | distribution of tool calls per turn | `analyze.ts calls-per-turn --dataset <out>` |
| `failed-chains` | runs whose failures cluster into consecutive chains | `analyze.ts failed-chains --dataset <out>` |
| `turn-gaps` | idle gaps between consecutive turns, largest first | `analyze.ts turn-gaps --dataset <out> --limit 20` |
| `usage-by-workflow` | tokens and cost per workflow | `analyze.ts usage-by-workflow --dataset <out> --limit 20` |
| `context-growth` | input tokens by turn position: how fast context grows | `analyze.ts context-growth --dataset <out>` |
| `cache-hit` | cache hit rate per run | `analyze.ts cache-hit --dataset <out> --limit 20` |
| `coverage` | the per-workflow coverage matrix | `analyze.ts coverage --dataset <out> --limit 20` |
| `skipped` | per-source parse counts, worst first | `analyze.ts skipped --dataset <out>` |
| `reconciliation` | runs seen in more than one source, side by side | `analyze.ts reconciliation --dataset <out>` |
| `events` | event counts by class, name and outcome | `analyze.ts events --dataset <out>` |
| `handoffs` | handoff outcomes including the status behind a blocked one | `analyze.ts handoffs --dataset <out>` |
| `effect-failures` | effect results that did not succeed | `analyze.ts effect-failures --dataset <out>` |
| `verifier-findings` | verifier findings by severity and role | `analyze.ts verifier-findings --dataset <out>` |
| `runs` | per-run rollup for eyeballing one workflow | `analyze.ts runs --dataset <out> --limit 20` |

A query that a later step needs and this list does not have belongs in
`scripts/efficiency/lib/queries.ts` (name, summary, SQL, columns, one example),
where `analyze.ts --help` and the test that runs every query pick it up
automatically.

## Tests

```bash
# from agentic-coding/, isolated as the suite requires
HOME=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) HERDR_WIKI_DIR=$(mktemp -d) \
  bun test test/efficiency/
```

The fixtures under `test/fixtures/efficiency/` are hand-made and synthetic: a
legacy telemetry file, a span telemetry file, a file with a truncated line, a
non-JSON line and a nameless record, a worktree telemetry file plus its harness,
and SQL for the traces and durable stores. The SQLite fixtures are committed as
`.sql` and materialized into a temporary directory by
`test/efficiency/fixture.ts`, so no binary blob enters the repository. The tests
cover the parsing of both telemetry formats, the de-duplication precedence, run
attribution, redaction, corrupt-line tolerance, the repeated-call and
reconciliation queries, and that every documented query runs.

## Constraints the tooling respects

- no change to `src/`, no store schema change (still 6), no app/server/TUI run;
- the snapshot is opened read-only (`readonly: true`) and never modified;
- the dataset is written outside the repository and is never committed;
- the live stores (`~/.config/agentic-coding`, the live `.herdr-workflow` store)
  are never touched, and the snapshot's `.env`/provider files are never read.

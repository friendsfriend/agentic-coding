# Efficiency dataset tooling

The dataset and the analysis helpers that later efficiency steps run on. Step 1
builds the evidence and says what it can and cannot answer; it makes **no**
judgement about useless calls or any other inefficiency. The measurements live
in [`00-data-inventory.md`](./00-data-inventory.md), which is generated.

The harness reader repair and the build's empty-source alarm are recorded in
[`04a-harness-reader-repair.md`](./04a-harness-reader-repair.md). Every figure in
this document and in `00`…`04` was taken before that repair, when nine
`harness.*` stores were unreadable, so those figures are lower bounds against the
repaired denominators.

The tooling is read-only with respect to the product: it never runs the
app/server/TUI, opens the live stores read-only, changes nothing under `src/`
and leaves the store schema at version 6. The dataset is written **outside the
repository**; the only files these tools write into the repo are the generated
inventory markdown. What the runtime *records* is a separate change: the tool
envelopes now carry the bounded fields below, which this tooling ingests.

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

A source file whose parse yields **zero rows** fails the build (non-zero exit, a
message naming the file and its counts, and no dataset written): a source can be
lost silently otherwise, which is exactly what happened to the nine `harness.*`
stores (see [`04a-harness-reader-repair.md`](./04a-harness-reader-repair.md)).
Legitimately empty sources are named in `EMPTY_SOURCE_ALLOWLIST`
(`scripts/efficiency/lib/empty-sources.ts`) or passed once as
`--allow-empty "<pattern>[,<pattern>]"`; an entry is a `*`/`**` glob over the
snapshot-relative path, optionally narrowed with a `source`.

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
| `telemetry.worktree`, `telemetry.backend`, `telemetry.main-store` | per-workflow `telemetry.jsonl` | lifecycle, handoffs, effects, gate decisions, and (current generation) the argument digest, result size, duration, `ok` and failure kind of every tool call |
| `traces.otel-tui` | OTel span store | the widest coverage (495 workflows) and the older tool metrics |

The telemetry files come in several generations (a legacy envelope with no run
id, a span envelope with tool metrics, a minimal span envelope that kept only
names and outcomes, and the current one, which records the bounded tool-call
fields). Both the JSONL files and the OTel spans are normalized by one function
(`scripts/efficiency/lib/normalize.ts`), field by field, so a field a generation
does not carry stays `NULL` rather than becoming a guess — `recording` names the
generation each call row came from, and `source-recording` reports the share of
calls that carry an argument digest, a result size, a duration and a failure
kind per generation. The inventory's section 9.6 records the schema of each
source as it was found.

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
  argument JSON, hashed), `args_digest` (a bounded path, search pattern or
  command head), `args_bytes`, `result_bytes`, `result_lines`,
  `result_truncated`, `ok`, `failure_kind` (the machine-readable vocabulary:
  `not-found`, `no-match`, `denied`, `host-error`, `timeout`, `aborted`,
  `invalid-args`, `other`) and `recording` (`legacy`, `span` or `harness` —
  which recording the call came from).
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
  (`args_digest`) — a path for a file tool, a search path and pattern, or the
  first 120 characters of a shell command, redacted at the runtime and passed
  through `redactText` again here, so a digest a leaking writer emitted cannot
  reach the dataset either;
- free text (an error class, a finding description, a compaction summary) is
  replaced by a hash and a byte count;
- every stored short text passes through `redactText`, which removes private
  keys, known key prefixes, bearer tokens, URL userinfo, `key=value` secrets and
  standalone opaque blobs;
- a call id recorded by one older runtime as `<id>|<opaque payload>` keeps the id
  and drops the payload.

`test/efficiency/efficiency-dataset.test.ts` asserts that no text column of the
built dataset contains a secret-shaped or transcript-shaped value, and a
synthetic new-generation telemetry file is round-tripped through the extractor
into a dataset to prove the new columns, the repeat and failure-kind queries and
the redaction of a digest that leaked a token.

`test/agent-host-tool-telemetry.test.ts` covers the runtime side: the bounded
digest, the credential shapes it redacts and the failure vocabulary; and
`test/agent-host-telemetry.test.ts` runs a real durable host turn and asserts
that the emitted envelopes carry the new fields and never the result text.

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
| `repeats-per-run` | exact repeats rolled up per run: the extra calls and the duplicated result bytes, per 100 calls | `analyze.ts repeats-per-run --dataset <out> --limit 20` |
| `repeated-reads` | the same path read more than once inside one run | `analyze.ts repeated-reads --dataset <out> --limit 20` |
| `failure-kinds` | failed calls per 100 calls by machine-readable failure kind, per role and tool | `analyze.ts failure-kinds --dataset <out>` |
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
| `source-recording` | per source, month and recording: outcomes, the share of calls with an argument digest, result size, duration and failure kind, and failure-only runs | `analyze.ts source-recording --dataset <out>` |
| `run-window-drift` | runs whose turns continue past the run's own recorded completion, with the turns in the tail (`tail_turns`), whether a session-window row names the run (`session_recorded`) and what the recording says (`drift_kind`, see below) | `analyze.ts run-window-drift --dataset <out> --limit 20` |

Any query in this list refuses a dataset file whose recorded schema version is not
the one this build writes (`assertDatasetSchemaVersion`): the columns are
append-only within a version, so an older file has none of them, and the message
names both versions and the rebuild. There is no conversion.

### `run-window-drift` and the session window

A run's window is the engine's: `started_at` to the `agent.handoff` that closed
it. Its session's window is the durable host's: one pi-durable conversation per
`(workflow, step, role)`, which outlives every run it serves. The host records
the move between them as two runtime envelopes on the conversation's run binding
(`runtime.session_window.opened` with a reason, `runtime.session_window.closed`
naming the run it rebinds to), so a turn a session emits after its run closed is
a **recorded continuation** rather than a window error.

The query keeps the columns it always had (`run_id`, `workflow_id`, `role`,
`status`, `run_started_at`, `run_completed_at`, `turns`, `first_turn_at`,
`last_turn_at`, `tail_seconds`, and the one-minute threshold) and adds:

- `tail_turns` — how many of the run's turns started after its recorded
  completion. The threshold and the count agree: a run with no turn in its tail
  (`tail_turns` 0) is not drift, however long the one turn that straddles its
  completion ran;
- `session_recorded` — `1` iff a `runtime.session_window.opened` or
  `runtime.session_window.closed` row names this run id. That is the per-run gate:
  a run is recorded iff the record names *its* run id, so one run's move cannot
  hide another's missing record;
- `session_reason`, `session_rebound_to`, `session_opened_after_completion`,
  `first_session_window_at` — the run's own *latest* binding reason
  (`created`/`rebound`/`adopted`/`resumed`, by `at DESC`, not the largest text),
  the run its latest `closed` names, whether one of the run's own `opened` rows
  falls at or after its completion, and its workflow's first session-window
  instant (the moment the workflow started recording one at all);
- `drift_kind`, decided in the order `clock-artifact` → `attributed` → `resumed`
  → `unexplained`:
  - `clock-artifact` — `completed_at <= started_at`, i.e. the run's own window
    cannot be read at all (the traces reader dates an `agent.handoff` span by its
    start), so nothing can be concluded from its tail;
  - `attributed` — a `runtime.session_window.closed` event names this run: the
    session went on under a later run, which did the work the earlier run's row
    would otherwise claim;
  - `resumed` — no `closed`, but the recording binds the run's own conversation to
    it *after* its completion (`session_opened_after_completion`) or with the
    reason `resumed`: the tail is the same run working on the same session. This
    is the abort-and-resume path, where the store clears `completed_at` and the
    dataset still dates the completion at the last `agent.handoff`;
  - `unexplained` — the window is readable and the record states no continuation,
    whether or not some row names the run. A binding from *before* the run's
    completion is not a continuation: a session that went on under a later run
    across a host lifetime leaves exactly that shape, and calling it explained
    would make the alarm silent for the misattribution it exists to catch.

The gate is **per run, not per workflow**, and the build summary keeps the three
populations apart:

- `runWindow.judged {runs, attributed, resumed}` — the rows the record explains
  (`attributed` + `resumed`). They always build;
- `runWindow.unrecorded {runs, beforeRecord, afterRecord}` — the `unexplained`
  rows, with a top-level `unexplained` equal to `unrecorded.runs`. `beforeRecord`
  counts the ones where no record is due (the run started before its workflow's
  first session-window event); `afterRecord` counts a **broken record** — a run
  that started after the workflow already recorded a window and still has no
  continuation of its own — which fails the build;
- a top-level `clockArtifact` — the rows whose own window cannot be read, counted
  apart from both because their class says nothing about the session.

A failed build leaves no dataset behind: it deletes the dataset and its README,
names the offending runs, their workflows and the query to inspect, and exits
non-zero — the same shape as the empty-source alarm. On the pinned snapshot every
drifting run is `unexplained` and `beforeRecord` (the whole generation predates
the record), so it builds, with `clockArtifact` reporting the 62 rows whose
completion precedes their start. A workflow that straddles the change records some
runs and not others: the runs it recorded are judged, the ones that began before
its first record are `beforeRecord`, and only a run that began after that record
without its own is a failure.

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
reconciliation queries, the `run-window-drift` classification and its build
alarm, and that every documented query runs.

## Constraints the tooling respects

- no store schema change (still 6), no app/server/TUI run, and no change to the
  product beyond the runtime recording it is built to read;
- the snapshot is opened read-only (`readonly: true`) and never modified;
- the dataset is written outside the repository and is never committed;
- the live stores (`~/.config/agentic-coding`, the live `.herdr-workflow` store)
  are never touched, and the snapshot's `.env`/provider files are never read.

## 1. Record the session window

- [x] 1.1 In `src/agent-host/telemetry.ts`, let `attachTelemetry` take its identity
  as `TelemetryIdentity | (() => TelemetryIdentity)` and resolve it once per
  delivered event, so one stream can serve several runs over its life. Keep the
  existing signature meaning for a caller that passes a plain identity.
- [x] 1.2 In `src/agent-host/host.ts`, keep the run each conversation is bound to
  (`ensureRun` writes it; the per-run cleanup in `stopRun` does not delete it) and
  update it before the run's first submission. Pass a getter to `attachTelemetry`
  that reads the current binding for the stream's own envelopes, and make the
  run-scoped observers charge the run that *produced* the observation: the
  measured-context observer (the cost ceiling) takes the identity the stream
  resolved for the message, and the finished-tool observer (the dead-surface rule)
  takes the run that started the call (`callOwners` by `toolCallId`), ignoring an
  observation for a run the host no longer tracks (`this.runs`).
- [x] 1.3 Emit the two session-window envelopes through the same sink: when a
  conversation is bound to a run that differs from the previous binding, emit
  `runtime.session_window.closed` for the previous run (payload
  `herdr.session.rebound_to`) and then `runtime.session_window.opened` for the
  new one with `herdr.session.reason` `rebound` and `herdr.session.previous_run_id`;
  for a new conversation emit `opened` with `created`, for a conversation
  re-bound to the same run `opened` with `resumed` and no `closed`, and for a
  conversation whose previous run the host cannot name `opened` with `adopted`
  and no `closed`. Carry the conversation id as `herdr.session.conversation_id`
  (never as the envelope's `sessionId`, which means *run* id), emit nothing when
  the binding carries no run id, and keep a failed emission best-effort — but see
  1.5 for the `closed` record, whose absence is a defect a reader treats as one.
- [x] 1.4 Add `test/agent-host-session-window.test.ts` on the durable-host
  fixture: a later round served by the same conversation records `closed` for the
  earlier run and `opened(rebound)` for the later one, in that order, with the
  conversation id in `herdr.session.conversation_id`, and the later round's
  `runtime.*` envelopes carry the later run id while the earlier run keeps only its
  own; a run whose conversation is rebound to itself records `opened(resumed)` and
  no `closed`; a new conversation records `opened(created)`; a conversation with
  no `HERDR_RUN_ID` records nothing; and the run rows' status, start and completion
  are the same as without the record. Run it with
  `HOME=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) HERDR_WIKI_DIR=$(mktemp -d) bun test test/agent-host-session-window.test.ts`.
- [x] 1.5 Make the `closed` record durable rather than best-effort: have the
  envelope writer report whether the append happened, and keep an unwritten close
  per conversation in a bounded queue (8 entries, oldest dropped first), retried
  into the binding that now holds the conversation — in the same transition, and
  on that conversation's later bindings while it stays unwritten. Serialize the
  whole transition (read the previous binding, drain the stream for one macrotask
  turn, write the new binding and its envelopes) per conversation, so two
  overlapping rebindings cannot close one run twice, name a successor that never
  held the conversation, or leave the last run open.
- [x] 1.6 Act on a dead-surface decision with the failing run's own context, not
  the conversation's current one: `handleFailFast` reads the run's own
  `DurableRunContext`, and refuses the decision (recording
  `herdr.fail_fast.scope: "owner-rebound"`, aborting nothing and handing off
  nothing) when a later run now holds the conversation. Guard every
  conversation-keyed delete in `stopRun` by the binding, so a successor ensured
  while the abort is in flight keeps the state it wrote.

## 2. Classify a tail in the dataset

- [x] 2.1 In `scripts/efficiency/lib/extract.ts`, map `runtime.session_window.opened`
  and `runtime.session_window.closed` to the `lifecycle` event class so the two
  events are readable by name and class from `events`, and carry the session
  window's own vocabulary into the `events` row (`session_reason`,
  `session_rebound_to`, `session_previous_run_id`, `session_conversation_id`;
  `DATASET_SCHEMA_VERSION` 3 → 4, append-only).
- [x] 2.2 Extend the `run-window-drift` query in `scripts/efficiency/lib/queries.ts`
  with `tail_turns` (the turns that started after the run's recorded completion),
  `session_opened_after_completion` (whether one of the run's own `opened` rows
  falls at or after that completion), `session_reason` and `session_rebound_to`
  (from the run's *latest* such row, by `at DESC`, not the largest reason text)
  and a `drift_kind` decided in the order `clock-artifact` (`completed_at <=
  started_at`) → `attributed` (a `closed` row names the run) → `resumed` (no
  `closed`, but an `opened` row at or after the completion, or the reason
  `resumed`) → `unexplained` (the record states no continuation, whether or not it
  names the run), keeping every existing column, the one-minute threshold and the
  ranking.
- [x] 2.3 Extend `test/efficiency/efficiency-queries.test.ts`: a drifting run with
  its session-window `closed` event is `attributed` with the right `tail_turns`; a
  run whose completion precedes its start is `clock-artifact`; a drifting run with
  neither is `unexplained`; a run whose only row is an `opened` from before its
  completion is `unexplained`; a run bound twice reports its latest reason and is
  `resumed`; a run whose turns all precede its completion is absent.
  Run `HOME=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) HERDR_WIKI_DIR=$(mktemp -d) bun test test/efficiency/`.
- [x] 2.4 Refuse a dataset file another build wrote: `assertDatasetSchemaVersion`
  in `scripts/efficiency/lib/dataset.ts` compares the file's recorded schema
  version to `DATASET_SCHEMA_VERSION` and every reader calls it (`analyze.ts`,
  `lib/run-window.ts`), so an older file names both versions and the rebuild
  instead of failing on `no such column`.

## 3. Fail the build on a tail no record explains

- [x] 3.1 Add `scripts/efficiency/lib/run-window.ts`: run the shared run-window SQL
  (the same statement the query registers) against a dataset path and return the
  drifting rows in the three populations the query's `drift_kind` defines — the
  rows the record explains (`judged`: `attributed` + `resumed`), the rows it does
  not (`unrecorded`: the `unexplained` rows, split by whether a record was due)
  and the rows whose own window cannot be read (`clockArtifact`) — so the alarm
  and the query can never disagree about what a tail is and the gate is per run,
  not per workflow.
- [x] 3.2 Wire it into `build-dataset.ts` after `writeDataset` and before the
  summary: fail (delete the dataset and its README, print the offending runs,
  their workflows and `analyze.ts run-window-drift`) when an `unexplained` run's
  record was due (`unrecorded.afterRecord` — the run started at or after its
  workflow's first session-window event); report `drifting`, `judged {runs,
  attributed, resumed}`, `unrecorded {runs, beforeRecord, afterRecord}`,
  `clockArtifact`, `unexplained` and `recordedWorkflows` under `runWindow` in the
  summary; never fail a run that predates its workflow's record or whose window
  cannot be read.
- [x] 3.3 Add `test/efficiency/efficiency-run-window-alarm.test.ts`: a drifting run
  whose record was due fails the build and leaves no dataset behind; the same tail
  in a workflow with no session-window record passes and is reported
  `beforeRecord`; a mixed workflow (one recorded run, one drifting run that began
  before its first record, one unreadable window) passes with the three
  populations reported apart, and a run that began at the exact instant of the
  workflow's first record fails; a binding from before the run's completion does
  not explain the tail; the run's latest binding is the reason reported; and a
  dataset file an earlier build wrote is refused with the rebuild named and left
  byte-identical.

## 4. Document the two windows

- [x] 4.1 In `docs/workflow-architecture.md`, document the session window next to
  the run window: the binding, the two events with their reasons and payloads, the
  per-event identity resolution and the two observers' own rules, the drain, the
  serialized transition and the retried `closed`, why a run is not closed when its
  session stops, how a reader pairs a tail with the run that continued it, and the
  coverage limit that a restart between two rounds leaves the turns of the
  detached conversation unrecorded.
- [x] 4.2 In `docs/efficiency/01-dataset-tooling.md`, list the query's new
  `tail_turns`, `session_recorded`, `session_reason`, `session_rebound_to`,
  `session_opened_after_completion` and `drift_kind` columns and the meaning of
  each class (with the order in which they are decided), state the build alarm's
  rule and its per-run gate with the three populations it reports, and state that
  a query refuses a dataset file whose recorded schema version is not this build's.
- [x] 4.3 In `docs/agent-session-telemetry.md`, name the two envelopes and their
  payloads, the conversation id's own attribute, the retried `closed` and the
  serialized transition, and that `runtime.tool` is emitted under the run that
  started the call.

## 5. Verify

- [x] 5.1 `bun run type-check` reports 0 errors and `bun run lint` reports no
  diagnostics for the changed files; the focused suites of 1.4, 2.3 and 3.3 pass.
- [x] 5.2 Build the pinned snapshot into a temp directory with the new extractor
  (`bun run scripts/efficiency/build-dataset.ts --evidence ~/agentic-coding-efficiency-evidence/latest --out $(mktemp -d)`) and confirm the build succeeds, every drifting run is `unexplained`/`beforeRecord`, `clockArtifact` counts the unreadable rows, and `analyze.ts run-window-drift --dataset <out>` still reports 156 runs in 38 workflows with the same tails; then commit the change and confirm `git status --short` is empty and `openspec validate --changes --strict` passes.

## 6. Fix the second review round

- [x] 6.1 MIG-101/MIG-002: `resumed` requires evidence of a continuation — a
  binding the run's own completion predates is `unexplained` — and the spec, the
  docs and the alarm tests state that rule (a fixture with an `opened` row from
  before the completion and no `closed` fails the build).
- [x] 6.2 MIG-103/QV-101: the reported reason and rebinding target come from the
  run's latest row by `at DESC`; a run bound `created` and then `adopted` reports
  `adopted`, in the query test and the alarm test.
- [x] 6.3 MIG-102: a dataset file whose recorded schema version is not this
  build's is refused by `assertDatasetSchemaVersion`, naming both versions and the
  rebuild, from `analyze.ts` and `lib/run-window.ts`, and left untouched.
- [x] 6.4 MIG-104/WSV-004/WSV-005/WSV-006/WSV-007/WSV-008: the delta specs,
  `design.md` (D1's `sessionId`, D2's observer rules, D3's classes, D4's three
  populations, the assumptions), `proposal.md`, this file and the docs describe the
  implemented behaviour — the four classes and their precedence, the per-run gate,
  the nested summary keys, each observer's own resolution rule, the conversation
  id's attribute, and the 11,960 figure as the tails' own turn count (the runs hold
  14,163).
- [x] 6.5 TQV-101/MIG-105: the alarm test exercises every early return of the
  gate — a mixed workflow, the exact `>=` boundary, and a record that is present
  but states no continuation — instead of only the `first_session_window_at IS
  NULL` case.
- [x] 6.6 TQV-103: the retry of an unwritable `closed` is tested with a path the
  host cannot write (a file where its directory would be): the record lands on the
  successor's file, before its `opened`, exactly once.
- [x] 6.7 TQV-104: the resumed-run test reads its baseline after `runtime.settled`
  and asserts the session-event delta rather than a raw envelope count.
- [x] 6.8 CONCURRENCY-003/CONCURRENCY-005/QV-103: the transition is serialized per
  conversation (two overlapping rebindings close each left run once, in order) and
  the pending closes are a bounded queue rather than a single slot; the duplicate
  `toolSurfaces.set` is gone.
- [x] 6.9 CONCURRENCY-004/TQV-102: each envelope is written under the identity it
  is handed rather than one re-resolved later, with the contract pinned by a test;
  a deterministic cross-rebind producer test is not achievable with the faux
  harness, which `design.md` records as a known limitation instead of claiming
  coverage.

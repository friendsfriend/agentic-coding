## 1. Record the session window

- [ ] 1.1 In `src/agent-host/telemetry.ts`, let `attachTelemetry` take its identity
  as `TelemetryIdentity | (() => TelemetryIdentity)` and resolve it per emission
  (one local `identityOf()` used by `emit` and by any read of an identity field),
  so one stream can serve several runs over its life. Keep the existing signature
  meaning for a caller that passes a plain identity.
- [ ] 1.2 In `src/agent-host/host.ts`, keep the run each conversation is bound to
  (`ensureRun` writes it; the per-run cleanup in `stopRun` does not delete it) and
  update it before the run's first submission. Pass a getter to `attachTelemetry`
  that reads the current binding, and make the run-scoped hooks
  (`onMeasuredContext` → `observeContext`, `onToolOutcome` → the dead-surface
  monitor) read the same binding instead of closing over `input.runId`, so the
  cost ceiling and the monitor follow the active run.
- [ ] 1.3 Emit the two session-window envelopes through the same sink: when a
  conversation is bound to a run that differs from the previous binding, emit
  `runtime.session_window.closed` for the previous run (payload
  `herdr.session.rebound_to`) and then `runtime.session_window.opened` for the
  new one with `herdr.session.reason` `rebound` and `herdr.session.previous_run_id`;
  for a new conversation emit `opened` with `created`, for a conversation
  re-bound to the same run `opened` with `resumed` and no `closed`, and for a
  conversation whose previous run the host cannot name `opened` with `adopted`
  and no `closed`. Carry the conversation id as the envelope's `sessionId`, emit
  nothing when the binding carries no run id, and let a failed emission stay
  best-effort.
- [ ] 1.4 Add `test/agent-host-session-window.test.ts` on the durable-host
  fixture: a later round served by the same conversation records `closed` for the
  earlier run and `opened(rebound)` for the later one, in that order, with the
  conversation id as the session id, and the later round's `runtime.*` envelopes
  carry the later run id while the earlier run keeps only its own; a run whose
  conversation is rebound to itself records `opened(resumed)` and no `closed`; a
  new conversation records `opened(created)`; a conversation with no
  `HERDR_RUN_ID` records nothing; and the run rows' status, start and completion
  are the same as without the record. Run it with
  `HOME=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) HERDR_WIKI_DIR=$(mktemp -d) bun test test/agent-host-session-window.test.ts`.

## 2. Classify a tail in the dataset

- [ ] 2.1 In `scripts/efficiency/lib/extract.ts`, map `runtime.session_window.opened`
  and `runtime.session_window.closed` to the `lifecycle` event class so the two
  events are readable by name and class from `events` (they must not be dropped
  as turn/call events, and their payload stays in `detail`).
- [ ] 2.2 Extend the `run-window-drift` query in `scripts/efficiency/lib/queries.ts`
  with `tail_turns` (the turns that started after the run's recorded completion)
  and `drift_kind` ∈ `attributed` (a `runtime.session_window.closed` event exists
  for this run at or after its completion) | `clock-artifact` (`completed_at <=
  started_at`) | `unexplained`, keeping every existing column, the one-minute
  threshold and the ranking.
- [ ] 2.3 Extend `test/efficiency/efficiency-queries.test.ts`: a drifting run with
  its session-window `closed` event is `attributed` with the right `tail_turns`; a
  run whose completion precedes its start is `clock-artifact`; a drifting run with
  neither is `unexplained`; a run whose turns all precede its completion is absent.
  Run `HOME=$(mktemp -d) AGENTIC_CODING_CONFIG_DIR=$(mktemp -d) HERDR_WIKI_DIR=$(mktemp -d) bun test test/efficiency/`.

## 3. Fail the build on an unexplained tail

- [ ] 3.1 Add `scripts/efficiency/lib/run-window.ts`: run the shared run-window SQL
  (the same statement the query registers) against a dataset path and return the
  drifting rows split by `drift_kind` plus the workflows that recorded no
  `runtime.session_window.*` event, so the alarm and the query can never disagree
  about what a tail is.
- [ ] 3.2 Wire it into `build-dataset.ts` after `writeDataset` and before the
  summary: fail (delete the dataset and its README, print the offending runs,
  their workflows and `analyze.ts run-window-drift`) when a row is `unexplained`
  in a workflow whose recording carries a session-window event; report unrecorded,
  attributed, clock-artifact and unexplained counts under `runWindow` in the
  summary; never fail a dataset whose workflows recorded no session window.
- [ ] 3.3 Add `test/efficiency/efficiency-run-window-alarm.test.ts`: an unexplained
  tail in a recorded workflow fails and leaves no dataset behind; the same tail in
  a workflow with no session-window record passes and is reported unrecorded; an
  attributed tail and a clock-artifact tail pass.

## 4. Document the two windows

- [ ] 4.1 In `docs/workflow-architecture.md`, document the session window next to
  the run window: the binding, the two events with their reasons and payloads, why
  a run is not closed when its session stops, how a reader pairs a tail with the
  run that continued it, and the coverage limit that a restart between two rounds
  leaves the turns of the detached conversation unrecorded.
- [ ] 4.2 In `docs/efficiency/01-dataset-tooling.md`, list the query's new
  `tail_turns` and `drift_kind` columns and the meaning of each class, and state
  the build alarm's rule and its per-workflow gate.

## 5. Verify

- [ ] 5.1 `bun run type-check` reports 0 errors and `bun run lint` reports no
  diagnostics for the changed files; the focused suites of 1.4, 2.3 and 3.3 pass.
- [ ] 5.2 Build the pinned snapshot into a temp directory with the new extractor
  (`bun run scripts/efficiency/build-dataset.ts --evidence ~/agentic-coding-efficiency-evidence/latest --out $(mktemp -d)`) and confirm the build succeeds, the summary reports every drifting run as unrecorded, and `analyze.ts run-window-drift --dataset <out>` still reports 156 runs in 38 workflows with the same tails; then commit the change and confirm `git status --short` is empty and `openspec validate --changes --strict` passes.

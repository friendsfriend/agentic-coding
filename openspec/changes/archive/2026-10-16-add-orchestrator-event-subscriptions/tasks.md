# Tasks

Verification for every task is focused and change-relevant (`bun test <file>`,
`bun run lint`, `bun run type-check` on the touched surface). The complete
repository suite belongs to the workflow's own test verifier, not to these
tasks.

## 1. Catalog and derivation

- [x] 1.1 Add `src/contracts/workflow-events.ts`: `WORKFLOW_EVENT_CATALOG_VERSION`, the stable `WorkflowEventId` union, the catalog table (id → category, human-needed flag, bounded payload schema), the record/subscription/delivery wire types with Effect Schemas, and `isHumanNeededEvent`. Verify: a test asserts every catalog id declares a category, a payload schema and a derivation case, and that the human-needed set is exactly `review.waiting` and `question.pending`.
- [x] 1.2 Extend `src/server/orchestrator-policy.ts` with the review-kind map (`plan`/`developer`/`findings`/`wiki`) and derive `HUMAN_REVIEW_STEPS` from its keys. Verify: `test/orchestrator.test.ts` still passes and a new assertion pins the map's step ids against the step ids the review steps declare.
- [x] 1.3 Add `src/server/workflow-events.ts`: the projection (status, step, review, questions, attention, runs, effects, gates, completion) and the pure `deriveWorkflowEvents(previous, next, context)`. Verify: one derivation test per event id plus the negative rules — first observation silent, no `attention.raised` beside `workflow.failed`, no event for an unchanged projection, cleared-then-returned obligations reappear, `run.aborted` only with the abort attention entry, deterministic catalog ordering.
- [x] 1.4 Derive the events that need one extra bounded read: `verification.finished` (`verifierFindingCounts`), `compaction` (the run's own telemetry events), `openspec.task-progress` (the change's tasks artifact, re-read when the step or an artifact effect changed). Verify: tests over synthetic sequences, including a missing telemetry file and an unreadable artifact emitting nothing.
- [x] 1.5 Add `matchesSubscriptionFilter(filter, event)` and the implicit `DEFAULT_SUBSCRIPTION` (the ids that reproduce today's delivery (`review.waiting`, `question.pending`, `question.routed`, `attention.raised`, `workflow.failed`, `effect.failed`, `workflow.completed`)) to the same pure module. Verify: table tests over scope, workflow ids, repositories, event ids, categories, reasons, roles, minimum severity and their conjunction, plus a test that the default subscription matches exactly today's delivered ids.

## 2. Event log, subscription store and server surface

- [x] 2.1 Add the bounded, cursor-addressed event log (capacity 500, monotonic sequence, `cursor-expired` with the oldest retained sequence) and its filter/paging read. Verify: log tests for eviction without sequence restart, paging, filtering and the stale-cursor answer.
- [x] 2.2 Add the durable subscription store: atomic write (`0o600`, temp + rename) of `<config root>/orchestrator/event-subscriptions.json`, session stamping, the caps (20 subscriptions; ≤ 20 workflows / 8 repositories / 32 event ids / 13 categories per filter; bounded label and reason), and pruning on expiry, on an until-workflow reaching `closed`/`completed`, on a spent event count, and on a session that is no longer active. Verify: tests against a temp config root (`HOME`/`AGENTIC_CODING_CONFIG_DIR` under `mktemp`) reused across two store instances, plus one test per prune trigger. Move the orchestrator runtime-dir/session-name helper to a root-layer module both the server and `src/tui/orchestrator/session.ts` import (the server may not import TUI).
- [x] 2.3 Add the derivation driver in `src/server/workflow-event-bus.ts`: `workflow.updated` → per-workflow debounce (250 ms) → one `ServerOperations.view` read → derive → record → match and publish; a repository baseline listing for `workflow.started`; a resync gap re-reads the authoritative listing; the whole pipeline is off when `monitor` is `off`; an unreadable view keeps the previous projection. Verify: a test with injected operations and a fake clock — a burst of eight updates is one read, the baseline listing emits no start event, a later listing emits one, a failed read emits nothing, `off` reads nothing.
- [x] 2.4 Add the stall tick: a tracked `active` workflow whose `updatedAt` is older than `[agents.orchestrator] stall_minutes` (new key, default 30, file-only like `limits`) emits one `run.stalled` per unchanged workflow. Verify: fake-clock tests for the threshold, the one-per-unchanged-workflow rule and the configured override.
- [x] 2.5 Publish a delivery frame to the existing broker (domain `workflow-event`) for every recorded event that is human-needed or matched by a non-`silent` subscription, carrying the event and the matched `{ id, label, mode }` set; emit `limit.hit` from the existing orchestrator start-refusal path in `src/server/app.ts`. Verify: broker tests asserting one frame per qualifying event, the matched set, no frame for a `silent`-only match, and one `limit.hit` per refusal with its counts.
- [x] 2.6 Wire the routes: `GET /api/v1/workflow/events`, `GET /api/v1/orchestrator/subscriptions`, `POST /api/v1/orchestrator/subscriptions`, `POST /api/v1/orchestrator/subscriptions/delete` — added to the v1 manifest (`src/server/protocol.ts`), the `ServerOperations` interface, `src/server/app.ts` and the orchestrator allowlist (`src/server/orchestrator-policy.ts`), constructed and stopped in `src/server/lifecycle.ts`. Verify: an `orchestrator.test.ts`-style loopback server test — the four routes work for the orchestrator and the operator, everything else stays `403 orchestrator-forbidden`, `off` refuses a subscription with its message, an unknown workflow id is refused, the cap is refused, and a stale cursor answers `cursor-expired`.

## 3. Orchestrator tools

- [x] 3.1 Add the four tools to `src/agent-host/orchestrator.ts` as new entries at the end of the tools array (additive, so the concurrent description/gate change merges cleanly) and one self-contained prompt bullet: `subscribe_events`, `unsubscribe_events`, `list_subscriptions`, `read_events`, with compact descriptions and the note-format/cursor explanation. Verify: the orchestrator tool test exercises each tool against the loopback server — the subscribe/list/remove round trip, `read_events` since a cursor with its page bound, the `off` error, the unknown-workflow error and the too-many-subscriptions error — and a prompt test asserts the note-format paragraph is present.
- [x] 3.2 Verify the `notify`-mode behaviour end to end on the server: subscriptions are accepted and listed, `list_subscriptions` says notes are suppressed, and no delivery frame is published. Verify: the same loopback test.

## 4. Shell delivery

- [x] 4.1 Add the pure delivery planner `src/tui/orchestrator/delivery.ts`: coalescing window, per-minute bound with merge-forward, per-subscription overrides, digest cadence, `silent`, de-duplication by event sequence, note labels, the 20-line/200-event/20-notes-per-hour caps, and the `[workflow-monitor]` note format. Verify: tests with an explicit `now` for each rule, including one event matched by two subscriptions producing one line with both labels, and a note that elides past the line bound.
- [x] 4.2 Rewrite `src/tui/orchestrator/monitor.ts` as the delivery client: subscribe to the gateway stream, decode `workflow-event` frames, raise the developer notification for human-needed events of orchestrator-started workflows, feed the planner and submit notes with the active session's `followUp`, keep the `off` no-op and the drop-on-failure behaviour, expose the production timings. Delete `src/tui/orchestrator/transitions.ts` and rewrite `test/orchestrator-monitor.test.ts` against the new seam (injected gateway, fake timings, injected `deliver`/`notify`). Verify: the rewritten monitor test — off observes nothing, stop unsubscribes and drops a pending note, coalescing delivers one note for a burst, a burst beyond the bound merges forward, a `silent` frame delivers nothing, a human-needed frame notifies once, the production cadence constants are pinned.
- [x] 4.3 Pin today's behaviour: with no explicit subscription, the default events produce the note the current monitor produces (same prefix, one line per event, `subs=default`). Verify: a golden-note test in the monitor suite.

## 5. Developer UX

- [x] 5.1 Add the subscription read/removal to the gateway port (`src/contracts/gateway.ts`), both adapters (`src/server/gateway/inProcess.ts`, `src/server/client.ts`) and a data module `src/tui/data/orchestrator-events.ts`. Verify: an in-process adapter test plus the loopback route test from 2.6; no view component performs the I/O itself.
- [x] 5.2 Add the `/subscriptions` command to `src/tui/orchestrator/OrchestratorView.tsx` through `extraCommands`: listing label, filter, mode, expiry and last delivery for each subscription, and a `remove <id>` form that prunes one. Verify: a component/data test for both forms and their notices; no new keybind, so the keybind catalogs and `?` help are unchanged.
- [x] 5.3 Add `stall_minutes` to the `[agents.orchestrator]` config table (`src/workflow/profiles.ts`): parse, validate (positive integer, bounded) and default, file-only with no picker row, and add it to `docs/settings-inventory.md`. Verify: parse/validation tests beside the existing monitor-mode tests.

## 6. Docs, specs and checks

- [x] 6.1 Rewrite the Monitoring section of `docs/orchestrator.md`: the server-side pipeline, the catalog's human-needed set, the subscription model with mode/filter/expiry, the note format, the `monitor` master switch, the persistence file and its cleanup, and the four tools in the pieces table.
- [x] 6.2 Run `openspec validate --specs --strict` and `openspec validate add-orchestrator-event-subscriptions --strict`, then `bun run lint` and `bun run type-check` from `agentic-coding/`, and the focused suites named above.
- [x] 6.3 Rebase on the main branch if it moved, confirm the additive edits to `src/agent-host/orchestrator.ts` merge cleanly with the concurrent tool-description/transcript-gate change, and write the final summary naming the change id, the decisions that shifted from the design, and the verification commands that ran.

## Status notes (core.implementation, verification-fix round)

Fixes applied for the eight verifier reports (all code, docs and focused tests
re-run: `bun run type-check` clean, `bun run lint` exit 0, 190 focused tests
green across 13 files, `openspec validate --strict` valid):

- The implicit `default` subscription now participates in matching
  (`effectiveSubscriptions()`, used by delivery, the listing and the cap), so a
  fresh session really delivers today's events (QUAL-003, MIG-001, CV-002).
- `EventEnvelope` is imported from its declaring contract module and the tool
  test's lookup supplies a full run context: the type gate passes (QUAL-001,
  QUAL-002).
- Attention reasons are bounded, control-stripped and credential-masked, and
  `boundedSummary` now runs `redactSecrets` (SEC-001, OPENSPEC-002, TQ-003).
- The stall tick records each workflow's own `startedBy`, carried on the
  projection; its clock advances only on a real change (QUAL-004, SEC-002,
  OPENSPEC-005, CV-007).
- `scope` is optional and reads as `mine` in the contract, the tool, the route
  decoder and the bus; a filter is built whenever any field is present, so no
  field is dropped (QUAL-005, TQ-002, OPENSPEC-004).
- Delivery frames carry each subscription's `coalesceMs`/`minIntervalMs`/
  `digestMinutes`, the planner honours them (per-label floors), and the server
  stamps `lastDeliveredAt` and spends `remainingEvents` only for a frame it
  actually published (TQ-001, OPENSPEC-001, MIG-002, CV-004, USABILITY-003).
- Subscription ids carry a random suffix, and a store write re-reads the file
  before merging, so a retried subscribe is a new identity and another writer's
  record survives (QUAL-006, CV-006, CV-005).
- The store records its closed workflows and refuses an unknown store version,
  so `untilWorkflowClosed` resolves after a restart and a future format is not
  misread as this one (MIG-003, MIG-004).
- Derivation advances the projection only after its drafts are drained and
  isolates a throwing delivery per draft; the shell keeps its backlog across a
  resync (CV-003, CV-001).
- `compactionEntries` is memoized on the telemetry file's mtime+size, the
  configuration and session reads are memoized behind their documents' mtimes,
  the LRU evicts a whole repository's keys, and the view is projected once per
  observation (PERF-002..PERF-006).
- `/subscriptions` reports a failed read as a failure, names the master switch,
  describes the implicit default as built-in and gives no removal form for it,
  prints each exact removal command, and the command palette is windowed so one
  command per subscription cannot grow it past the page (USABILITY-001, 002,
  004, 005).
- `DELIVERY_TIMINGS` reads the contract's own caps; the payload-table comment
  says what is true; the stall threshold is folded into the launch-limits
  inventory row instead of inventing a Settings row (QUAL-007, QUAL-008,
  MIG-005); the change documents agree that the default subscription's list
  includes `workflow.failed` (OPENSPEC-003).
## Status notes (core.implementation, verification-fix round 2)

Fixes for the second verification round (type-check clean, lint exit 0, 225
focused tests green across 15 files, build succeeds, `openspec validate
--strict` valid):

- The complete suite's one failure is fixed: `test/otel/orchestratorMonitorShell.test.tsx`
  now emits the redesigned `workflow-event` delivery frame instead of the retired
  `workflow.updated` envelope (TEST-001).
- `remainingEvents` is one documented meaning again - a *record* budget, so every
  matched non-implicit subscription is charged, `silent` included (QF-001,
  MIG-103, OPENSPEC-008); `lastDeliveredAt` is still stamped only for the modes
  whose frame can become a note.
- A store this build cannot read (an unknown `version`, unparsable JSON) is never
  overwritten: explicit mutations fail with `StoreUnreadableError` (409
  `store-unreadable` on the route) and background delivery writes skip
  (QF-002, MIG-101, CV-011).
- Another session's records are kept by this session's writes (only expired ones
  are dropped), `session.json` is written atomically and an unreadable session
  file prunes nothing (MIG-102, CV-008); the store's `closed` list is merged on
  write instead of replaced (CV-009).
- Delivery charges are buffered and flushed lazily, so one delivered event no
  longer rewrites the store synchronously (PERF-103); the infrastructure read is
  grounded in the verification edge and built once per role (PERF-101); the
  master switch is memoized for a second instead of re-resolving the layered
  config per event (PERF-102); `read_events` no longer resolves workflow ids and
  `subscribe` resolves from the bus's own index (PERF-104); change detection uses
  the diff's own answer instead of two JSON fingerprints (PERF-105); the
  compaction cache is bounded, released with a repository and cleared on stop
  (PERF-106).
- The compaction payload's `role`/`reason` are sanitized where they enter the
  process and where the payload is built (SEC-004, OPENSPEC-007).
- `subscribe_events` can set `coalesceMs`/`minIntervalMs` (OPENSPEC-006).
- The shell treats a superseded subscription read as "nothing new" and its
  failure notice names what is still usable (USABILITY-001/002), the broker's
  subscriber queue delivers the newest event instead of dropping it and the
  monitor re-opens the stream from its last sequence on a resync (CV-001), the
  per-draft isolation covers the append as well (CV-010), and a misspelled local
  in the route test is gone (QF-003).
- New tests: the durable `closed` producer and its restart read (TQ2-001), the
  injected `enrich` baseline (TQ2-002), the telemetry-cache invalidation
  (TQ2-003), the two-role verification counts and their absent case (TQ2-004),
  the five-reason cap and the masked compaction reason (TQ2-006, OPENSPEC-007),
  the unreadable-store refusal over the route, and the tool's cadence overrides.
## Status notes (core.implementation, verification-fix round 3)

Fixes for the third verification round (type-check clean, lint exit 0, 229
focused tests green across 15 files, build succeeds, `openspec validate
--strict` valid):

- The type gate is green again: `StoreRead` has one literal per variant (QA-001)
  and the monitor captures its narrowed gateway before the hoisted `relink`
  (QA-002).
- `remainingEvents` is a record budget that is actually spent on the record path:
  the charge happens before the publish decision, so a `silent` subscription ends
  by count for non-human-needed events too (QA-003, MIG-202, OPENSPEC-009);
  `lastDeliveredAt` stays gated on the modes whose frame can become a note.
- The buffered-charge flush is error-isolated: a filesystem failure is reported
  and the charge is retried on the next tick instead of escaping the timer as an
  uncaught exception (QA-004, CV-012).
- A store that exists but cannot be read (permissions, I/O, an oversized file) is
  `unreadable`, not `missing`, so it is never overwritten; the read is size-capped
  and the echoed version is bounded (MIG-201, SEC-005).
- `subscribe_events` refuses to stamp a guessed session name while the session
  file cannot be read (`UnknownSessionError` -> 409 `session-unknown`) instead of
  creating a record that can never be live (CV-015).
- The stall clock advances only on a real change: an enrichment that learned
  nothing new no longer counts as progress (CV-007), and the telemetry cache is
  released by the worktrees a repository owns, with a separator-safe match
  (PERF-203).
- A negative OpenSpec result is remembered by the artifact's stamp, so a quiet
  workflow is not re-read per observation (PERF-202); a broken configuration is
  cached for the same short window as a good one (PERF-201).
- The broker iterates a snapshot of its subscribers, so a subscriber that
  re-subscribes from its own overflow callback is not handed the triggering
  envelope twice (CV-014).
- `/subscriptions` rebuilds its transcript block after a removal, so the listing
  and the confirmation agree (USABILITY-001).
- The burst test drives the monitor with an injected clock instead of racing a
  millisecond boundary (TQ3-001); new tests cover the background write over an
  unreadable store, the closed-list bound, a throwing store write that keeps its
  charge, the unreadable-session refusal, and the silent budget on a non-human
  event (TQ3-002, TQ3-003).
## Status notes (core.implementation, verification-fix round 4)

Fixes for the fourth verification round (type-check clean - verified with
`tsc --noEmit --pretty false`, because colored tsc output hides "error TS" from a
plain grep - lint exit 0, 232 focused tests green across 15 files, build
succeeds, `openspec validate --strict` valid):

- The last three type errors are gone: the bus test's `harness` type declares the
  `chargeFlushMs` option it passes (QB-001).
- The durable half of a delivery charge works again: `flushCharges` clears the
  live map but applies its *snapshot* to the store, so a floored flush no longer
  writes the uncharged record (TQ4-001). A test reads the store file (and a
  second bus over the same runtime dir) instead of the in-memory listing.
- `lastDeliveredAt` is stamped only for a frame that was actually published, so a
  `notify`-mode suppression never reports a delivery (QB-002, OPENSPEC-010); the
  record budget still counts every match.
- `unsubscribe` refuses an unreadable store with `StoreUnreadableError` instead of
  answering "already gone", and the delete route funnels through the shared error
  vocabulary (409 `store-unreadable`) (MIG-401, SEC-006).
- While the active session cannot be read, no stored record is live for listing or
  delivery (the write path still preserves every record) (MIG-402).
- The per-repository worktree bookkeeping is bounded, pruned with the workflow
  that departs and released with the repository (PERF-401); the artifact caches'
  size is an option (`sourceCacheEntries`) rather than a fixed 64 (PERF-402).
- A resync delivered synchronously inside `subscribe` no longer leaks
  subscriptions: `relink` is generation-stamped and closes the subscription a
  nested call superseded (CV-013), with a test that asserts exactly one live
  subscription after a resync storm.

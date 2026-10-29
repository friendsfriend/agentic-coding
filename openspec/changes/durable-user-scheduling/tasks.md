## 1. Contracts and admission foundation

- [x] 1.1 Read the workflow Effect guide and direct adapter dependencies; define scheduling schemas/state transitions, target adapter reserve/activate/query contract and exact admission linearization in new contracts/domain modules without duplicating workflow role tables.
- [x] 1.2 Prove native conversation requestId deduplication/receipt lookup across restart with a local fake-model fixture; implement supported durable inbox/receipt integration if needed. Stop and ask if no supported atomic boundary exists; do not weaken guarantees or patch dependencies.
- [x] 1.3 Add dedicated fenced scheduled-admission/query verbs to host protocol/client and minimal host hooks, pinned to expected host/conversation/run and content digest; test reservation, activation, acknowledgement loss, missing/rebound identity and safe followUp without steer.
- [x] 1.4 Extract non-TUI orchestrator bootstrap into agent-host/orchestrator-session.ts with compatibility UI delegation; verify server-owned startup without opening the view and preserve current interactive session behavior.

## 2. Timing and durable storage

- [x] 2.1 Implement pure once/relative, anchored interval and weekday/hour/minute calendar recurrence, explicit timezone validation, local once fold resolution and five-run preview; pin a normal timezone dependency only if necessary.
- [x] 2.2 Add fake-clock recurrence tests for exact due boundaries, six-hour elapsed intervals, weekdays/Mondays, Europe/Berlin spring gap/autumn fold, a non-hour DST zone, leap/date boundaries, invalid zones and forward/backward clock movement.
- [x] 2.3 Implement config-root private SQLite v1 store for jobs/schedules/occurrences/receipts with revision checks, unique slot identities, job-level occupancy, fences and bounded indexed pagination; test fresh/reopen/corrupt/newer-version behavior and secret-free persisted records.
- [x] 2.4 Implement idempotent atomic create job+schedule, reusable job CRUD, schedule CRUD/actions and affected-schedule confirmations, including stale revision/body conflicts and live-reference deletion refusal.

## 3. Scheduler service and recovery

- [x] 3.1 Implement lifecycle-owned polling/reconciliation with injected clock, bounded fair batches, five-second polling allowance, recurring missed-range summaries and explicit once late/expiry policies; verify view closure independence and stop cleanup.
- [x] 3.2 Implement claim/reserve/fenced activation/receipt reconciliation with immutable effective settings and target identities; preserve occupancy through ambiguous acknowledgement and lease expiry.
- [x] 3.3 Implement pause/edit/postpone/resume/cancel/delete/run-now semantics, once run-now consumption and recurring cadence preservation; test each mutation racing against claim, reservation and activation, including concurrent job-referencing schedules.
- [x] 3.4 Implement no-overlap including pending wake-ups, unknown states and human-review waits, destination anti-flood constraints, bounded infrastructure-only retries and explicit launch-failed versus execution-failed outcomes.
- [x] 3.5 Add fault-injection tests at claim, reservation, receipt persistence, activation, launch-before-ack and completion-before-record windows with two competing dispatchers and store reopen; assert one target identity and no duplicate runnable execution.
- [x] 3.6 Implement bounded terminal history retention, active/unknown exemptions, durable anti-replay cursors/keys, missed summaries and stable paginated retention boundaries; test caps and pruning without slot recreation.

## 4. All target adapters

- [x] 4.1 Implement durable wake-up adapter using pinned original conversation and persisted self-contained context; retain temporarily unavailable delivery, expose missing-destination attention, and track queued/dequeued/processing/terminal transitions independently of compaction.
- [x] 4.2 Implement standalone tracked execution manifests and isolated worktree/output/evidence links through existing host/runtime/model/policy infrastructure, with read-only default and explicit ordinary authorization for broader policies; never submit to interactive orchestrator.
- [x] 4.3 Implement workflow occurrence adapter through existing validated start path with stable ownership/digest, app/stage/branch/task checks and normal human gates; reattach idempotently rather than duplicating workflow starts.
- [x] 4.4 Test all adapters with unavailable configuration, invalid start settings, changed presets, wrong identities, policy refusal, review waits, execution failure and result navigation; prove no auto-review/permission widening or automatic replay of partially executed work.
- [x] 4.5 Run actual isolated local fixture executions of all three targets (fake local model/runtime, temporary repository/stores): busy orchestrator wake-up across compaction/restart, independent standalone report and supported workflow stopped at its normal human gate. Capture safe run/result identity evidence, not live model calls.

## 5. Shared server API, tools and reporting

- [x] 5.1 Register scheduling operations/routes in server app/protocol/handlers/client and orchestrator policy, with body/page/entity bounds, explicit authority, structured errors, request keys and revision preconditions; wire service startup/status/shutdown in lifecycle.ts.
- [x] 5.2 Add scheduling tool definitions in a separate module with minimal orchestrator.ts registration/guidance; cover create/inspect/list/edit/postpone/pause/resume/run-now/cancel/delete/history, including explicit job deletion and atomic creation.
- [x] 5.3 Add contract tests exercising tools and typed manual client against the same temporary loopback service: validation parity, compact confirmations, timing/zone/next run/effective policy, body conflicts, unknown fields, authorization and secret redaction.
- [x] 5.4 Publish scheduling state/completion/failure/review-wait notifications using existing events/attention and snapshot/resync conventions; verify history remains authoritative when notification delivery fails.
- [x] 5.5 Add focused regressions preserving all-imported-tool orchestrator access without allow-lists and native codemode; keep Pi bridge files outside scheduling scope and reconcile minimal shared host changes through normal reviewed integration with fix-late-mcp-registration.

## 6. Complete manual Schedules experience

- [x] 6.1 Register Schedules in shell route/destination/navigation and add list/detail/history views with required columns, service availability, active occurrence and linked exact-conversation/standalone/workflow output/evidence navigation.
- [x] 6.2 Add reusable-job and schedule editor forms for all targets and once/relative/interval/calendar timing, required target settings, context/destination and late policy, using authoritative preview/confirmation and retained inline validation.
- [x] 6.3 Add run-now/pause/resume/reschedule/postpone/cancel/delete and shared-job edit confirmations, explicit active-run preservation and stale-revision reload behavior; do not implement separate client policy logic.
- [x] 6.4 Define owning per-surface keybind catalogs with compact labels/standard navigation and shared footer/help rendering; no in-content cheat sheets.
- [x] 6.5 Add focused OpenTUI interaction tests exercising the isolated real App for list/editor/history/navigation, all three targets and timing choices, action confirmations, footer and '?' help, narrow viewport and unavailable service. Preserve safe interaction evidence and record fixture limitations. Live/manual environment validation is developer-owned per the follow-up clarification, not an implementation blocker.

## 7. Documentation and focused finishing gates

- [x] 7.1 Document shared scheduling API/tools/manual flows, target authority, recurrence/DST/overlap/late semantics, retention, recovery/rollback and headless versus shell-owned lifecycle; state no OS wake/always-on guarantee. Supply wiki gaps to the dedicated documentation step; do not create near-duplicate concepts.
- [x] 7.2 Run focused new scheduling/domain/store/admission/API/tool/UI tests and relevant existing host/orchestrator/start-validation/keybind regression tests, then package `bun run lint` (zero diagnostics) and `bun run type-check` (zero errors). Fix underlying issues using Biome; never hand-edit generated files. Repository-wide suite execution belongs to workflow test-verifier, not this worker checklist.
- [x] 7.3 Validate OpenSpec strictly and review implementation diff for scope, secret handling, target gates and shared-host conflicts; ensure local fixture evidence covers all three targets and results links before requesting reviews. Use copilot-sol through the configured managed workflow, without manually starting agents or bypassing approvals.

All test and CLI smoke invocations MUST set isolated HOME, AGENTIC_CODING_CONFIG_DIR, PI_CODING_AGENT_DIR and HERDR_WIKI_DIR and use temporary databases/repositories. No paid external model/live service calls, real user schedules, running developer-instance build/restart, live workflow stores/credentials, unrelated WIP changes, stashing main, dependency patches or unmerged bridge dependencies. Developer owns final approvals/closure and standing squash merge.

## Validation record (implementation run 4931136e-c592-413a-b5bc-fac6f7c617d0)

- Focused isolated regression: 200 tests / 24 files / 916 assertions, all passing.
- Package lint: zero Biome diagnostics; all 71 architecture boundary tests passed.
- Whole-project type check and host-target build passed. Strict OpenSpec validation passed.
- Actual fake-local-model/runtime fixtures captured wake-up reservation/result across in-flight compaction and host restart, standalone lost-acknowledgement recovery, and a single workflow start reaching normal developer review.
- Real headless OpenTUI App fixtures exercised all target forms, exact timing round trips, acknowledgement uncertainty, scoped history, footer/help, 80-column rendering, unavailable service and identity-preserving refresh.
- Unchecked tasks are deliberately not claimed complete. Required follow-up includes the exhaustive mutation/fault/retention/negative-adapter matrices, notification-loss/resync assertions, all manual action confirmations, and reviewed shared-host integration.
- A configured isolated application/terminal validation target was unavailable. Headless UI evidence is not a physical-terminal/manual-app check. Linux native CI remains the approved mandatory pre-merge gate.
- No agents were launched and no review was bypassed; managed review remains downstream. Scheduling documentation is in agentic-coding/docs/scheduling.md; wiki integration belongs to the dedicated documentation step.

## Follow-up validation (implementation run f71052f7-8515-4371-929c-097e11b12e79)

- Developer clarified that live/manual environment validation is their responsibility. No live application, developer instance, paid model or real user schedule was used.
- Isolated focused regression: 227 tests across 21 files, 1,080 assertions, zero failures. Additional imported-tool/native-codemode/collision regressions: three passing tests. Final store rerun uses the public idempotent mutation API after the type gate caught a test-only private-helper call.
- Added the 21-case mutation/admission matrix, shared-destination and job occupancy checks, recurring run-now/postpone cadence, eight two-dispatcher fault windows with reopen, bounded infrastructure-only retries, retention cap/age/page-boundary/anti-replay checks, notification-loss/replay-overflow resync and server lifecycle tests.
- Fixed receipt-commit acknowledgement recovery to retain the durable reserved state rather than retrying an occurrence with a receipt as pending. Fixed text-entry opening commands being inserted into postponement timestamps. Added explicit once-wake-up/ambiguous-recurring-request orchestrator guidance.
- Adapter checks cover unavailable destinations/configuration, removed models/presets, invalid thinking/branches/start settings, standalone host/conversation rebinding, admission refusal and pinned workflow configuration. The actual workflow adapter retains all normal human gates across preset removal; independent native execution still reaches developer review without auto-approval.
- Thirteen real-App headless OpenTUI journeys cover action confirmation/cancellation, active review-wait preservation, stale draft/reload, shared-job fan-out, target/timing forms, output/history, help/footer, narrow rendering and stopped-service status. Physical-terminal validation is not claimed.
- Final package lint has zero diagnostics and 71 passing boundary tests; whole-project type check and host-target build pass. Linux native CI remains the approved mandatory pre-merge gate, not a local execution claim.
- Shared host/protocol/client/extension changes were reviewed directly after an inconclusive classifier result: additive verbs and destination callback, no imported-tool allow-list, no Pi bridge edits or unmerged dependency. Coordinate merge-time overlap at DurableHost.open, request dispatch and orchestrator tool registration through the normal downstream review; no other worktree was accessed.
- Strict OpenSpec validation and whitespace checks pass. Safe focused-check, final-gate, local-target and headless-UI evidence is attached to this run. Full-suite verification, independent reviews and wiki integration remain owned by their normal managed steps.

## Verifier follow-up (implementation run 8a167ada-6163-417c-b1cd-c799ecf41bca)

- Addressed all nine findings in the eight declared verifier reports; the migration report had no findings.
- PERF-001: terminal writes enforce the per-schedule cap through indexed cutoffs; indexed age expiry deletes at most 100 records per maintenance batch, throttled to once per minute rather than each idle poll. Active/uncertain occupancy and anti-replay records remain exempt.
- OPENSPEC-001 / QUALITY-001: run-now keeps the admission/configuration revision unchanged and uses its transactional request receipt for retry identity. Pending/reserved and writable review-wait regressions prove an overlapping skipped manual request cannot invalidate the original work.
- CONCURRENCY-001: per-occurrence descriptor-relative flock ownership serializes external worktree preparation past lease expiry. A deterministic held-preparation/two-dispatcher test proves contention retries and converges to one native admission/report.
- SECURITY-001: the workflow database retains its source directory capability until close; exclusive migration backup creation and file/directory fsync use that exact capability. The ancestor-replacement regression proves no backup or foreign file is created through a substituted symlink.
- USABILITY-001 / USABILITY-002: bounded, grapheme-aware editing viewports follow the appended caret across wrapped and multiline content. Safe schema paths/constraints reach shared API/client errors and map to highlighted/selected form fields without echoing submitted values; real-App rendering and API regressions cover correction and redaction.
- TEST-001: automatic writable standalone waiting-review is asserted before any admission/activation, across repeated ticks, store reopen, orchestrator approval refusal and an overlapping run-now, followed by exactly one operator-authorized activation of the same occurrence.
- TEST-002: separate native fixtures reopen before activation and while a busy follow-up is still queued. They verify the same submission/conversation, self-contained content, exact linked result, idempotent reactivation and no delivery to the reattached unrelated conversation. This uncovered and fixed graceful shutdown withdrawing queued scheduled inputs: a native durable pending-input index now preserves them for harness recovery, without changing explicit developer abort semantics.
- Focused isolated regression: 129 tests across 12 files, 670 assertions, zero failures. Final native-admission rerun: four passing tests / 36 assertions. The existing constant-size ownership test was corrected to include its pre-existing runtime-failure lookup rather than asserting only one total snapshot; no ownership behavior was changed.
- Final lint: zero Biome diagnostics and 71 passing architecture-boundary tests / 277 assertions. Final whole-project type check has zero errors; the initial gate caught unsupported session-document options, which were removed to match the existing native session-document contract. Host-target build, strict OpenSpec validation and whitespace checks pass; generated files were only regenerated by the build.
- No live app, developer-instance restart, paid model, real schedules or external user stores were used. Full-suite verification and independent shared-host reviews remain downstream; Linux native CI remains mandatory before merge, and physical-terminal/live validation remains developer-owned.

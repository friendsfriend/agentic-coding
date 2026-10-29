# Durable user scheduling

Scheduling is owned by the backend lifecycle, not by the Schedules view. Closing the view does not stop admitted work. Stopping the backend stops polling: this is not an OS alarm, machine-wake facility, or always-on service. Status reports availability and the five-second polling allowance. Headless callers and the shell use the same authenticated backend and store.

## Jobs, schedules and authority

A reusable job contains its task and target settings. A schedule references a job and supplies timing and late policy. Shared-job edits require the authoritative affected-schedule confirmation; referenced jobs cannot simply be deleted. Revisions prevent stale edits. Atomic job-and-schedule creation is available.

The shared typed client uses `POST /api/v1/scheduling`. Scheduling tools call the same operations rather than implementing a separate scheduler. Operator authority is derived by the server, not accepted from request bodies. Destination bootstrap and approval are operator-only. Agent-created standalone work cannot grant itself wider permissions.

Targets:

- **Wake-up:** pins an existing orchestrator host, run and conversation. Busy delivery uses native follow-up, never steer. Missing or temporarily unavailable destinations remain visible; recovery never silently selects a different conversation. Operator bootstrap can create the destination without a model turn.
- **Standalone:** uses an independent tracked host and isolated worktree, configured model/thinking settings and retained output/evidence identity. The default is read-only. Broader ordinary policy requires explicit human review per occurrence; it does not reuse the interactive orchestrator. Scheduled worktree preparation disables repository hooks and fsmonitor. A per-occurrence, crash-released cross-process lock serializes preparation even if the scheduler claim lease expires; contention retries the same occurrence rather than declaring invalid input.
- **Workflow:** uses normal validated workflow startup, immutable effective settings and ordinary human review gates. Scheduling does not approve plans, developer review, or documentation review automatically.

## Time and overlap

Once timing supports explicit instants, server-resolved relative delays, and local times in an IANA zone. Nonexistent local times are rejected; ambiguous local once times require an explicit fold choice. Intervals preserve an elapsed-time anchor and exact millisecond duration. Calendar timing uses ISO weekdays, hour/minute and an explicit zone: recurring spring gaps are skipped and autumn folds use the earlier occurrence. Preview is authoritative and shows the next five runs.

Recurring downtime produces bounded missed-range summaries rather than a catch-up flood. Once work follows its explicit late/expiry policy. Run-now consumes a once schedule but does not move a recurring anchor or change the configuration revision authorizing outstanding work. An overlapping manual slot is skipped without invalidating the original pending or review-waiting occurrence. Postpone changes the next occurrence without silently converting the recurrence. Pause, edit, cancel and delete do not retroactively revoke already admitted work.

Occupancy is job-wide across referencing schedules. Queued wake-ups, uncertain acknowledgements and human-review waits still occupy the job. Destination anti-flood checks further constrain wake-ups. Only classified infrastructure failures receive bounded automatic retries; execution failure or partial execution is not permission to replay the task.

## Manual operation

Open Schedules from Home. Jobs and schedules have paginated lists, details, scoped history, and exact occurrence output. Editors cover all three targets and once, relative, interval and calendar timing. Forms retain validation errors and drafts. Use the owning footer and `?` catalog for available actions; F2 is a portable save alternative to Ctrl+Enter. Narrow schedules footers wrap instead of hiding actions.

Mutations use durable request keys and revision preconditions. If an acknowledgement is lost, retain and retry the same attempted request rather than inventing another one. Route-owned state preserves this uncertainty across navigation. Requests are bound to a persistent store UUID; replacement-store retries fail explicitly. Service-unavailable status does not erase retained details. Refresh preserves the selected entity identity when rows move.

## Recovery, storage and results

State is private SQLite at the config root's `scheduling/scheduling.sqlite`. The repository-owned constrained VFS permits only registered database basenames and validates main files and sidecars through directory capabilities, including ownership, permissions, symlinks and hard links. There is no unsafe runtime/compiler fallback. Workflow schema upgrades retain a private, fsynced pre-upgrade backup through the exact directory capability held for the source database, never a reopened ancestor pathname.

Admission reserves a native identity/content digest, persists the receipt, commits the scheduler revision/fence boundary, and only then activates idempotently. No database transaction spans target I/O. Ambiguous activation keeps occupancy and reconciles the same target identity after restart. Native conversation request receipts deduplicate inbox submission; a native durable pending-input index also prevents graceful host shutdown from withdrawing queued scheduled follow-ups. Explicit developer abort retains its ordinary cancellation semantics. Workflow activation commits its receipt and runnable outbox atomically.

History is authoritative even if a notification is missed. Terminal writes enforce the per-schedule history cap using indexed cutoffs; age-expiry maintenance deletes bounded batches at most once per minute, not a whole-history scan per polling tick. Bounded terminal retention exempts active and uncertain work; durable anti-replay keys/cursors prevent pruned slots from returning. Output is tied to the exact native submission/answer, not the conversation's latest reply. Retained text is bounded; native identities remain available when text is absent. Standalone artifacts and workflow identities support result navigation.

Do not repair corruption by deleting an uncertain occurrence or replaying into a fresh store. Stop the service and preserve the private database and relevant backups for diagnosis. Restoring/replacing a store is an explicit operator recovery action, not an automatic retry strategy.

## Verification and release gates

Isolated tests use temporary HOME/config/wiki/provider directories, fake local models/runtime workers, temporary repositories and authenticated loopback APIs. They cover native reservation/activation acknowledgement loss, an in-flight real compaction plus host restart, standalone recovery without a second execution, workflow recovery at its normal human gate, and real headless App/editor/history/footer/help interactions at 140×40 and 80×40. They do not use paid models, live stores, real future schedules, or restart the developer's application.

macOS native validation is local. **Linux native build/runtime CI remains a mandatory pre-merge gate**, including OFD locking, sidecar safety, WAL conversion and crash recovery. A physical interactive terminal/application validation target was unavailable; headless OpenTUI evidence must not be described as a developer-app restart or physical-terminal check. Shared shell keymap warnings about legacy layer fields are outside the scheduling layer.

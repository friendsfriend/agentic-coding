## Context

Dashboard `getWorkflowView()` starts a fire-and-forget drain; CLI status awaits a drain. Snapshot/status paths expire questions, and legacy/schema reads can write. Handoff reducers perform Git walks and filesystem reads under BEGIN IMMEDIATE; source fingerprints include ignored files. Dashboard refresh synchronously reads Git/Herdr and reparses telemetry.

## Goals / Non-Goals

**Goals:** reads do not schedule or mutate workflow work, explicit execution makes progress without refresh, and slow evidence/observation work does not monopolize the writer lock or UI thread.

**Non-goals:** new authority stores, automatic weakening of fingerprint scope, exactly-once filesystem observation, a permanent daemon, or changing accepted workflow outcomes.

## Decisions

### Explicit execution lifecycle

Add `workflow drain --repo PATH` as a bounded repository-scoped execution command; it processes due effects and timer commands without being disguised as status. Keep workflow mutations in the unified runtime. Mutation entry points explicitly request continuation after commit, and the dashboard owns one execution coordinator per open repository instead of creating one per refresh.

Reuse the detached-process launcher for continuation after CLI exit. A continuation waits for the next due retry or question deadline within its documented bounded lifetime, then exits when idle; dashboard ownership provides long-lived continuation while open. If execution requires interactive credentials and no UI is attached, expose that condition rather than collecting/persisting secrets or claiming success. Startup/resume schedules recovery of committed pending work. Refresh itself never schedules recovery.

Question expiry becomes an explicit timer command. Reads may calculate remaining time and hide expired prompts without persisting a new revision. Update the agent question wait path to request expiry through the command runtime rather than depending on polling side effects.

### Observational reads, including old stores

Read connections do not create stores, run schema DDL/imports, expire runs/questions, or claim effects. Missing/old stores return explicit absent or migration-required diagnostics. `version-workflow-store-migrations` supplies this initialization boundary. CLI status, home listing, and dashboard --json share the same non-mutating projection behavior.

### Prepare evidence outside the writer transaction

Authenticate the request sufficiently before reading assigned evidence, then collect bounded immutable artifact content, parsed evidence, digests, and source observations asynchronously. Bind prepared evidence to workflow, run generation, relevant source baseline, and observed revision. Inside BEGIN IMMEDIATE reload the latest snapshot, reauthorize capability/lease/revision and current legality, and validate the binding before applying pure domain decisions and atomic writes.

An unrelated revision from a valid parallel sibling must not automatically reject an agent handoff: revalidate that run against current state and reprepare dependent evidence when needed. Developer revisions remain exact. Never consume a capability before evidence succeeds.

Filesystem state is not locked by SQLite. Detect changed evidence and retry/reject; where a guard genuinely requires stable live source content, use an immutable captured source or retain the necessary final integrity check until an equivalent guarantee exists. Merely moving a fingerprint before BEGIN is not an acceptable security fix. Keep ignored-file coverage unless a separately reviewed isolation policy changes it.

### Keep slow work out of render callbacks

Use cancellable asynchronous subprocess calls for Git/Herdr and bounded file/telemetry collection outside render callbacks, with at most one observation refresh in flight and a queued latest refresh. Keep prior observations visible with loading/error state. Bind responses to repository/workflow selection and discard late results after navigation or unmount. Domain step hooks receive evidence values, not filesystem/process handles.

## Risks / Trade-offs

- Read-driven progress currently masks missing execution ownership → test retries and question expiry with no status reads or dashboard refresh.
- Evidence preparation opens a race window → run/revision/content binding and adversarial replacement tests are release gates.
- Asynchronous results can overwrite newer selection → generation-bound refresh results and disposal tests.
- A permanent daemon would simplify liveness but broaden deployment → retain bounded explicit continuation and document how to restart it after interruption.

## Migration Plan

Land lease safety, shared startup context, and versioned initialization first. Add drain and explicit scheduling before removing read-side work. Update detachedDrainArgv, scripts, CLI help, and architecture docs together. Preserve the existing in-process dashboard action contract. Rollback changes observation semantics back but requires no data downgrade beyond prerequisite migrations.

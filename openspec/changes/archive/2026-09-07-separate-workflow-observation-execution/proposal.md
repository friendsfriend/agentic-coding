## Why

CLI status and dashboard view reads drain effects, so observation can execute pending work and repeated refreshes create overlapping runners. Synchronous Git, Herdr, filesystem, and source-fingerprint work can also block UI input and hold the repository-wide SQLite writer lock.

## What Changes

- Make status, list, snapshot/view reads, and dashboard JSON rendering observational.
- Introduce explicit, bounded drain execution and lifecycle-owned retry/question-expiry scheduling using the existing detached-process mechanism.
- Keep dashboard command dispatch in-process while executing slow observation/evidence work asynchronously outside the UI render path.
- Separate expensive evidence collection from transactional authorization and reduction without weakening artifact validation or source-isolation checks.
- Surface runner and observation failures instead of swallowing them.
- **BREAKING:** Scripts that relied on status to advance effects must use explicit drain execution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-engine-runtime`: Explicit drain surface and pure domain/transactional boundary.
- `workflow-state-runtime`: Evidence preparation and transactional reauthorization.
- `dashboard-engine-integration`: Observational refresh and explicit execution ownership.
- `tui-input-responsiveness`: Nonblocking refresh and operation work.

## Impact

- Priority: medium; architecture finding 4.
- Depends on `fix-effect-lease-lifecycle`, `unify-workflow-startup-context`, and `version-workflow-store-migrations`.
- Code: workflow CLI/drain, runtime evidence/store/view/reducers, step guards, dashboard engine/data/App, and shared subprocess clients.
- `version-workflow-store-migrations` owns moving automatic migrations out of reads; this change owns question-expiry scheduling and effect scheduling.
- `split-dashboard-responsibilities` follows this change and only relocates the resulting code.

## Non-goals

No new database, message broker, permanent daemon, generic worker pool, or weaker source/artifact security policy.

## 1. Cutover prerequisites

- [x] 1.1 Confirm compose-unified-feature-shell is implemented and request operator confirmation of manual project reconciliation.
- [x] 1.2 Record configured IDs/canonical paths and expected workflow histories; block unresolved active absolute-path references.
- [x] 1.3 Inventory every discovery caller, including CLI, observation subprocesses, workflow home and telemetry watchers.

## 2. Canonical backend catalog

- [x] 2.1 Add typed project projection and GET /api/projects from configured apps/libraries with duplicate-ID validation.
- [x] 2.2 Implement canonical repository versus active-checkout resolution and availability/OpenSpec capability reporting.
- [x] 2.3 Add fixtures for apps/libraries, linked worktrees, missing clones, invalid repos, duplicate IDs and empty config.
- [x] 2.4 Add catalog revision/change notification and test atomic reload/error behavior.
- [x] 2.5 Add bounded catalog-only backend invocation for headless listing without operational pollers or mutations.

## 3. Consumer replacement

- [x] 3.1 Replace workflow/operations.ts project scanning and wizard preset/project loading with canonical catalog client.
- [x] 3.2 Replace dash/observations.ts workflow-root discovery and pass explicit catalog roots to async observation boundary.
- [x] 3.3 Replace otel/model/db.ts repository scanner and diff watch registrations by canonical root on catalog changes.
- [x] 3.4 Migrate CLI projects output preserving contract and distinguishing empty catalog from transport failure.
- [x] 3.5 Preserve standalone wiki/research targets and explicit authenticated --repo commands with focused tests.
- [x] 3.6 Add project cross-links between environment/workflow/telemetry without switching pinned workflow checkout.
- [x] 3.7 Remove recursive fallback walkers and legacy discovery configuration reads after all callers migrate.

## 4. Acceptance

- [x] 4.1 Test active worktree switch, configured-project removal and reconnect without duplicate histories/watchers or stopped workflows.
- [x] 4.2 Compare picker/history/telemetry/CLI roots against operator inventory and verify no discovery operation changes data.
- [x] 4.3 Run combined verification, interactive catalog/error-state checks and update migration/rollback documentation.

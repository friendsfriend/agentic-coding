## 1. Registry and identity

- [ ] 1.1 Confirm port-git-providers-and-ai-to-bun is implemented; inventory all action/command/runtime adapter owners.
- [ ] 1.2 Port stable resource/action/runtime/profile IDs and canonical labels with golden identity fixtures.
- [ ] 1.3 Port definition compilation and validation with atomic registry snapshot publication.
- [ ] 1.4 Port compact run snapshots and history projections; test config reload cannot alter active/historical definitions.

## 2. Execution semantics

- [ ] 2.1 Port semantic tree versus execution-key deduplication with duplicate-dependency command-count tests.
- [ ] 2.2 Port named typed value flow, scopes and visibility with secret/ephemeral serialization rejection tests.
- [ ] 2.3 Port run/step/command accounting preserving one leaf per executed command and commandless composites/SDK steps.
- [ ] 2.4 Port executor failure propagation and always-run cleanup behavior.
- [ ] 2.5 Port coordinator/resource leases, cancellation and late-result ownership rejection.
- [ ] 2.6 Port readiness gates and explicit already-running outcomes without invented command steps.

## 3. Scripts and processes

- [ ] 3.1 Port script discovery/configuration/create/link/delete and argument history handlers.
- [ ] 3.2 Port bounded metadata discovery and interpreter selection including shell/PowerShell/systemshell.
- [ ] 3.3 Implement process spawning/output/exit/error and process-group cancellation with platform fixtures.
- [ ] 3.4 Port tmux/script readiness, long-lived process recovery and frontend terminal-launch coordination.
- [ ] 3.5 Test process exits before readiness, unavailable interpreter, cancellation and adopted-resource protection.

## 4. Temporary runtime adapters and cutover

- [ ] 4.1 Add private Go container/Kubernetes operation adapter with exact command lifecycle/output/cancellation identity.
- [ ] 4.2 Remove competing Go run/history ownership for Bun-owned actions and verify SDK-only operations stay commandless.
- [ ] 4.3 Replace earlier Go-to-Bun Git operation bridge with direct Bun capability calls under the Bun action owner.
- [ ] 4.4 Quiesce or explicitly cancel old Go command runs, then switch sole action owner without live handle reparenting.
- [ ] 4.5 Test restart/adoption, dependency sharing, reload during run, historical views and failure cleanup.

## 5. Acceptance

- [ ] 5.1 Run registry/identity/tree/output/value/readiness/cancellation parity suites and existing workflow outbox regressions.
- [ ] 5.2 Exercise action tree/history/log/cancel/script TUI journeys; inspect footer/help if controls change.
- [ ] 5.3 Run combined verification, measure output burst handling and update ownership/rollback/adapter-removal inventory.

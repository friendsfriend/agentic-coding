## 1. Contracts and security

- [ ] 1.1 Confirm unify-application-lifecycle-and-binary shipped with frontend parity; inventory all remaining TUI backend I/O.
- [ ] 1.2 Define typed workflow/read/artifact/config/error contracts and environment route-ownership manifest with fixtures.
- [ ] 1.3 Implement loopback-default server instance authorization, method/origin checks, body/path limits and private Go authentication.
- [ ] 1.4 Preserve CLI process-ancestry/run-capability authorization across transport; test forged identity, wrong scope and stale revisions.
- [ ] 1.5 Add negative tests for untrusted browser requests, oversized payloads, path escape and secret-bearing diagnostics.

## 2. Server ownership and client migration

- [ ] 2.1 Add Bun server composition root and lifecycle integration around the existing WorkflowApplication/Effect layer.
- [ ] 2.2 Move repository coordinators and pure/read-only observation operations behind server endpoints.
- [ ] 2.3 Move telemetry receivers/stores/watchers/retention into server ownership and expose typed query endpoints.
- [ ] 2.4 Delegate unported environment routes to private Go with cancellation and bounded response handling.
- [ ] 2.5 Migrate workflow list/detail/artifact clients and remove direct filesystem/Git/Herdr/SQLite access from views.
- [ ] 2.6 Migrate workflow start/action/question/repair/config operations while preserving revisions and commit reconciliation.
- [ ] 2.7 Implement scoped ephemeral credential request/reply transport, timeout/disconnect cancellation and secret-redaction tests.

## 3. Events and CLI

- [ ] 3.1 Implement domain event envelope with instance/sequence/revision and bounded subscription buffering.
- [ ] 3.2 Add stable replay/history cursor or snapshot-resync behavior; test reconnect gaps and slow-client output recovery.
- [ ] 3.3 Migrate dashboard/telemetry subscriptions and late-result rejection without enabling background mutations from reads.
- [ ] 3.4 Migrate supported headless CLI execution/read paths and full-feature attach with explicit server capabilities.
- [ ] 3.5 Remove __dashboard-observe protocol after last consumer moves and enforce typed-client-only backend access from views.

## 4. Acceptance and architecture

- [ ] 4.1 Test renderer suspension while backend lease renewal and telemetry continue.
- [ ] 4.2 Test lost mutation responses, stale actions, two-client prompts, shutdown mid-credential and server restart reconciliation.
- [ ] 4.3 Run observational-read, capability, workflow-pin, Effect-scope and durable-outbox regression suites.
- [ ] 4.4 Update consolidation/dashboard integration architecture docs and layer tests to the specified server boundary.
- [ ] 4.5 Run combined verification and packaged TUI/server/attach/CLI acceptance; record route ownership and rollback gate.

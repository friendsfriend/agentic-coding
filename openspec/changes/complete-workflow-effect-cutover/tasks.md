## 1. Runtime ownership

- [ ] 1.1 Confirm preceding Effect phases and dashboard/source-boundary prerequisites; reconcile every inventory entry against current source imports and callers.
- [ ] 1.2 Implement shared production application composition with one CLI-invocation owner and one dashboard-application owner plus repository child scopes; test acquisition and bounded disposal.
- [ ] 1.3 Migrate the existing explicit execution coordinator and detached continuation to scoped Effect operations without creating a second scheduler or restoring read-triggered drains.

## 2. Caller cutover

- [ ] 2.1 Migrate CLI command handlers, question waits, caller authentication, wiki/configuration/project tools, and exit/error formatting to the shared Effect application path; retain external protocols.
- [ ] 2.2 Migrate dashboard action/refresh/start/repair/question integration through one framework bridge; test repository switches, stale selections, post-commit cancellation, and unmount.
- [ ] 2.3 Migrate remaining workflow-facing home wiki, model/configuration, project discovery, navigation, and asset I/O callers using existing application services; leave pure presentation/projection code native.
- [ ] 2.4 Migrate telemetry/JSONL/export operations with existing identity correlation and redaction; test failed export after commit and bounded shutdown flush without detached fibers.
- [ ] 2.5 Test SIGINT/SIGTERM and real restart: temporary work stops, successfully transferred agents survive, committed pending rows recover, and no mutation is blindly replayed.

## 3. Remove the mixed implementation

- [ ] 3.1 Delete all inventoried migration-only engine/handler/parser/runtime bridges and their replaced implementations/dependencies; verify remaining native adapters and pure descriptors have explicit final ownership.
- [ ] 3.2 Extend the existing TypeScript architecture checker for allowed runtime/native boundaries and obsolete shim imports, with negative fixtures and stale-exception detection; do not add a linter or regex-only duplicate checker.
- [ ] 3.3 Review intentional internal barrel API/fixture changes separately from preserved CLI/JSON/schema/pin fixtures, and mark every migration inventory row complete with no unowned deferrals.

## 4. Agent guidance and release checks

- [ ] 4.1 Update root instructions, workflow README, architecture map, and playbook to final APIs; run production-backed examples for handler and command/step extension against the locked release.
- [ ] 4.2 Repeat the recorded agent tasks in isolated worktrees with comparable model/settings/prompts, record verification/human corrections/review findings, and explicitly report regressions or inconclusive results without merging task samples.
- [ ] 4.3 Run focused CLI, dashboard, lifecycle, e2e, observability, architecture, and agent-example checks covering migrated surfaces; preserve real-process and real-store compatibility checks.
- [ ] 4.4 Run `bun run type-check`, `bun run lint` with zero diagnostics, and `bun run build` from `agentic-coding/`; smoke-test compiled startup/status/drain with fake external services and document coordinated deployment/rollback compatibility.

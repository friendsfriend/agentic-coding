## 1. Establish prerequisites and regression checks

- [ ] 1.1 Confirm lease lifecycle, shared startup context, and versioned store migration changes have landed; rebase paths and spec deltas without duplicating their ownership.
- [ ] 1.2 Add tests proving repeated status/list/snapshot/dashboard JSON reads do not change revisions, leases, attempts, questions, schema, or legacy source rows and do not launch external work.
- [ ] 1.3 Add delayed-observation renderer tests and concurrent-command tests around slow evidence preparation.

## 2. Give execution explicit ownership

- [ ] 2.1 Add the bounded repository-scoped workflow drain command and update its argument schema/help and detachedDrainArgv to stop invoking status for execution.
- [ ] 2.2 Route post-commit mutation continuation and startup/resume recovery through explicit scheduling; maintain one dashboard coordinator per repository.
- [ ] 2.3 Schedule due retry and question-expiry commands without status polling, including the agent question wait path; bound and dispose continuation timers.
- [ ] 2.4 Remove drain, expiry, initialization, and import side effects from observational APIs and expose absent/migration-required diagnostics.
- [ ] 2.5 Surface coordinator failures and pending interactive-credential conditions; test disposal, restart, and retry progress without refresh.

## 3. Separate evidence from transactional decisions

- [ ] 3.1 Define the smallest typed prepared-evidence inputs needed by current guards and collect them outside the writer transaction with initial authorization and bounded reads.
- [ ] 3.2 Reauthorize against current state inside the transaction and validate run/revision/source/content bindings before any capability consumption or writes.
- [ ] 3.3 Test artifact replacement, path/size/schema violations, source changes, expired ownership during collection, and parallel sibling handoffs; retain necessary final integrity checks until an equivalent stable-source guarantee exists.
- [ ] 3.4 Move I/O out of pure step guards into the evidence boundary while preserving fingerprint scope and accepted completion behavior.

## 4. Keep observation work off the UI thread

- [ ] 4.1 Convert slow Git/Herdr/preflight/effect subprocess paths used by the TUI to bounded asynchronous execution and move substantial file/telemetry collection out of render callbacks.
- [ ] 4.2 Coalesce refreshes with one collection in flight, retain previous data/loading/error state, and ignore late results after navigation or disposal.
- [ ] 4.3 Verify renderer input remains usable while observations and credential waits are delayed, and observation errors never imply committed completion.

## 5. Validate and document

- [ ] 5.1 Run affected workflow-cli, workflow-runtime, workflow-question, workflow-effects, workflow-dashboard, workflow-wiki-gate, workflow-wiki-scope, lifecycle, and dashboard renderer tests plus fake-Herdr CLI smoke.
- [ ] 5.2 Update scripts, CLI help, README, and architecture docs with observational reads, explicit drain/recovery, bounded continuation, and evidence-integrity limitations.
- [ ] 5.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 5.4 Run openspec validate separate-workflow-observation-execution --strict and confirm no security check was removed merely to reduce lock duration.

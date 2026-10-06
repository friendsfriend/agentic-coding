# Tasks

## 1. Configuration and decision

- [x] 1.1 Parse and validate `[agents.orchestrator] limits` (`max_active`, `max_starts_per_day`, positive integers, defaults 3/20). Verify parse/reject tests.
- [x] 1.2 Add the pure `orchestratorLaunchRefusal` decision. Verify unit tests at, below and above each limit and that the message lists the counted workflows.

## 2. Enforcement

- [x] 2.1 Count active and trailing-24 h orchestrator-started workflows across the target registry, skipping unreadable stores with a diagnostic. Verify with a multi-target fixture.
- [x] 2.2 Refuse orchestrator starts with 409 `orchestrator-limit` before `operations.start`; leave operator starts untouched. Verify transport tests for both principals.
- [x] 2.3 Add the read-only Settings inventory entry and docs; run `bun run lint`, `bun run type-check` and the focused suites.

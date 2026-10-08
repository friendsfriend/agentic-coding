# Tasks

## 1. Store and CLI

- [ ] 1.1 Add the `debug_requests` table with migration and status transitions; verify migration and transition guards.
- [ ] 1.2 Add CLI commands `debug-request`, `debug-result`, `debug-wait`, `debug-cancel` with limits and recursion refusal; verify each.

## 2. Execution and delivery

- [ ] 2.1 Add the `debug.request.run` effect (role `debug`, caller cwd, shared owner, evidence subdir, baseline capture); verify the run is started once per request.
- [ ] 2.2 Compute changed files since baseline at debug handoff and store them with the report; verify with a temp repository.
- [ ] 2.3 Add the `debug.request.deliver` effect using `AgentHost.submit(..., "followUp")` with idempotent request id; verify single delivery across an effect retry and artifact-only behavior when the caller ended.

## 3. Tools and guard

- [ ] 3.1 Add the four tools in `src/agent-host/tools.ts` (not offered to debug runs); verify tool lists.
- [ ] 3.2 Add the handoff guard and its message; verify handoff refusal with an open request and success after cancel.
- [ ] 3.3 Add the shared-worktree rule to `workflow-agent-protocol.md` and `debug.md`.

## 4. TUI

- [ ] 4.1 Add the `debug-requests` observation and the read-only dashboard section with report and filtered evidence; open the TUI and confirm footer and `?` help show only navigation/open keys.

## 5. Checks

- [ ] 5.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

# Tasks

## 1. Store and CLI

- [x] 1.1 Add the `debug_requests` table with migration and status transitions; verify migration and transition guards.
- [x] 1.2 Add CLI commands `debug-request`, `debug-result`, `debug-wait`, `debug-cancel` with limits and recursion refusal; verify each.

## 2. Execution and delivery

- [x] 2.1 Add the `debug.request.run` effect (role `debug`, caller cwd, shared owner, evidence subdir, baseline capture); verify the run is started once per request.
- [x] 2.2 Compute changed files since baseline at debug handoff and store them with the report; verify with a temp repository.
- [x] 2.3 Add the `debug.request.deliver` effect using `AgentHost.submit(..., "followUp")` with idempotent request id; verify single delivery across an effect retry and artifact-only behavior when the caller ended.

## 3. Tools and guard

- [x] 3.1 Add the four tools in `src/agent-host/tools.ts` (not offered to debug runs); verify tool lists.
- [x] 3.2 Add the handoff guard and its message; verify handoff refusal with an open request and success after cancel.
- [x] 3.3 Add the shared-worktree rule to `workflow-agent-protocol.md` and `debug.md`.

## 4. TUI

- [x] 4.1 Add the `debug-requests` observation and the read-only dashboard section with report and filtered evidence; assert the dialog's key surface (footer and `?` help) offers only navigation/open keys.

## 5. Checks

- [x] 5.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

## Verification notes

- 1.1 `debug-subagent-request.test.ts` ("the store carries the v6 debug request table and migrates
  a v5 store") covers the v5 -> v6 migration and the transition guards;
  `workflow-migration.test.ts` still covers every older baseline.
- 1.2 the CLI surface (subcommands, required flags, argv per tool) and the cancel ownership check
  are asserted in the same file.
- 2.1/2.2 "the lifecycle effect starts one run with a baseline, and the handoff finishes the
  request" drives the real effect runner and a stub adapter: one `run:<id>:launch` row per request,
  the recorded baseline, the report bytes at the request's report path and the touched-file report.
- 2.3 "a finished report is injected into the caller's conversation exactly once" puts a fake control
  socket behind the caller run and asserts the single submission (`debug:<requestId>`, `followUp`,
  summary + report path + evidence + changed files), then runs the effect a second time and asserts
  no second submission; "delivery stands down when the caller run has ended" covers the
  artifact-only path from the run's own lifecycle status.
- 3.1 `debugRequestToolNames`/`withoutDebugRequestTools` assert the four names and that a `debug`
  run's explicit selection withholds exactly those; each tool's argv is asserted against an
  `agentic-coding` shim.
- 3.2 the handoff guard is asserted on both caller lanes: `agent.handoff` (refused while the request
  is open, allowed after `debug-cancel`) and `agent.research-handoff`, whose reducer applies the same
  shared refusal.
- 3.3 `agent-definitions/instructions/{workflow-agent-protocol,debug}.md` carry the shared-worktree
  rule; the rendered debug assignment is asserted to contain the role brief, the goal and the rule.
- 4.1 the dashboard keybind catalog and the dialog's key surface are asserted in
  `debug-subagent-request.test.ts` ("the debug requests dialog offers navigation and opening only"),
  which enumerates every accepted key and every declared help entry; the TUI was not opened
  interactively in this round.
- Additional verifier-driven coverage: repair closes a retired run's open requests and keeps their
  lifecycle effects; an interrupted report rename converges on the next read; an unusable baseline is
  reported rather than silently listing a subset; the observation refuses a report path outside the
  workflow's own data directory.

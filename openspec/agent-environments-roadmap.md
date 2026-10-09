# Agent environments roadmap

Agents run apps through the environment manager (script, Docker compose or
kind). Each app runs **once at a time** with its static routing and ports.
Agents wait for apps held by others, and the developer gets a toast about each
wait and grant. On top of that, agents get a local headless browser with
screenshot/video evidence, debug tools (logs, OTel traces, DB, HTTP), a debug
agent (delegated sub-agent and standalone workflow), and an `env-setup`
workflow that authors environment definitions behind human approval.

Each change is sized for one implementation workflow; order follows
dependencies.

| # | Change | Depends on | Delivers |
| --- | --- | --- | --- |
| ✓ | `add-environment-instances` (archived) | — | Owner-scoped instances, state v8, owner checkout, `config_overlay`, Docker-first selection, reconcile. Its parallel parts are reverted by 1. |
| 1 | `make-app-runs-exclusive` | archived change | One slot per app, FIFO blocking wait, all-or-nothing multi-app + deadlock check, human runs as holders, force release, wait/grant toasts; removes ports allocator/`AC_PORT_*`/per-instance projects (state v9). |
| 2 | `add-environment-instance-lifecycle` | 1 | Workflow-bound release, idle TTL for agent-held apps. |
| 3 | `add-kubernetes-run-replicas` | 1 | Explicit opt-in kind runs under the app slot, `replicas`, cluster precondition. |
| 4 | `add-agent-environment-tools` | 1, 2 | Owner-scoped capability, `env_*` tools for every durable agent, blocking `env_start`, secret redaction. |
| 5 | `add-workflow-evidence-store` | — | Evidence files + manifest per workflow, `evidence` observation. |
| 6 | `add-agent-browser-sessions` | 4, 5 | Local headless Chromium pool, `browser_*` tools, Playwright script tool, screenshots/video as evidence. |
| 7 | `add-agent-debug-tools` | 1, 4 | OTel wiring attributed per slot grant, `otel_query`, `db_query`, `http_request`. |
| 8 | `add-dashboard-evidence-panel` | 5 | Dashboard evidence panel, kitty inline images, external open. |
| 9 | `show-environment-instances` | 1, 2 | Environments view: holders, waiters, force release. |
| 10 | `add-debug-workflow` | 4, 5, 6, 7 | `debug` role + standalone `debug` workflow with review gate. |
| 11 | `add-debug-subagent-requests` | 10 | `debug_request`/`debug_result`/`debug_wait`, injected results, handoff guard, read-only TUI view. |
| 12 | `add-environment-setup-workflow` | 1, 4, 7 | `env-setup` workflow: drafts, validation run, approval diff, atomic promote. |

Parallel tracks: 1→2→4→6/7 (runtime + tools), 5→8 (evidence UI), 1→3, 1→9.

Dropped with the switch to exclusive runs: `add-instance-infra-isolation`
(per-instance DB schemas, infra variables, app groups) and
`template-existing-environment-configs` (existing definitions stay static and
valid).

After 12 ships: run one `env-setup` pass per configured app to add OTel wiring
and, where the app offers one, a mock-auth profile. This is operational work,
not a change.

## Locked decisions

- One run per app across all owners; static routing and ports; the app runs
  from the holder's checkout. Runs of one workflow (including debug sub-agents)
  share its holds.
- Waiting: blocking `env_start` (long-poll, kept queue position, `still-waiting`
  on timeout), FIFO per app, all-or-nothing for multi-app requests, immediate
  `deadlock` on a hold/wait cycle.
- Human runs hold the app too; agents wait for the developer. A human start of
  an agent-held app is refused, naming the holder.
- Release: explicit `env_stop`, workflow close/delete, idle TTL (default 30 min,
  agent holders only), developer force release.
- Toasts: when a workflow starts waiting (app, waiter, holder) and when it gets
  the app; also when an idle app is reaped.
- DB data is kept as-is across holders; no per-run isolation.
- Default runtime order for agents: Docker compose → script. kind only on
  explicit request (concurrency/multi-replica checks).
- Definitions live in the global config dir; agent-authored ones only via
  `env-setup` drafts + human approval.
- Every durable agent gets env, browser and debug tools. Browser and HTTP tools
  only target apps the workflow holds.
- Browser: local headless Chromium per session; discrete tools + Playwright
  script tool. The agent decides when screenshots or video are worth keeping.
- Apps run with mock auth only; no credential handling.
- Debug sub-agent: async; result injected into the caller conversation; shares
  the caller worktree and holds; may edit code (convention-only conflict
  avoidance); report read-only in the TUI.
- Standalone debug workflow: own detached worktree on a chosen branch; waits for
  developer review.
- Evidence: TUI panel; kitty inline images; otherwise list + external open.

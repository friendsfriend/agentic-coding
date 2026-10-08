# Agent environments roadmap

Agents get isolated, low-load local environments (script / Docker compose /
kind), tools to build/start/inspect them, a local headless browser with
screenshot/video evidence, debug tools (logs, OTel traces, DB, HTTP), a debug
agent (delegated sub-agent and standalone workflow), and an `env-setup`
workflow that authors environment definitions behind human approval.

Each change is sized for one implementation workflow; order follows
dependencies.

| # | Change | Depends on | Delivers |
| --- | --- | --- | --- |
| 1 | `add-environment-instances` | — | Instance model (state v8), owners, template variables, port allocator, per-instance compose/script naming, start/stop/status API, Docker-first target choice. |
| 2 | `add-instance-infra-isolation` | 1 | Shared infra with per-instance DB schema provisioning, infra endpoint variables, per-owner app groups. |
| 3 | `add-environment-instance-lifecycle` | 1 | Workflow-bound teardown, idle TTL reaper, per-runtime caps, FIFO queue. |
| 4 | `add-kubernetes-environment-instances` | 1, 3 | Opt-in kind instances: namespace/release/port-forward/image tag per instance, kind cap. |
| 5 | `template-existing-environment-configs` | 1, 2 | `env migrate-templates` codemod over all existing defs, agent-use validator. |
| 6 | `add-agent-environment-tools` | 1, 3 | Owner-scoped capability, `env_*` tools for every durable agent, secret redaction. |
| 7 | `add-workflow-evidence-store` | — | Evidence files + manifest per workflow, `evidence` observation. |
| 8 | `add-agent-browser-sessions` | 6, 7 | Local headless Chromium pool, `browser_*` tools, Playwright script tool, screenshots/video as evidence. |
| 9 | `add-agent-debug-tools` | 2, 6 | OTel wiring per instance, `otel_query`, `db_query`, `http_request`. |
| 10 | `add-dashboard-evidence-panel` | 7 | Dashboard evidence panel, kitty inline images, external open. |
| 11 | `show-environment-instances` | 1, 3 | Environments view: instances per owner, ports, TTL, queue, stop. |
| 12 | `add-debug-workflow` | 6, 7, 8, 9 | `debug` role + standalone `debug` workflow with review gate. |
| 13 | `add-debug-subagent-requests` | 12 | `debug_request`/`debug_result`/`debug_wait`, injected results, handoff guard, read-only TUI view. |
| 14 | `add-environment-setup-workflow` | 1, 2, 5, 6 | `env-setup` workflow: drafts, validation run, approval diff, atomic promote. |

Parallel tracks: 1→2/3→4 (runtime), 7→10 (evidence UI), 6→8/9 (agent tools).

After 14 ships: run one `env-setup` pass per configured app to fill the
semantic parts the codemod (5) cannot (datasource schema variable, mock-auth
profile, OTel wiring). This is operational work, not a change.

## Locked decisions

- Per-workflow app instances; infrastructure containers shared; same-app
  instances get their own DB schema.
- Default runtime order for agents: Docker compose → script. kind only on
  explicit request (concurrency/multi-replica checks).
- Definitions live in the global config dir; agent-authored ones only via
  `env-setup` drafts + human approval.
- Every durable agent gets env, browser and debug tools.
- Browser: local headless Chromium per session; discrete tools + Playwright
  script tool. Agent decides when screenshots/video are worth keeping.
- Apps run with mock auth only; no credential handling.
- Lifecycle: workflow-bound + idle TTL (default 30 min); caps (6 instances,
  2 kind, 4 browsers) with FIFO queue.
- Debug sub-agent: async; result injected into the caller conversation;
  shares caller worktree and instances; may edit code (convention-only
  conflict avoidance); report read-only in the TUI.
- Standalone debug workflow: own worktree on a chosen branch; waits for
  developer review.
- Evidence: TUI panel; kitty inline images; otherwise list + external open.
- Unanswered default: an app-group binding with no same-owner instance falls
  back to the `user` instance.

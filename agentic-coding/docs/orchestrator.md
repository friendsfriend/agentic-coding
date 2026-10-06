# Home Orchestrator

Home → **Orchestrator** opens a chat with one persistent `pi-durable` agent
that discovers projects, presets and workflows, starts workflows, and manages
them. Plan approval, developer review, findings review and wiki review stay
with the developer; so do developer questions from workflow agents.

## Pieces

| Piece | Path | Owns |
| --- | --- | --- |
| Page | `src/tui/orchestrator/OrchestratorView.tsx` | The `orchestrator` route body: the shared `AgentSessionView` transcript, the `orchestrator.view` keymap field (`session` / `picker`), and `/new`. |
| Host bootstrap | `src/tui/orchestrator/session.ts` | One host under `<config root>/orchestrator/agent-host/` started with `agent host --orchestrator`, the active session name (`session.json`), the run env with the orchestrator capability, and the configured model. |
| Tools + prompt | `src/agent-host/orchestrator.ts` | `list_projects`, `list_workflow_types`, `list_agent_config`, `list_branches`, `list_workflows`, `workflow_status`, `start_workflow`, `workflow_action`, `drain_workflow`, and the orchestrator system prompt. |
| Capability | `src/server/auth.ts` `orchestratorTokenFor` | HMAC of the instance token. The server authenticates it as the `orchestrator` principal. |
| Policy | `src/server/orchestrator-policy.ts` | Route allowlist, action allowlist, human-review step set. Enforced in `src/server/app.ts` before any operation runs. |
| Model setting | `[agents.orchestrator] { model, thinking, monitor, limits }` | Settings → Agent Presets → Orchestrator session (`set-orchestrator` mutation) edits `model`/`thinking`/`monitor`; `limits` is file-only and shown read-only. `model`/`thinking` apply every time the page opens; `/model` and `/thinking` change only the live session. `monitor` (default `wake`) is read when the shell starts its workflow monitor. |
| Workflow monitor | `src/tui/orchestrator/monitor.ts` + `transitions.ts` | The shell-owned observer of the workflows the orchestrator started: event → debounced re-read → pure projection diff → notification and, in `wake` mode, one coalesced session note. |

## Monitoring

The orchestrator only learned about a workflow when the developer asked. The
shell now observes the workflows the orchestrator started for as long as the
shell runs, independent of whether the page is open:

- The server publishes `workflow.*` events; the monitor re-reads only the
  workflow an event names (debounced per workflow, so a streaming run is one
  read per window) and diffs the small projection `transitions.ts` owns. A
  `resync` gap re-reads the authoritative list of every repository the monitor
  has seen instead of trusting what it holds.
- Only `startedBy: "orchestrator"` workflows are observed — the monitor is the
  orchestrator's ears, not a second dashboard.
- The **first** observation of a workflow only establishes its baseline: a
  workflow already waiting at plan approval when the shell starts is the
  developer's situation, not news.
- A transition is a review step entered, a pending developer question, the
  workflow becoming `attention-required`, a newly failed effect, or completion.

What a transition does depends on `[agents.orchestrator] monitor`:

| Mode | Shell notification | Note to the active session |
| --- | --- | --- |
| `wake` (default) | yes, for review/question transitions | yes |
| `notify` | yes, for review/question transitions | no |
| `off` | no — nothing is observed at all | no |

Notes are submitted to the active session as `whenBusy: "followUp"` input:
transitions inside a 10 s window become one `[workflow-monitor]` note with one
line per transition, the session receives at most one note per minute, and
everything beyond that bound is merged into the next note. The host is ensured
on the first note, so a wake-up works without the page having been opened; a
note that cannot be delivered is dropped rather than retried, because the
workflow's state is still visible in the sidebar.

Notifications never depend on the session: a review waiting on the developer is
reported in both `wake` and `notify` mode.

## Launch limits

The orchestrator can start any number of workflows, and a misread request, a
retry loop in the model, or a wake-up it answers with "start another one" would
fan out without bound. `[agents.orchestrator] limits` is the ceiling the server
enforces regardless of what the session decides:

```toml
[agents.orchestrator.limits]
max_active = 3          # default 3
max_starts_per_day = 20 # default 20
```

Immediately before an orchestrator start, the server counts the
orchestrator-started workflows across every workflow target: those that are
neither `completed` nor `closed` against `max_active`, and those created in the
trailing 24 hours against `max_starts_per_day`. When a bound is reached the
start is refused with `409 orchestrator-limit`, and the refusal names the limit,
the current count and the workflows counted (`3 of 3 active workflows (a, b,
c)`), so the session can relay exactly why it was refused. Operator starts are
never limited or counted.

The ceiling is **user-level**: the server resolves it with no project overlay
(`loadConfigWithProvenance({ repositoryIndependent: true })`), so a checked-out
repository's `.pi` overlay cannot loosen its own guard, and the read-only
Settings row shows the value the server enforces rather than the selected
project's. The count reads the target registry plus the wiki and research
targets — the same set the sidebar reads — and is observational: an absent
store contributes nothing, a store that needs migration or cannot be opened is
counted as zero and named in the refusal as skipped, and the wiki and research
targets are one store file counted once. There is no queueing: a refused start
is simply not created.

The count is read immediately before `operations.start`, and the start commits
synchronously (the route never yields between counting and the instance row), so
a second concurrent start already sees the first. No new lock is taken; an
implementation that yielded between counting and committing could let two
starts pass at `max_active - 1`, an overshoot bounded by the parallelism and
accepted by design.

## Boundary

- The session's tools are exactly `read` plus the orchestrator tools: no
  `bash`, `write`, `edit` or codemode, so the capability in its run env is the
  only way it can act. The host process environment has the operator tokens
  (`AGENTIC_WORKFLOW_TOKEN`, `AGENTIC_DEVENV_TOKEN`) removed.
- Allowed routes: health, observe, workflow view/start/action/execute, agents
  config read, classifier status, events. Everything else is `403
  orchestrator-forbidden` (questions, review saves, repair, delete, config
  writes, agent handoffs, credentials, the environment and legacy surfaces).
- Allowed actions: `resume`, `retry-effect:*`, `switch-preset` anywhere;
  `close` and `create-pr` outside a review step. Every approval/rejection/
  review-comment action is refused, and nothing but recovery is allowed while
  the workflow sits on `core.plan-approval`, `core.developer-review`,
  `core.findings-review` or `core.wiki-approval`.
- Starts by the orchestrator pin the `planApproval`, `developerReview` and
  `wiki` gates to `always` (`withHumanReviewGates`), so the classifier can
  never skip a human review on its behalf. The flag is server-decided; the
  wire request cannot carry it.

## Not yet

Custom workflow graphs (blueprints compiled from registered steps) are a
follow-up: they need persisted custom definitions and trait-based step
behavior instead of definition-id checks. See the design notes in the
originating discussion.

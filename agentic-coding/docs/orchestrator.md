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
| Model setting | `[agents.orchestrator] { model, thinking }` | Settings → Agent Presets → Orchestrator model (`set-orchestrator` mutation). Applied every time the page opens; `/model` and `/thinking` change only the live session. |

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

## Why

Every time a single-role step (planner, worker, or archive) re-runs within the same workflow — e.g. after plan-review comments, developer-review comments, or a blocked/failed retry — the engine names the new Herdr agent after the freshly generated run ID. Because the agent-detection lookup used to reuse a still-running session is also keyed by that same run-scoped name, it can never find the previous run's agent, so it always falls through to launching a brand-new tab/pane instead of sending a follow-up prompt to the existing one. The spec (`herdr-workflow-prompting`) already requires follow-up prompts to target the detected agent; the naming scheme silently defeats that requirement.

## What Changes

- Derive the Herdr agent name for single-role, persistent steps (`core.plan` → planner, `core.implementation` → worker, `core.archive` → archive) from the stable `(changeId, role)` pair instead of the per-run ID, so the name is identical across every generation/attempt of that role within one workflow.
- Keep the existing per-run-unique naming for grouped, one-shot roles (triage and verifiers under `core.triage`/`core.verification`), preserving their documented shared-tab/split-pane placement and fresh-agent-per-round behavior.
- Update `herdr-workflow-prompting` to make explicit that follow-up-run detection depends on a stable agent identity for persistent roles, closing the gap that let the naming bug silently violate the existing "follow-up prompt targets detected agent" requirement.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `herdr-workflow-prompting`: clarify that persistent single-role steps (planner, worker, archive) must keep one stable Herdr agent identity across all of a role's runs in a workflow, so a later run reuses the detected agent via `herdr agent prompt` rather than launching a new one; grouped triage/verifier roles keep per-run identity.

## Impact

- Code: `agentic-coding/src/workflow/effect-runner.ts` (`runName`, used by the `agent.launch` effect's `observe`/`execute` handlers); `agentic-coding/src/workflow/runtime.ts` (`WorkflowEngine.activeRunForRole`) and `agentic-coding/src/workflow/cli.ts` (`resolveHandoffIdentity`) so `workflow handoff` resolves a reused agent's current run from its own stable `(workflowId, stepId, role)` identity and mints its capability fresh in-process, so the follow-up round can actually complete without ever persisting a bearer token to disk (see design.md addendum).
- Behavior: planner/worker/archive review-comment and blocked/failed retry cycles reuse the existing tab and pane, receive a follow-up prompt instead of spawning a new tab each cycle, and can hand off that follow-up round successfully.
- No change to grouped triage/verification tab/pane placement (`agentic-coding/src/workflow/cli.ts` `paneForRun`) or to the assignment/message content contract (`workflow-agent-assignment`).

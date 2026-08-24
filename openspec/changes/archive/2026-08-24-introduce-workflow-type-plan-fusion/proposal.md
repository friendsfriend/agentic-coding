## Why

Complex features currently get exactly one planning perspective before implementation: a single planner agent produces the OpenSpec proposal. A committee of independently generated plans, each produced by a different model, surfaces divergent approaches and blind spots early; consolidating them yields a stronger proposal than any single model's first pass.

## What Changes

- Introduce a new registered workflow type `plan-fusion` that prepends two steps ahead of the existing standard flow (`core.plan-approval` onward is unchanged):
  - **Fusion planning (fan-out)**: a single workflow step launches 2–5 planner runs in parallel, one per configured model. Every planner receives the same rendered objective/prompt (same instruction assets, same task text) and must produce a structured plan draft against a new pinned output schema (`core.plan-draft@1`) that enforces a defined output style (approach, file-level plan, risks, open questions).
  - **Plan fusion (consolidation)**: an agent step whose declared inputs are all validated planner drafts from the fan-out step; it merges them into one consolidated OpenSpec proposal by creating the normal openspec change artifacts, then hands off `complete`.
- Add configuration for the model list: a plan-fusion workflow start declares 2–5 routing profiles (one per planner run); the engine rejects fewer than 2 or more than 5 and refuses duplicate profiles.
- Register `plan-fusion` as a built-in workflow definition through the public registry contract, pinned and validated like `standard`, `direct-apply`, and `no-openspec`; existing workflows are unchanged.
- Add new step definitions and instruction assets for the two fusion steps (planner prompt-engineering asset and consolidator asset), delivered through the existing message-based assignment protocol.
- After consolidation, review and execution follow the normal flow unchanged: developer plan approval (with comment-driven revisions back into re-fanning or consolidation), implementation, verification triage, verification, developer review, archive, delivery.
- No breaking changes: existing workflows keep their identifiers, versions, graphs, and pins.

## Capabilities

### New Capabilities
- `workflow-plan-fusion`: The plan-fusion workflow type — parallel multi-model planning fan-out with a shared prompt-engineered structured draft schema, consolidated into a single OpenSpec proposal by a dedicated fusion step, followed by the standard approval and execution flow.

### Modified Capabilities
- `workflow-definition-registry`: Built-in workflow initialization now also registers the `plan-fusion` definition (and its new step definitions) through the same public registry contract with identical validation; the scenario enumerating built-in workflows gains `plan-fusion`.

## Impact

- **Code**: `agentic-coding/src/workflow/definitions.ts` (new steps + `plan-fusion` manifest), `agentic-coding/src/workflow/contracts.ts` or `registry.ts` (new `core.plan-draft@1` output contract and fan-out run semantics), `agentic-coding/src/workflow/profiles.ts` / `assignment.ts` (per-planner-role routing and multi-run launch for the fusion step), embedded instruction assets under `agent-definitions/instructions/` (regenerate `embedded.generated.ts` via build).
- **Configuration**: agents config gains the ability to express a 2–5 profile list for the fusion planning step (preset/route surface); dashboard/TUI step labels gain entries for the two new steps.
- **Dependencies**: none added.
- **Compatibility**: additive only; persisted workflows on existing definitions are untouched because definition pinning keys on identifier+version+digest.

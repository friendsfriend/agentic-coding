## Why

Planning agents sometimes encode the repository's complete test suite as an implementation task or required worker check. The implementation protocol intentionally limits workers to focused validation while the workflow-owned test-verifier runs the complete suite after implementation, so this conflicting plan guidance can create an impossible or deadlocking execution contract.

## What Changes

- Clarify planning instructions that plans and OpenSpec task checklists must assign only focused, change-relevant validation to the worker.
- Explicitly reserve the complete repository test suite for the automatically launched test-verifier, and prohibit planners from requiring workers to duplicate that run.
- Apply the same ownership rule to parallel planning and plan consolidation so fusion cannot reintroduce a full-suite worker requirement.
- Regenerate embedded workflow instruction assets and add regression coverage for the rendered planning assignments and the planner/test-verifier boundary.

## Capabilities

### New Capabilities

### Modified Capabilities

- `herdr-workflow-prompting`: planning and plan-fusion prompts must distinguish focused worker validation from the workflow-owned complete test-verifier run.

## Impact

The runtime-neutral planning instruction assets under `agent-definitions/instructions/` and their generated bundle under `agentic-coding/src/workflow/embedded.generated.ts` will change. Assignment rendering/asset-pin tests will gain coverage for the guidance; workflow execution, verifier scheduling, and the existing worker focused-test policy remain unchanged.

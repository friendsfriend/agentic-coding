## Why

Step entry and arrival behavior are registered, but completion decisions remain in generic handoff and effect-result reducers. Verification aggregation, fusion completion, planning validation, and delivery chaining require engine-side step identity branches, while built-in step reducers mostly return unchanged state.

## What Changes

- Place step-specific agent and effect completion decisions in the existing step behavior mechanism.
- Return declarative local state changes, transitions, run requests, and effects for the engine to validate and apply atomically.
- Retain capability authorization, evidence authentication, lease/revision enforcement, and SQL in the runtime.
- Remove redundant built-in completion plumbing after migrating callers; do not add a competing extension interface.
- Characterize verification first, then fusion, planning, and delivery before moving each behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-definition-registry`: Step-owned completion decisions and constrained engine application.

## Impact

- Priority: medium; architecture finding 5.
- Depends on `separate-workflow-observation-execution` so hooks receive validated evidence rather than importing I/O. Land after `version-workflow-behavior-pins` so exact-version resolution is used consistently.
- Code: `agentic-coding/src/workflow/steps/`, `runtime/reducers/agent-handoff.ts`, `runtime/reducers/effect-result.ts`, `runtime/kernel.ts`, and `definitions/steps.ts`.
- No intended graph, action, outcome, routing, evidence, or completion behavior changes. Existing semantic versions and digests must remain valid for equivalent behavior.

## Non-goals

No new plugin layer, command transport, generalized workflow DSL, or movement of authorization checks into step hooks.

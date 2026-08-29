## Why

Agents currently resolve ambiguous implementation decisions on their own, so verifier findings can conflict with the plan and force avoidable worker/verifier round trips. A first-class, developer-visible question flow lets an agent pause at the uncertainty, receive a recommended or custom answer, and makes that decision available to later agents (including security verification).

## What Changes

- Add an authenticated `developer_question` agent tool backed by the workflow engine, accepting a question description and bounded recommended options, with a custom-response path and cancellation/timeout behavior.
- Persist the question, selected/custom answer, requester identity, and ordered dialogue history in canonical workflow state and expose it through the workflow view and subsequent agent assignments.
- Render pending questions in the dash as a modal with selectable recommendations, custom text input, queue-safe response handling, and refresh/recovery behavior while the requesting agent remains blocked.
- Extend the managed-agent protocol so every role knows when and how to ask for clarification and treats prior developer dialogue as shared, untrusted decision context.
- Add focused runtime, tool/bridge, assignment, and dash renderer tests; retain type-check, build, lint, and strict OpenSpec validation as implementation gates.

## Capabilities

### New Capabilities

- `workflow-developer-question`: Authenticated agent-to-developer questions, durable shared dialogue, and dash response interaction.

### Modified Capabilities

- `openspec/specs/workflow-engine-runtime/spec.md`: Extend the engine command/state contract for authenticated question requests and developer answers.
- `openspec/specs/herdr-workflow-prompting/spec.md`: Make the question tool discoverable to managed roles and include prior dialogue in future assignments.

## Impact

The change affects the workflow command contracts and transactional runtime, workflow-view/assignment projection, embedded managed-agent assets and runtime adapter wiring, the dash data refresh and modal/keymap stack, and focused workflow/TUI tests. It should not add a dependency; the existing Bun SQLite store, OpenTUI modal primitives, and configured agent runtime bridges remain the transport and rendering foundations.

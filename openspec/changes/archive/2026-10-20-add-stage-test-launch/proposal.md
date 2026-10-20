## Why

After phase 3 (`add-stage-test-workflow`) a stage test can only be started from the CLI. The developer's intended interaction is "paste the ticket text, pick a stage, get a report" from the dashboard or by telling the Home Orchestrator. Today the dashboard starts repository-independent work from Wiki (`openspec/specs/contextual-workflow-launch/spec.md`, "Independent work starts from Wiki") and the orchestrator starts workflows through `start_workflow` with the developer-established repository, task, type, branch, ticket and app (`agentic-coding/docs/orchestrator.md`, "Before starting a workflow"); neither knows a stage.

## What Changes

- The independent-work creation form (Wiki destination) offers **Stage test** with a stage picker listing allow-listed stages (environment and access marker shown, excluded stages not selectable), a multi-line ticket text field (the task) and an optional ticket reference.
- The orchestrator's `start_workflow` accepts `stage` for the `stage-test` workflow type, refuses an unknown stage with the server's `stage-not-configured`, and the orchestrator guidance requires the developer to establish the stage (or confirm the only stage of a system) before starting.
- **Ticket-reference seam:** the ticket reference is stored as the existing `ticket` metadata and shown in the report; a later ticket-system integration may resolve a reference into the task text. Resolving references is out of scope.

## Capabilities

### New Capabilities

- `stage-test-launch`: dashboard and orchestrator starts of a stage test with stage selection, ticket text and an optional ticket reference.

### Modified Capabilities

(none — the existing launch and orchestrator requirements stay valid; this change adds a new workflow type to them)

## Impact

- Dashboard independent-work creation form (`src/tui/dash/`), its keybind catalog if a key is added.
- Orchestrator tool parameters and guidance (`src/agent-host/orchestrator.ts`, `docs/orchestrator.md`).
- Depends on `add-stage-test-workflow`. No server schema change; the start route already validates `stage` from phase 3.

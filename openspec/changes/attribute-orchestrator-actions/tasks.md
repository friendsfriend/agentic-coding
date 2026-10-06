# Tasks

## 1. Engine attribution

- [ ] 1.1 Add optional `startedBy` to `WorkflowMetadata`, the snapshot schema, `WorkflowView` and `WorkflowOverview` (defaulting to `developer` on read). Verify decode tests with and without the field.
- [ ] 1.2 Pin `startedBy` at start from a server-decided start option; record `principal: "orchestrator"` on developer-action events from a server-decided action option. Verify with engine tests that operator actors are byte-identical to today.

## 2. Transport and presentation

- [ ] 2.1 Pass the principal from `app.ts` into start and action operations. Verify with transport tests for both principals and that a wire `startedBy` is rejected.
- [ ] 2.2 Return `startedBy` from `list_workflows` and `workflow_status`; mark orchestrator-started rows in the workspace sidebar. Verify the sidebar model test and in the TUI.
- [ ] 2.3 Run `bun run lint`, `bun run type-check` and the focused suites.

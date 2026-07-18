## 1. Workflow override control

- [x] 1.1 Add one canonical operational-phase allowlist and `override-phase` CLI command in `pi/bin/herdr-workflow`.
- [x] 1.2 Persist only selected phase/timestamp through existing state writer and emit source/target override telemetry; reject unknown and `closed` targets before mutation.

## 2. Recovery plan contract

- [x] 2.1 Create per-run recovery identifier/context and clear stale recovery plan before launching recovery agent.
- [x] 2.2 Update recovery prompt and skill to write run-bound JSON to exact artifact path, never emit plan JSON as chat output.
- [x] 2.3 Validate recovery plan identifier, schema, role, and current-phase compatibility before dashboard display or `apply-recovery` dispatch.

## 3. Dashboard control

- [x] 3.1 Add `Shift+O` phase picker and explicit overwrite confirmation modal.
- [x] 3.2 Invoke override CLI, refresh state/result feedback, and expose keybinding in help/footer.
- [x] 3.3 Hide stale or invalid recovery plans using current recovery identifier.

## 4. Validation

- [x] 4.1 Add focused regression checks for phase override and recovery artifact validation.
- [x] 4.2 Run workflow regression script, `cd agent-dash && bun run type-check`, and `openspec validate manual-workflow-state-overwrite --strict`.

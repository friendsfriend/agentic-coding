## Why

The workflow today is a flat phase machine with hardcoded transitions. All workflows start at `explore` and proceed through every phase. There is no way to skip planning when the proposal is already designed.

## What Changes

Reframe workflow lifecycle into standalone **modules** that compose into **workflow types**. Each module owns a set of phases, its entry, its exit, roles to launch, and whether a dashboard approval gate precedes the exit.

### Modules

| Module | Entry | Exit | Roles | Gate | Internal phases |
|---|---|---|---|---|---|
| plan | explore | proposed | planner | — | explore |
| plan-approval | proposed | apply | — | ✅ dashboard approve | proposed |
| apply-verify | apply | developer-review | worker, verifiers | — | apply, verify, fix, paused, triage |
| developer-approval | developer-review | archive | — | ✅ dashboard approve | developer-review |
| archive | archive | completed | archive | — | archive |

Modules are reusable. A workflow type is an ordered list of modules.

### Workflow types

- **standard**: `plan → plan-approval → apply-verify → developer-approval → archive`
- **direct-apply**: `apply-verify → developer-approval → archive`

Direct-apply skips planning entirely. Proposal/design/tasks/specs must pre-exist.

### What stays

- The apply-verify internal loop (apply → verify → fix → paused → verify) is unchanged
- Dashboard approval gates at plan-approval and developer-approval modules are unchanged
- Override-phase, recovery, close commands are unchanged
- Standard workflow module list produces identical behavior to today

## Impact

- `pi/bin/herdr-workflow`: module registry, state stores module list, transitions derived from modules, `start` uses module list for entry phase and roles, `apply/phase/archive` commands use module-aware guards
- `agent-dash/src/data.ts`: `WorkflowState` adds `workflowModules`, `approvalFor` derived from module gates, `startWorkflow` passes module list
- `agent-dash/src/ui/NewWorkflowModal.tsx`: workflow type selection chooses module composition
- `agent-dash/src/App.tsx` / `Home.tsx`: module info in rendering

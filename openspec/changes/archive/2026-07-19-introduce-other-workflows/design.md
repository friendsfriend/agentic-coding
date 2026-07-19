# Design: introduce-other-workflows

## Scope

Replace the hardcoded flat phase machine with a module-based composition system. Each workflow type is an ordered list of modules. Modules define entry/exit, roles, internal phases, and whether a dashboard gate precedes the exit. Direct-apply is the first secondary workflow type.

## Module registry

Defined in `pi/bin/herdr-workflow`:

```python
WORKFLOW_MODULES = {
    "plan": {
        "entry": "explore",
        "exit": "proposed",
        "roles": ["planner"],
        "gate": False,
        "phases": {"explore"},
    },
    "plan-approval": {
        "entry": "proposed",
        "exit": "apply",
        "roles": [],
        "gate": True,
        "phases": {"proposed"},
    },
    "apply-verify": {
        "entry": "apply",
        "exit": "developer-review",
        "roles": ["worker"],
        "gate": False,
        "phases": {"apply", "verify", "fix", "paused", "triage"},
    },
    "developer-approval": {
        "entry": "developer-review",
        "exit": "archive",
        "roles": [],
        "gate": True,
        "phases": {"developer-review"},
    },
    "archive": {
        "entry": "archive",
        "exit": "completed",
        "roles": ["archive"],
        "gate": False,
        "phases": {"archive"},
    },
}

WORKFLOW_TYPES = {
    "standard": ["plan", "plan-approval", "apply-verify", "developer-approval", "archive"],
    "direct-apply": ["apply-verify", "developer-approval", "archive"],
}
```

Closed is not a module phase — it is owned by `cmd_close`.

## State

New fields in `state.json`:

```json
{
  "workflowModules": ["apply-verify", "developer-approval", "archive"],
  ...
}
```

Absent (legacy workflows) treated as `["plan", "plan-approval", "apply-verify", "developer-approval", "archive"]` for backward compatibility.

## Transition derivation

Allowed transitions built from module list + within-module internal phases:

- For each module, internal transitions between its `phases` are allowed (within same module)
- From a module's `exit` phase, transition to the next module's `entry` phase is allowed
- Exception: when a module has `gate: True`, the exit transition is NOT done via `cmd_phase` but via a dedicated command (`cmd_apply` for plan-approval, `cmd_archive` for developer-approval)

Internal transitions within apply-verify:
```
apply → verify
verify → fix
fix → verify
verify → paused
paused → fix
paused → verify
```
This matches current behavior. The exit from apply-verify (`verify → developer-review`) only happens when all verifiers pass.

## CLI changes

### `start` command

Add `--workflow-type` argument (default `"standard"`):

```
herdr-workflow start --workflow-type (standard|direct-apply) ...
```

In `cmd_start`:
- Look up module list from `WORKFLOW_TYPES[args.workflow_type]`
- First module's `entry` phase = initial phase
- First module's `roles` = agents to launch at start
- Save `workflowModules` in state
- Standard: phase="explore", launch planner (unchanged)
- Direct-apply: phase="apply", launch worker directly (skip planner)

### `cmd_phase` guard

Instead of hardcoded `allowed` dict, derive from modules:

```python
def allowed_transitions(state):
    modules = resolve_modules(state)
    allowed = {}
    for i, name in enumerate(modules):
        module = WORKFLOW_MODULES[name]
        for phase in module["phases"]:
            allowed.setdefault(phase, set())
        # Internal transitions within the module
        # (defined by each module's internal flow)
        if name == "apply-verify":
            allowed["apply"].add("verify")
            allowed["verify"].update({"fix", "paused"})
            allowed["fix"].add("verify")
            allowed["paused"].update({"fix", "verify"})
        # Exit to next module
        if i + 1 < len(modules):
            next_entry = WORKFLOW_MODULES[modules[i + 1]]["entry"]
            if not module["gate"]:
                allowed[module["exit"]].add(next_entry)
    return allowed
```

The module list is static per workflow, so transitions are deterministic.

### `cmd_apply` guard

For standard: must be in `proposed` phase (gate module). Check `state["phase"] == "proposed"` — unchanged.

For direct-apply: never called (phase is already `apply`, no gate module before it).

## Plan quality gate

Only runs in standard workflow when transitioning from explore → proposed. For direct-apply, the module list has no `plan` module, so plan quality is never called.

## Dashboard

### data.ts

`WorkflowState` adds `workflowModules?: string[]`.

`approvalFor()` derived from modules instead of hardcoded map:

```typescript
export function approvalFor(state: WorkflowState) {
  const modules = state.workflowModules ?? defaultModules;
  const idx = modules.findIndex(m => WORKFLOW_MODULES[m]?.phases.has(state.phase));
  if (idx < 0) return undefined;
  const module = WORKFLOW_MODULES[modules[idx]!]!;
  if (!module.gate) return undefined;
  const nextModule = modules[idx + 1];
  if (!nextModule) return undefined;
  return {
    prompt: `Press Enter to approve ${module.exit}`,
    action: module.exit === 'apply' ? 'apply' : module.exit === 'archive' ? 'archive' : 'phase',
  };
}
```

Actually — keep it simpler. The current `approvalFor` already maps phases to actions. Just update it to handle the modular phases. Or better: expose `WORKFLOW_MODULES` to the dashboard.

For now, `approvalFor` stays mostly the same (proposed → apply, developer-review → archive, completed → close are the same gates). The only change is that direct-apply won't show a gate at apply (since worker already running) — this already works because `apply` isn't in the current `approvalFor`.

`startWorkflow` adds workflow type parameter:

```typescript
export async function startWorkflow(input: { ...; workflowType: string }) {
  const args = ['herdr-workflow', 'start', '--workflow-type', input.workflowType, ...];
}
```

### NewWorkflowModal

Add workflow type selection step with two options: "standard" (default) and "direct-apply".

### App.tsx

Show module names / workflow type in change panel.

### Home.tsx

Show workflow type badge in workspace list.

## Backward compatibility

Workflows without `workflowModules` default to standard module list. No existing workflow breaks.

## Validation

- `herdr-workflow start --workflow-type direct-apply`: state has `workflowModules: ["apply-verify", "developer-approval", "archive"]`, phase `"apply"`, worker running, planner absent
- `herdr-workflow start` (default): state has `workflowModules: ["plan", "plan-approval", "apply-verify", "developer-approval", "archive"]` or absent, phase `"explore"`, planner running
- Allowed transitions match current behavior for both types
- Dashboard shows correct agents, gates, and module info
- Existing legacy workflows (no workflowModules) render identically

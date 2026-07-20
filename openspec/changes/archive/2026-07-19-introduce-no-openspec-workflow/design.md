# Design: introduce-no-openspec-workflow

## Scope

Add a new `no-openspec` workflow type that requires zero OpenSpec artifacts. Split the existing `archive` module into `git-operations` (commit/push) and `archive` (cleanup) for all workflow types.

## Module registry

New module in `pi/bin/herdr-workflow`:

```python
WORKFLOW_MODULES = {
    # ... existing modules unchanged ...
    "git-operations": {
        "entry": "committing",
        "exit": "archive",
        "roles": ["git"],
        "gate": False,
        "phases": {"committing"},
    },
    "archive": {
        "entry": "archive",
        "exit": "completed",
        "roles": ["archive"],
        "gate": False,
        "phases": {"archive"},
    },
}
```

Updated `WORKFLOW_TYPES`:

```python
WORKFLOW_TYPES = {
    "standard": ["plan", "plan-approval", "apply-verify", "developer-approval", "git-operations", "archive"],
    "direct-apply": ["apply-verify", "developer-approval", "git-operations", "archive"],
    "no-openspec": ["apply-verify", "developer-approval", "git-operations", "archive"],
}
```

## State

New fields in `state.json`:

```json
{
  "workflowModules": ["apply-verify", "developer-approval", "git-operations", "archive"],
  "workflowType": "no-openspec",
  ...
}
```

`workflowType` is the key into `WORKFLOW_TYPES`. Serialized at `start` time. Displayed in dashboard. Absent means `"standard"` for backward compatibility.

## Transition derivation

The `allowed_transitions` function already derives transitions from modules and the `apply-verify` internal loop. The only change: the `developer-approval` gate's exit changes from `archive` → `committing` (entry of git-operations instead of archive).

The `git-operations` module has `phases: {"committing"}` and `exit: "archive"`. Since `gate: False`, `committing → archive` is derived automatically.

Internal transitions for `apply-verify` are unchanged.

## CLI changes

### `start` command

`--workflow-type` now accepts `"standard"`, `"direct-apply"`, or `"no-openspec"`:

```python
start.add_argument("--workflow-type", choices=tuple(WORKFLOW_TYPES.keys()), default="standard")
```

For `no-openspec`:
- Initial phase = first module's entry = `apply`
- Initial roles = first module's roles = `["worker"]`
- Worker launched immediately (like direct-apply)
- State stores `workflowType: "no-openspec"`

### Worker prompt dispatch

`role_prompt("worker", ...)` checks `state.get("workflowType")`:

- For `no-openspec`: return prompt that reads `request.md` rather than OpenSpec tasks
- For standard/direct-apply: current prompt (reads OpenSpec tasks)

```python
if role == "worker":
    if state.get("workflowType") == "no-openspec":
        return f"Silent worker for {change}. Read .herdr-workflow/{change}/request.md which describes the change. Apply it silently based on the user's description. No task checklist to read — signal completion when done. No chat output."
    return f"Silent worker for {change}. Follow loaded skill. Apply plan silently. Mark each OpenSpec task [x] only after its focused validation; verification rejects unfinished tasks. No chat output."
```

### `cmd_verify` guard

```python
def cmd_verify(args):
    state = load_state(args.repo, args.change)
    if state.get("workflowType") != "no-openspec":
        ensure_tasks_complete(state)  # only for standard/direct-apply
    ...
```

### `cmd_git_operations` (new)

Replaces part of `cmd_archive`. New command for the `git-operations` module:

```python
def cmd_git_operations(args):
    state = load_state(args.repo, args.change)
    if state["phase"] != "committing":
        raise SystemExit(f"git operations requires committing phase, found {state['phase']}")
    ensure_workflow_branch(state)
    # Close non-essential panes (planner, triage, worker, verifiers)
    for role in ("planner", "triage", "worker", *VERIFIER_ROLES, TEST_VERIFIER):
        pane = state["panes"].get(role)
        if pane:
            try: herdr("pane", "close", pane)
            except SystemExit: pass
    # Create git tab and launch git agent
    pane = create_tab(state["workspace"], "git-ops", "git", state["changeId"])
    state["panes"]["git"] = pane  # or a separate "git-ops" pane key
    try:
        launch_role(state, "git")
    except SystemExit:
        try: herdr("pane", "close", pane)
        except SystemExit: pass
        raise
    write_git_context(state)
    prompt_role(state, "git")
    set_phase(state, "committing")
    state["developerApproval"] = True
    save_state(state)
    print("git operations started")
```

Keep `cmd_archive` as a lighter version that only closes remaining panes, finalizes trace, and moves to completed.

### `cmd_archive` (simplified)

No longer stages/commits/pushes. Just finalize and close:

```python
def cmd_archive(args):
    state = load_state(args.repo, args.change)
    if state["phase"] != "archive":
        raise SystemExit(f"archive requires archive phase, found {state['phase']}")
    # Just cleanup — git already committed and pushed
    for role in ("git",):
        pane = state["panes"].get(role)
        if pane:
            try: herdr("pane", "close", pane)
            except SystemExit: pass
    finalize_workspace_trace(state)
    set_phase(state, "completed")
    save_state(state)
    print("archive complete")
```

### Module gate transitions

The `developer-approval` module's exit phase is `archive` in the module definition. But with the split, after gate approval the transition should go to `committing` (entry of git-operations). Two options:

1. Change `developer-approval` exit to `committing` so the gate transitions to the right place.
2. Keep it as `archive` and handle the mapping in the approval command.

Option 1 is cleaner: update `developer-approval`:

```python
"developer-approval": {
    "entry": "developer-review",
    "exit": "committing",  # was "archive"
    "roles": [],
    "gate": True,
    "phases": {"developer-review"},
},
```

And in `cmd_archive` → rename approval logic to point to `cmd_git_operations`.

The `approvalFor` in the dashboard derives the action from the gate module's exit. For `developer-approval` with `exit: "committing"`, the action becomes... hmm, `committing` isn't one of the known commands. We need a way to map module exit phase to a CLI command.

Simplest approach: keep the dashboard `approvalFor` unchanged (maps `developer-review` → `archive`), but `cmd_archive` now acts as the entry point that detects the workflow type and delegates:

```python
def cmd_archive(args):
    state = load_state(args.repo, args.change)
    if state["phase"] != "developer-review":
        raise SystemExit(...)
    # Developer approved — check workflow type
    modules = resolve_modules(state)
    next_idx = modules.index("developer-approval") + 1 if "developer-approval" in modules else -1
    if next_idx >= 0 and modules[next_idx] == "git-operations":
        # Redirect to git operations
        set_phase(state, "committing")
        save_state(state)
        cmd_git_operations(args)
        return
    # Legacy: direct to archive
    ...
```

Actually this is getting tangled. Let me simplify.

Better approach: the dashboard `approvalFor` already returns `{ action: "archive" }` for `developer-review`. The `runWorkflow("archive", ...)` call in App.tsx invokes `herdr-workflow archive`. In `cmd_archive`, we check what the next module is and route accordingly:

```python
def cmd_archive(args):
    state = load_state(args.repo, args.change)
    if state["phase"] not in {"developer-review", "committing", "archive"}:
        raise SystemExit(...)
    if state["phase"] == "developer-review":
        # Developer approval gate — determine next module
        modules = resolve_modules(state)
        mod_idx = next(i for i, m in enumerate(modules) if WORKFLOW_MODULES[m]["entry"] == state["phase"] or (i > 0 and WORKFLOW_MODULES[modules[i-1]]["exit"] == "committing"))
        # Actually, simpler: check if git-operations is in the module list
        if "git-operations" in modules:
            # Start git operations
            set_phase(state, "committing")
            save_state(state)
            cmd_git_operations(args)
            return
    # Archive phase: final cleanup
    ...
```

Actually let me step back. The simplest design:

1. Developer approves in dashboard → runs `herdr-workflow archive` (current behavior)
2. `cmd_archive` checks: does this workflow have `git-operations` module?
   - Yes: transition to `committing`, start git agent, stop
   - No (legacy): continue with old archive behavior
3. Git agent does its work, then runs `herdr-workflow phase ... archive` to transition to archive
4. Developer (or agent) runs `herdr-workflow archive` again, now in `archive` phase → does final cleanup

This is backward-compatible and keeps the dashboard approval flow unchanged.

Let me refine:

```python
def cmd_archive(args):
    state = load_state(args.repo, args.change)
    modules = resolve_modules(state)
    has_git_ops = "git-operations" in modules
    
    if state["phase"] == "developer-review":
        # Developer approval gate — route to git-operations if split
        if has_git_ops:
            # Close non-essential panes (skip git/dashboard/archive)
            for role in ("planner", "triage", "worker", *VERIFIER_ROLES, TEST_VERIFIER):
                pane = state["panes"].get(role)
                if pane:
                    try: herdr("pane", "close", pane)
                    except SystemExit: pass
            pane = create_tab(state["workspace"], "git-ops", "git", state["changeId"])
            state["panes"]["git"] = pane
            try:
                launch_role(state, "git")
            except SystemExit:
                try: herdr("pane", "close", pane)
                except SystemExit: pass
                raise
            write_git_context(state)
            prompt_role(state, "git")
            set_phase(state, "committing")
            state["developerApproval"] = True
            save_state(state)
            print("git operations started")
            return
        # No git-operations — legacy behavior
        ...
    
    if state["phase"] == "committing":
        raise SystemExit("git operations in progress; wait for completion")
    
    if state["phase"] == "archive":
        # Final cleanup
        ...
```

For the git agent completion: the git agent runs preflight, stages, commits, pushes, then runs `herdr-workflow phase --repo ... archive`. Then `cmd_phase` transitions from `committing` → `archive`.

Then the archive phase does final cleanup and transitions to `completed`.

## Git context

New function to write git context:

```python
def write_git_context(state):
    results = {role: result.get("verdict") for role, result in state.get("verificationResults", {}).items()}
    path = workflow_dir(state) / "reviews" / "git-context.md"
    path.write_text(f"# Git operations\n\nChange: {state['changeId']}\nBranch: {state['branch']}\nTicket: {state.get('ticketNumber') or '(none)'}\nVerification: {json.dumps(results)}\n\nRun preflight, stage implementation changes, commit, and push.\n")
```

## New git skill

Agent skill for git operations:

```
# Herdr OpenSpec Git

Developer approval exists. You are here to commit and push.

1. Read `.herdr-workflow/$HERDR_CHANGE_ID/reviews/git-context.md` for change, branch, ticket, and verdict.
2. Run branch preflight:
   herdr-workflow preflight-archive --repo "$PWD" --change "$HERDR_CHANGE_ID"
3. Stage all implementation changes.
4. Create one descriptive commit prefixed with ticket identifier when available.
5. Push current feature branch to origin with upstream.
6. On success, run:
   herdr-workflow phase --repo "$PWD" --change "$HERDR_CHANGE_ID" archive
```

## Simplified archive skill

Remove git steps from archive skill. Archive agent now only confirms artifacts and signals completion.

## Dashboard

### data.ts

`approvalFor` unchanged — maps `developer-review` → `{ action: "archive" }`. The `cmd_archive` now routes to git-operations when applicable.

`WorkflowState` adds `workflowType?: string`.

`listWorkflows` and `loadDashboard` use `workflowType` for display.

### NewWorkflowModal

Add `"no-openspec"` to workflow type choices. The choices array becomes:

```typescript
const choices = step() === 5 ? ['standard', 'direct-apply', 'no-openspec'].filter(...) : ...
```

### App.tsx / Home.tsx

Replace module-list heuristics with explicit `workflowType` display.

## Backward compatibility

- Existing state.json without `workflowType` → treated as `"standard"`
- Existing state.json without `workflowModules` → treated as standard module list
- Existing workflows with old `archive` module continue to work (cmd_archive detects legacy path)
- The `git-operations` module only appears in NEW workflows

## Validation

1. `herdr-workflow start --workflow-type no-openspec`: state has `workflowType: "no-openspec"`, phase `"apply"`, worker running
2. Worker prompt references `request.md`, not OpenSpec tasks
3. `herdr-workflow verify` skips task completion check for no-openspec
4. Dashboard approval routes to git-operations after developer-review
5. Git agent commits, pushes, transitions to archive
6. Archive agent finalizes, transitions to completed
7. Standard/direct-apply still produce archive with spec sync + git ops
8. Legacy workflows (no workflowModules) render identically

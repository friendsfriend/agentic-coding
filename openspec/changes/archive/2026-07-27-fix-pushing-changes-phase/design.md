# Design: Fix stuck committing phase

## Files changed

| File | Change |
|------|--------|
| `pi/lib/herdr_workflow/state.py` | Atomic `save_state` via `.tmp` + `rename` |
| `pi/lib/herdr_workflow/commands.py` | Fix rollback in `_start_git_operations`; protect `cmd_archive` committing path |
| `agent-dash/src/data.ts` | Add `approvalFor` entries for "archive" and "committing" |

## 1. Atomic save_state

### Before
```python
path.write_text(json.dumps(state, indent=2) + "\n")
```

### After
```python
tmp = path.with_suffix(".tmp")
tmp.write_text(json.dumps(state, indent=2) + "\n")
tmp.rename(path)
```

`Path.rename()` is atomic on POSIX when source and destination are on the same filesystem. Writing to `.tmp` first ensures the target file is never partially written.

## 2. Fix rollback in _start_git_operations

### Before
```python
except (SystemExit, Exception) as error:
    state_mod.set_phase(state, previous_phase)
    ...
    state_mod.save_state(state)
    ...
```

### After
```python
except (SystemExit, Exception) as error:
    # Don't roll back if _complete_git_operations already succeeded
    if state["phase"] == "completed":
        telemetry(ctx, state, "git_operations_rollback_skipped", ...)
    else:
        state_mod.set_phase(state, previous_phase)
        ...
        state_mod.save_state(state)
        ...
```

## 3. cmd_archive committing path

### Before
```python
if state["phase"] == "committing":
    _complete_git_operations(ctx, state)
    print("archive complete")
    return
```

### After
```python
if state["phase"] == "committing":
    try:
        _complete_git_operations(ctx, state)
    except SystemExit as error:
        # Already committed/pushed but tree check failed — transition anyway
        if "working tree is dirty" in str(error):
            raise
        change_phase(ctx, state, "completed")
    print("archive complete")
    return
```

## 4. Dashboard approvalFor

### Before
```ts
export function approvalFor(phase: string) {
  return ({
    proposed: { prompt: "Press Enter to approve apply", action: "apply" },
    fix: { prompt: "Press Enter to retry verification", action: "verify" },
    paused: { prompt: "Press Enter to resume verification", action: "verify" },
    "developer-review": { prompt: "Press Enter to review changed files", action: "review" },
    completed: { prompt: "Press Enter to close Herdr workspace", action: "close" },
  } as Record<string, { prompt: string; action: string }>)[phase];
}
```

### After
```ts
export function approvalFor(phase: string) {
  return ({
    proposed: { prompt: "Press Enter to approve apply", action: "apply" },
    fix: { prompt: "Press Enter to retry verification", action: "verify" },
    paused: { prompt: "Press Enter to resume verification", action: "verify" },
    "developer-review": { prompt: "Press Enter to review changed files", action: "review" },
    archive: { prompt: "Press Enter to advance archive", action: "archive" },
    committing: { prompt: "Press Enter to complete committing", action: "archive" },
    completed: { prompt: "Press Enter to close Herdr workspace", action: "close" },
  } as Record<string, { prompt: string; action: string }>)[phase];
}
```

Both "archive" and "committing" route to `runWorkflow("archive", ...)` which calls `cmd_archive`. This handles both phases correctly.

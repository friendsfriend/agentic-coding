## Context

`herdr-workflow` is a single-file Python state machine plus a set of role skill documents. The three workflow types share the `apply-verify` module, so a defect in the verifier completion contract or the worker path affects all of them. The audit traced each route phase-by-phase; the four fixes below are the minimal root-cause changes.

## Root-cause fixes (not symptom patches)

### Bug 1 — verifier `--verdict` flag

`cmd_verification_result` already derives the verdict from the JSONL findings file:

```python
verdict_event = next((event for event in reversed(events) if event.get("type") == "verdict"), None)
```

The verdict flag in the skills is dead input that argparse rejects. Root cause lives in the six skill documents, not the CLI. Fix = delete `--verdict <PASS|FAIL>` from every verifier skill's completion example. No CLI change; adding a tolerated `--verdict` flag would be redundant state (verdict already in the file) and invite drift. One shared command, differing only by `--role`.

### Bug 2 — `ensure_clean` couples two checks

```python
def ensure_clean(repo):
    if run("git", "status", "--porcelain", cwd=repo):
        raise SystemExit("working tree is dirty; commit or clean it first")
    if not (Path(repo) / "openspec" / "config.yaml").exists():
        raise SystemExit(f"OpenSpec project not found: {repo}/openspec/config.yaml")
```

The clean-tree check is universal; the OpenSpec check is type-specific. Add a parameter so the OpenSpec check is skippable, and pass the workflow type from `cmd_start`:

```python
def ensure_clean(repo, require_openspec=True):
    if run("git", "status", "--porcelain", cwd=repo):
        raise SystemExit("working tree is dirty; commit or clean it first")
    if require_openspec and not (Path(repo) / "openspec" / "config.yaml").exists():
        raise SystemExit(f"OpenSpec project not found: {repo}/openspec/config.yaml")
```

In `cmd_start`: `ensure_clean(source, require_openspec=args.workflow_type != "no-openspec")`. Default keeps every other caller unchanged.

### Bug 3 — worker skill hardcodes tasks.md

The worker skill is loaded for all three types. Scope its checkbox steps to "when `openspec/changes/<change>/tasks.md` exists (standard/direct-apply)", and add one line for the no-openspec case (implement from `request.md`, no checkboxes). No second skill file — fewest files.

### Bug 4 — no-openspec worker prompt omits the verify command

`role_prompt`'s no-openspec branch already special-cases the prompt text; append the exact command:

```
... signal completion by running `herdr-workflow verify --repo . --change {change}` once the change is applied. No chat output.
```

### Bug 5 — archive must run before git so the OpenSpec archive move is committed

Archiving an OpenSpec change is a file mutation (`openspec archive` moves `openspec/changes/<change>/` → `openspec/changes/archive/`). The current order commits/pushes first, then archives, so the move is never in the pushed commit — and today no role runs `openspec archive` at all. Root cause is the module order, not the skills alone.

Reorder to `... developer-approval → archive → git-operations`:

```python
"archive":        {"entry": "archive",    "exit": "committing", "roles": ["archive"], "gate": False, "phases": {"archive"}},
"git-operations": {"entry": "committing", "exit": "completed",  "roles": ["git"],     "gate": False, "phases": {"committing"}},

WORKFLOW_TYPES = {
    "standard":     ["plan", "plan-approval", "apply-verify", "developer-approval", "archive", "git-operations"],
    "direct-apply": ["apply-verify", "developer-approval", "archive", "git-operations"],
    "no-openspec":  ["apply-verify", "developer-approval", "archive", "git-operations"],
}
```

Phase flow: `developer-review → archive → committing → completed`. `allowed_transitions` regenerates from the module list, so the reordered list yields `archive → committing` and `committing → completed` automatically — verify this in the self-check rather than hardcoding.

Responsibilities after reorder:

- **Archive role** (runs first, in `archive` phase): standard/direct-apply run `openspec archive` to move the change dir and validate; no-openspec only validates (no OpenSpec dir). Leaves a clean, stageable tree, then advances to `committing` to start the git role.
- **Git role** (runs second, in `committing` phase): preflight, stage everything including the archive move, commit, push, then advance to `completed`.

`cmd_archive` currently branches on phase (`developer-review` → start git; `committing`/`archive` → finalize). Rewire so developer approval starts the **archive** role (new `_start_archive`), the archive role's completion starts the **git** role, and the git role's completion finalizes to `completed`. `write_archive_context` gains the `openspec archive` instruction (standard/direct-apply); `write_git_context` notes the archive move is already in the tree and must be staged. Skills for archive and git swap their command order accordingly (archive no longer runs last; git no longer triggers archive).

Edge: the git role must not run before the archive role has produced a clean tree — gate the git start on `archive` phase completion, and keep the existing dirty-tree guard so a half-done archive can't be committed.

### Bug 6 — prompt prefilled but not submitted

`prompt_role` currently pastes then presses Enter as two calls:

```python
herdr("pane", "send-text", pane_id, prompt)
herdr("pane", "send-keys", pane_id, "enter")
```

The separate Enter races the TUI's bracketed-paste ingestion and is dropped, leaving the prompt prefilled but unsent. There is no single herdr command that starts an agent *and* submits a prompt: `agent start` takes no prompt, and `agent send` writes literal text without Enter ("use pane run when you want command text plus Enter"). Passing the prompt as pi launch argv is discouraged by the Herdr skill and would bypass the interactive `/skill:` prompt path. So launch stays in `launch_role`; only the submit step changes.

Fix, all inside `prompt_role`:

```python
# readiness: wait for the TUI to reach idle instead of matching a startup hint
try:
    herdr("wait", "agent-status", pane_id, "--status", "idle", "--timeout", "8000")
except SystemExit:
    telemetry(state, "prompt_wait_timeout", role=role)
write_trace_handoff(state, role)
# atomic submit: text + Enter together
herdr("pane", "run", pane_id, prompt)
```

Keep the `state_change_seq` acknowledgement loop and the second-attempt `ctrl+c` recovery; on retry, re-submit with `pane run` (not the old pair). One function change fixes worker-on-approval and every other prompted role.

## Verification

Each fix has a cheap, runnable check:

- **Bug 1**: grep asserts no verifier skill contains `--verdict` and every one contains the exact `verification-result ... --role` command.
- **Bug 2**: unit-style check that `ensure_clean(tmp, require_openspec=False)` passes on a clean non-OpenSpec dir and `require_openspec=True` raises; plus `cmd_start` passing the right flag.
- **Bug 3/4**: grep asserts the no-openspec prompt string contains `herdr-workflow verify` and the worker skill scopes tasks.md steps conditionally.
- **Bug 5**: assert `allowed_transitions` for each workflow type yields `archive → committing` and `committing → completed` (not `committing → archive`); assert `WORKFLOW_TYPES` lists `archive` before `git-operations`; assert the archive skill runs `openspec archive` before advancing and the git skill stages after archive (grep).
- **Bug 6**: grep asserts `prompt_role` uses `pane`/`run` for submission and contains no `send-text`+`send-keys "enter"` pair; assert it waits on `agent-status idle` rather than `output --match ctrl+o`. (Full end-to-end submit is integration-only; the static asserts guard the regression.)

A single self-check script under the change dir runs these greps/asserts.

## Trade-offs

- Chose skill edits over adding a tolerated `--verdict` CLI flag: the verdict already lives in the JSONL file, so a flag would be a second source of truth. Skipped; add a flag only if a future non-skill caller needs it.
- Chose one conditional worker skill over a dedicated no-openspec worker skill: avoids a near-duplicate file. Add a separate skill only if the two paths diverge substantially.

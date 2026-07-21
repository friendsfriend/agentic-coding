## Why

An audit of the three Herdr workflow routes (`standard`, `direct-apply`, `no-openspec`) traced end-to-end through `pi/bin/herdr-workflow` and the role skills found four bugs that cause the workflow to get stuck or refuse to start. The most severe is a CLI/skill contract mismatch that hangs verification for every workflow type.

### Bug 1 (P0, all workflows) — verifier completion command always fails, workflow stuck in `verify`

All six verifier skills instruct the agent to signal its verdict with:

```bash
herdr-workflow verification-result --repo "$PWD" --change "$HERDR_CHANGE_ID" --role <role> --verdict <PASS|FAIL>
```

But `verification-result`'s argparser only declares `--repo`, `--change`, `--role` — it reads the verdict from the last line of the JSONL findings file, not a flag. argparse rejects the unknown `--verdict` and exits non-zero. The verifier's verdict is therefore never recorded, `cmd_verification_result` never runs, and the workflow stays in `verify` until the timeout watchdog pushes it to `paused`. This hits `standard`, `direct-apply`, and `no-openspec` because all three include the `apply-verify` module.

Affected skills: `security-verifier`, `agents-verifier`, `quality-verifier`, `performance-verifier`, `openspec-verifier`, `test-verifier`.

### Bug 2 (P1, no-openspec) — cannot start without an OpenSpec project

`cmd_start` calls `ensure_clean(source)` unconditionally, which raises `OpenSpec project not found` when `openspec/config.yaml` is absent. The entire point of `no-openspec` is to run in repositories without OpenSpec, so it can never start in exactly the repositories it was built for.

### Bug 3 (P1, no-openspec) — worker skill contradicts the no-openspec prompt

The worker is an unrestricted role and always loads `herdr-openspec-worker/SKILL.md`, which mandates reading `openspec/changes/<change>/tasks.md` and flipping `[ ]` → `[x]` checkboxes. In `no-openspec` there is no `tasks.md`. The no-openspec worker prompt says "No task checklist to read", directly contradicting the loaded skill, so the worker either wastes turns hunting for a missing file or stalls on conflicting instructions.

### Bug 4 (P2, no-openspec) — worker never told how to start verification

The no-openspec worker prompt ends with "signal completion when done" and never names the `herdr-workflow verify` command. With no skill step covering the no-openspec path either, the worker has no reliable way to advance `apply → verify`, risking a silent stall.

### Bug 5 (P1, standard/direct-apply) — archive runs after git, so the OpenSpec archive move is never committed

The module order is `developer-approval → git-operations → archive`: the git role commits and pushes first, then the archive role runs. But archiving an OpenSpec change is a file mutation — `openspec archive` moves `openspec/changes/<change>/` into `openspec/changes/archive/`. Running that *after* commit/push means the archive move is never staged into the commit that was already pushed, leaving the change dir un-archived on the pushed branch (or producing a stray uncommitted move afterward). Ordering is backwards: the file-mutating archive must happen **before** commit so the git role includes it. Today neither role even runs `openspec archive`, so change dirs accumulate un-archived under `openspec/changes/`.

### Bug 6 (P0, all workflows) — prompt is prefilled but never submitted, agent doesn't start

`prompt_role` submits the prompt to a role's pi TUI with two separate calls:

```python
herdr("pane", "send-text", pane_id, prompt)
herdr("pane", "send-keys", pane_id, "enter")
```

Observed on worker start after approval: the tab is created, the agent is moved in, the prompt text is prefilled in the input, but Enter never takes effect — the agent sits idle and the workflow stalls. The Herdr skill documents this exact hazard: *"`pane run` sends the text and Enter together. Use it for initial prompts and follow-ups instead of coordinating `send-text` and `send-keys` separately."* The separate Enter races the bracketed-paste ingestion in the TUI and is dropped. The `wait output --match ctrl+o` gate is also the wrong readiness signal — the reliable signal is the agent reaching `idle`. This affects every prompted role (worker, planner, triage, verifiers, git, archive, recovery, messages), so it is not worker-specific.

### Prompt reliability improvements (cross-cutting)

Verifier skills each embed the wrong command; fixing them is the chance to make the completion contract identical and unambiguous across all six, and to make the worker skill explicit that OpenSpec task tracking applies only when `tasks.md` exists.

## What Changes

### 1. Fix verifier completion contract (Bug 1)

Remove `--verdict <PASS|FAIL>` from all six verifier skill command examples. The verdict is already carried by the mandatory final JSONL `{"type":"verdict","verdict":"…"}` line that `cmd_verification_result` reads. The corrected, identical command for every verifier is:

```bash
herdr-workflow verification-result --repo "$PWD" --change "$HERDR_CHANGE_ID" --role <role>
```

### 2. Allow no-openspec to start without OpenSpec (Bug 2)

Split `ensure_clean` so the working-tree-clean check runs for every workflow type, but the `openspec/config.yaml` existence check is skipped when `--workflow-type no-openspec`. Standard and direct-apply still require OpenSpec.

### 3. Make the worker skill conditional on tasks.md (Bug 3)

Update `herdr-openspec-worker/SKILL.md` so the task-checkbox steps explicitly apply only when `openspec/changes/<change>/tasks.md` exists (standard/direct-apply); for no-openspec the worker implements from `request.md` and skips checkbox tracking. This removes the contradiction without needing a separate worker skill.

### 4. Give the no-openspec worker an explicit verify step (Bug 4)

Update the no-openspec branch of `role_prompt("worker", …)` to name the exact command to run when the change is applied: `herdr-workflow verify --repo . --change <change>`.

### 6. Submit prompts atomically with `pane run` (Bug 6)

Replace the `send-text` + `send-keys enter` pair in `prompt_role` with a single atomic `herdr pane run <pane_id> <prompt>`, which sends the text and Enter together as the Herdr skill prescribes. Replace the `wait output --match ctrl+o` readiness gate with `wait agent-status <pane_id> --status idle --timeout <ms>` so the prompt is only sent once the TUI is ready to accept it. Keep the existing acknowledgement check (`state_change_seq` advanced) and the second-attempt `ctrl+c` recovery, but re-run via `pane run` on retry too. This is one function; every role benefits.

### 5. Reorder archive before git-operations, and make archive do the OpenSpec archive move (Bug 5)

Swap module order to `developer-approval → archive → git-operations` for all workflow types, so the file-mutating archive runs first and the git role commits its result:

- `WORKFLOW_MODULES["archive"].exit` becomes `"committing"` (git-operations is next); `git-operations.exit` stays `"completed"` (now the last module).
- `WORKFLOW_TYPES["standard"]` becomes `["plan", "plan-approval", "apply-verify", "developer-approval", "archive", "git-operations"]`; `direct-apply` and `no-openspec` become `["apply-verify", "developer-approval", "archive", "git-operations"]`.
- Phase flow becomes `developer-review → archive → committing → completed`.
- After developer approval, the archive role runs first (via `_start_archive`), then advances to `committing` where the git role runs.
- Archive role: for standard/direct-apply, run `openspec archive` to move the change dir, validate, leave a clean stageable tree; for no-openspec, just validate (no OpenSpec dir). Then advance to `committing`.
- Git role: preflight, stage everything **including the archive move**, commit, push, then advance to `completed`.
- Rewire `cmd_archive`, `_start_git_operations` (+ new archive-start path), `write_archive_context`, `write_git_context`, `cmd_preflight_archive` phase guards, and `allowed_transitions` so `archive → committing → completed` is the valid chain.

## Non-goals

- No changes to the verification round loop, triage, recovery, or the dashboard.
- No new workflow types. Module composition changes only by reordering `archive` before `git-operations` (Bug 5); no modules added or removed.
- Deterministic `plan_quality` output for no-openspec is already non-fatal (returns `passed:false` without reading a missing file) and is left unchanged.

## Impact

- Affected code: `pi/bin/herdr-workflow` (`ensure_clean`, `cmd_start`, `role_prompt`, `prompt_role`, `WORKFLOW_MODULES`, `WORKFLOW_TYPES`, `cmd_archive`, git/archive start paths, `write_archive_context`, `write_git_context`, `cmd_preflight_archive`).
- Affected skills: `herdr-openspec-{security,agents,quality,performance,openspec,test}-verifier/SKILL.md`, `herdr-openspec-worker/SKILL.md`, `herdr-openspec-archive/SKILL.md`, `herdr-openspec-git/SKILL.md`.
- State schema unchanged; the reorder changes phase sequencing only. In-flight workflows already past developer-review under the old order should finish on the old order (no live migration).
- Specs updated: `openspec-verification` (verifier completion contract), `no-openspec-workflow` (start without OpenSpec, worker guidance, archive-before-git), `direct-apply-workflow` (archive-before-git module order).

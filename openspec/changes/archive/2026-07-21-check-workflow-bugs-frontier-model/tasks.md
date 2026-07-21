## 1. Fix verifier completion contract (Bug 1)

- [x] 1.1 Remove `--verdict <PASS|FAIL>` from the `verification-result` command in `agent-definitions/skills/herdr-openspec-security-verifier/SKILL.md`
- [x] 1.2 Remove `--verdict <PASS|FAIL>` from `agent-definitions/skills/herdr-openspec-agents-verifier/SKILL.md`
- [x] 1.3 Remove `--verdict <PASS|FAIL>` from `agent-definitions/skills/herdr-openspec-quality-verifier/SKILL.md`
- [x] 1.4 Remove `--verdict <PASS|FAIL>` from `agent-definitions/skills/herdr-openspec-performance-verifier/SKILL.md`
- [x] 1.5 Remove `--verdict <PASS|FAIL>` from `agent-definitions/skills/herdr-openspec-openspec-verifier/SKILL.md`
- [x] 1.6 Remove `--verdict <PASS|FAIL>` from `agent-definitions/skills/herdr-openspec-test-verifier/SKILL.md`
- [x] 1.7 Confirm all six now use the identical form `herdr-workflow verification-result --repo "$PWD" --change "$HERDR_CHANGE_ID" --role <role>` (differing only by role)

## 2. Allow no-openspec to start without OpenSpec (Bug 2)

- [x] 2.1 Add `require_openspec=True` parameter to `ensure_clean` in `pi/bin/herdr-workflow`; skip the `openspec/config.yaml` check when False, keep the dirty-tree check always
- [x] 2.2 In `cmd_start`, call `ensure_clean(source, require_openspec=args.workflow_type != "no-openspec")`

## 3. Make the worker skill conditional on tasks.md (Bug 3)

- [x] 3.1 In `agent-definitions/skills/herdr-openspec-worker/SKILL.md`, scope the task-checkbox steps (Apply steps 5–6) to workflows where `openspec/changes/<change>/tasks.md` exists (standard/direct-apply)
- [x] 3.2 Add explicit no-openspec guidance: implement from `request.md`, no checkbox tracking, start verification with `herdr-workflow verify`

## 4. Give the no-openspec worker an explicit verify step (Bug 4)

- [x] 4.1 In `role_prompt`, update the `no-openspec` worker branch to name `herdr-workflow verify --repo . --change <change>` as the completion command

## 5. Reorder archive before git-operations (Bug 5)

- [x] 5.1 In `pi/bin/herdr-workflow`, change `WORKFLOW_MODULES["archive"].exit` to `"committing"` and keep `git-operations.exit` as `"completed"`
- [x] 5.2 Reorder `WORKFLOW_TYPES` so every type lists `archive` before `git-operations`: standard = `["plan", "plan-approval", "apply-verify", "developer-approval", "archive", "git-operations"]`; direct-apply and no-openspec = `["apply-verify", "developer-approval", "archive", "git-operations"]`
- [x] 5.3 Rewire the developer-approval handoff so approval starts the **archive** role first (add `_start_archive`); update `cmd_archive`/`cmd_git_operations` routing to `developer-review → archive → committing → completed`
- [x] 5.4 Archive role completion starts the **git** role (transition `archive → committing`); git role completion finalizes to `completed`; keep the dirty-tree guard before commit
- [x] 5.5 Update `write_archive_context` to instruct the archive role to run `openspec archive` (standard/direct-apply only) before advancing; update `write_git_context` to note the archive move is already in the tree and must be staged
- [x] 5.6 Update `cmd_preflight_archive` and any phase guards so they accept the new `archive`/`committing` sequencing
- [x] 5.7 Rewrite `agent-definitions/skills/herdr-openspec-archive/SKILL.md`: run `openspec archive` (standard/direct-apply) + validate, then advance to git operations; no longer the final step
- [x] 5.8 Rewrite `agent-definitions/skills/herdr-openspec-git/SKILL.md`: run after archive, stage everything including the archive move, commit, push, then finalize to `completed`

## 6. Submit prompts atomically (Bug 6)

- [x] 6.1 In `prompt_role` (`pi/bin/herdr-workflow`), replace the `send-text` + `send-keys "enter"` pair with a single `herdr("pane", "run", pane_id, prompt)` atomic submit
- [x] 6.2 Replace the `wait output --match ctrl+o` readiness gate with `wait agent-status <pane_id> --status idle --timeout 8000` (keep the `prompt_wait_timeout` telemetry on timeout)
- [x] 6.3 On the second attempt (retry after `ctrl+c`), re-submit via `pane run` as well; keep the `state_change_seq` acknowledgement loop and the trace-handoff cleanup on failure

## 7. Validate

- [x] 7.1 Add a self-check script under `.herdr-workflow/check-workflow-bugs-frontier-model/` (or a small `test_*.py`) that asserts: no verifier skill contains `--verdict`; each contains the exact `verification-result ... --role <role>` command
- [x] 7.2 Assert `ensure_clean(<clean non-openspec tmp dir>, require_openspec=False)` passes and `require_openspec=True` raises `OpenSpec project not found`
- [x] 7.3 Assert the no-openspec worker prompt string from `role_prompt("worker", ...)` contains `herdr-workflow verify` and does not mention OpenSpec task checkboxes
- [x] 7.4 Assert the worker skill scopes tasks.md steps conditionally (no unconditional "read tasks.md")
- [x] 7.5 Assert `allowed_transitions` for each workflow type yields `archive -> committing` and `committing -> completed`, and `WORKFLOW_TYPES` lists `archive` before `git-operations`
- [x] 7.6 Assert the archive skill runs `openspec archive` before advancing and the git skill stages after archive
- [x] 7.7 Assert `prompt_role` submits via `pane run` (no `send-text`+`send-keys "enter"` pair) and waits on `agent-status idle`
- [x] 7.8 Run the self-check and confirm all assertions pass

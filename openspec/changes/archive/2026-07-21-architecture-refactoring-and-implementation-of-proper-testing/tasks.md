# Tasks

## 1. Lock the contract

- [x] 1.1 Add a characterization test capturing the current subcommand list and
      each subcommand's required flags from `parser()`.
- [x] 1.2 Add a golden `state.json` test: run `start` (with fakes) and snapshot
      the field set/shapes the dashboard reads as `WorkflowState`.
- [x] 1.3 Confirm both tests pass against the current monolith before any move.

## 2. Package skeleton + shim

- [x] 2.1 Create `pi/lib/herdr_workflow/` package with empty modules
      (`transitions`, `tiering`, `findings`, `recovery`, `tracing`, `prompts`,
      `state`, `effects`, `commands`, `cli`).
- [x] 2.2 Replace `pi/bin/herdr-workflow` with a thin shim that resolves
      `../lib`, inserts it on `sys.path`, and calls `herdr_workflow.cli.main()`.
- [x] 2.3 Recompute `AGENT_DIR`/`AGENT_DEF_DIR`/`SKILLS`/`CONFIG` from the shim
      location so stow symlinks still resolve; verify with the characterization
      test.

## 3. Extract pure modules

- [x] 3.1 Move `WORKFLOW_MODULES`, `WORKFLOW_TYPES`, `resolve_modules`,
      `allowed_transitions`, `OPERATIONAL_PHASES` into `transitions.py`; monolith
      imports them.
- [x] 3.2 Move `review_tier` (pure part), `eligible_verifier_roles`,
      `applicable_instructions`, `file_manifest` parsing into `tiering.py`
      (git-diff strings passed in, not fetched).
- [x] 3.3 Move consolidation/dedup/status and report schema validation into
      `findings.py`.
- [x] 3.4 Move `recovery_plan_error` and `RECOVERY_ACTION_PHASES` into
      `recovery.py`.
- [x] 3.5 Move traceparent parse/format, `child_context`, span-record building
      into `tracing.py`.
- [x] 3.6 Move `role_prompt`, `pi_arguments`, `pi_command` into `prompts.py`.
- [x] 3.7 Move `plan_quality`, `ensure_tasks_complete` (path + text logic) into a
      pure gate helper; keep filesystem read at the call site.
- [x] 3.8 Run characterization test after each extraction — must stay green.

## 4. Introduce seams

- [x] 4.1 Add `effects.py` with `Herdr`, `Git`, `Clock`, `TraceExporter` classes
      wrapping the current inline subprocess/`time`/`urllib` calls.
- [x] 4.2 Add a `Context` carrying `config`, `herdr`, `git`, `clock`, `exporter`.
- [x] 4.3 Move all `cmd_*` functions into `commands.py` and route their
      `herdr`/`git`/`time`/trace calls through the `Context`.
- [x] 4.4 Move `state.py` (`load_state`, `save_state`, `set_phase`,
      `state_path`, `workflow_dir`) out of the monolith.
- [x] 4.5 Replace `launch_role`'s `agent start` + `pane move --new-tab` with
      `tab create` → `pane run "pi …"` → optional `agent rename`; store
      `panes[role]`/`tabs[role]` from the `tab create` result. Remove the 25×
      `"not an available shell"` retry loop.
- [x] 4.6 Verify `agent get` / `wait agent-status` still resolve by `pane_id`;
      keep the `state_change_seq is None` prompt-delivery fallback intact.
- [x] 4.6a Rework `prompt_role` to submission-verified with an Enter nudge:
      `pane run` → confirm `state_change_seq` advances → else `send-keys enter`
      → re-confirm → else `ctrl+c` + retry, bounded, then raise. Preserve the
      `state_change_seq is None` "assume delivered" branch and trace-handoff
      write/cleanup.
- [x] 4.7 Move `parser()`/`main()` into `cli.py`; build the real `Context` there.
- [x] 4.8 Delete the monolith body; the shim now only calls the package.
- [x] 4.9 Characterization tests still green (CLI + state.json unchanged).

## 5. Fakes

- [x] 5.1 Add `fakes.py`: `FakeHerdr` (records calls, scripted responses),
      `FakeGit` (backed by a real tmp git repo), `FakeClock` (fixed/monotone),
      no-op `TraceExporter`.
- [x] 5.2 Add a tmp-repo helper that inits git, writes `openspec/config.yaml`,
      and stages a base commit.

## 6. Pure unit tests

- [x] 6.1 `test_transitions.py`: allowed transitions for all three workflow
      types + invalid-transition rejection.
- [x] 6.2 `test_tiering.py`: full/lite/trivial thresholds, sensitive-path
      detection, `eligible_verifier_roles` per pattern.
- [x] 6.3 `test_findings.py`: new/unfixed/fixed/accepted status, dedup, report
      schema validation limits.
- [x] 6.4 `test_recovery.py`: `recovery_plan_error` for each action×phase and bad
      identifiers/roles.
- [x] 6.5 `test_tracing.py`: traceparent round-trip, all-zero rejection, child
      context inheritance.
- [x] 6.6 `test_prompts.py`: `role_prompt` per role, `pi_arguments` tool/skill
      wiring incl. no-openspec worker branch.
- [x] 6.7 `test_gates.py`: `plan_quality` missing-artifact matrix,
      `ensure_tasks_complete` incomplete detection.

## 7. Per-phase tests

- [x] 7.1 `test_phases.py`: `cmd_planner`, `cmd_apply` (pass + gate fail),
      `cmd_phase` proposed gate incl. PLAN_REJECTED, `cmd_override_phase`.
- [x] 7.2 `cmd_verify` → triage, `cmd_dispatch_verifiers` (empty plan →
      developer-review; populated plan → verify), invalid triage plan rejection.
- [x] 7.3 `cmd_verification_result`: single verifier, all-pass → test verifier,
      any-fail → fix, round-limit → paused.
- [x] 7.4 `cmd_recover` + `cmd_apply_recovery` for each allowed action.
- [x] 7.5 `cmd_archive` for developer-review, archive, and committing sub-phases;
      `cmd_git_operations`; `cmd_check_timeout` timeout path; `cmd_message`.
- [x] 7.6 Launch-sequence test: `launch_role` records `tab create` → `pane run`
      (→ `rename`) against `FakeHerdr`, sets `panes[role]`/`tabs[role]`, and does
      NOT call `agent start` or `pane move`.
- [x] 7.7 Prompt-submission tests via `FakeHerdr` scripted `state_change_seq`:
      (a) seq advances after `pane run` → no `send-keys` issued; (b) seq flat
      after `pane run`, advances after `send-keys enter` → nudge issued once;
      (c) seq never advances → raises "not acknowledged" after the bound and the
      trace-handoff file is removed.

## 8. Per-workflow tests

- [x] 8.1 `test_workflows.py`: drive a full `standard` run to `completed`,
      asserting the phase sequence matches its module chain.
- [x] 8.2 Drive a full `direct-apply` run to `completed` (no planner, starts in
      `apply`).
- [x] 8.3 Drive a full `no-openspec` run to `completed` (worker reads
      `request.md`, task-completion check skipped).

## 9. Wire it up

- [x] 9.1 Add `scripts/test-workflow.sh` running `python3 -m unittest` over the
      package tests; exit non-zero on failure.
- [x] 9.2 Reference the new script in `README.md` next to the plugin test.
- [x] 9.3 Full suite green; characterization tests confirm no contract drift.

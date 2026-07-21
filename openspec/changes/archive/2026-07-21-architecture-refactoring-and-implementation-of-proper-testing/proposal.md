## Why

`herdr-workflow` is a single 1,586-line Python script with no automated tests.
Pure decision logic (phase transitions, review tiering, verifier eligibility,
finding consolidation, recovery validation, trace math) is interleaved with
side effects (`herdr` subprocess calls, `git`, filesystem, `time`, network).
Because nothing is seam-separated, none of it can be unit-tested, and there is
no way to test a phase in isolation or a whole workflow end to end. The only
existing coverage is one bash integration script for the plugin subsystem.

The developer wants to rethink the architecture and add proper testing: each
**phase** tested in isolation and each **workflow type** tested as a full run.

## What Changes

This is a **behaviour-preserving refactor plus a test suite**. The external
contract stays fixed:

- Every `herdr-workflow` subcommand keeps its exact name, flags, stdout, and
  exit behaviour (the dashboard shells out to them and must not break).
- `state.json` schema stays byte-compatible (dashboard reads it directly).
- Config format (`herdr-workflow.toml` + project overlay) stays identical.

### 1. Package decomposition

Convert the monolith into a Python package `herdr_workflow/` with a thin
`herdr-workflow` entrypoint that stays on `PATH`. Modules split by concern:

| Module | Responsibility |
|---|---|
| `transitions.py` | pure: `WORKFLOW_MODULES`, `WORKFLOW_TYPES`, `allowed_transitions`, phase validation |
| `tiering.py` | pure: `review_tier`, `eligible_verifier_roles`, `applicable_instructions` |
| `findings.py` | pure: consolidation, dedup/status, report schema validation |
| `recovery.py` | pure: `recovery_plan_error`, allowed-action mapping |
| `tracing.py` | pure: traceparent parse/format, child context, span record building |
| `prompts.py` | pure: `role_prompt`, `pi_arguments` string building |
| `state.py` | state load/save/`set_phase`, path helpers |
| `effects.py` | the only place that touches `herdr`, `git`, network, `time`: injectable seams |
| `commands.py` | `cmd_*` orchestration, wiring pure logic to effects |
| `cli.py` | argparse `parser()` + `main()` |

Pure modules take data in and return data out — no subprocess, no I/O.
`effects.py` exposes a small injectable surface (`Herdr`, `Git`, `Clock`,
`TraceExporter`) so orchestration can run against fakes in tests.

### 2. Test suite

Standard-library `unittest` (no new dependency; Python 3.14 already required).

- **Pure unit tests** per module: transitions for every workflow type, tiering
  thresholds/sensitive-path detection, finding consolidation status logic,
  recovery plan validation, trace math, prompt/argument building, plan-quality
  and task-completion gates.
- **Per-phase tests**: drive each `cmd_*` against fake `herdr`/`git`/clock and a
  temp repo, asserting the phase transition, `state.json` fields, guard
  rejections, and which agents are prompted — for `explore → proposed → apply →
  verify → triage → fix → developer-review → archive → committing → completed`,
  plus `paused`, timeout, recovery, and override paths.
- **Per-workflow tests**: a full driven run for each `WORKFLOW_TYPES` entry
  (`standard`, `direct-apply`, `no-openspec`) stepping through every phase with
  fakes, asserting the end state and the module sequence.
- One runnable check (`scripts/test-workflow.sh` invoking `python3 -m unittest`)
  wired next to the existing `scripts/test-plugin-system.sh`.

### 3. Replace `herdr agent start` with direct tab + pane spawn

Role agents are currently launched with `herdr agent start`, which spawns pi in a
fresh pane, then the code does `pane move --new-tab` to relocate it. This path is
flaky: it retries up to 25 times on `"not an available shell"` (a race where the
spawned pane's shell is not ready) and the post-spawn move adds coordination the
workflow does not need.

Agent status detection (`agent get`, `wait agent-status`, `state_change_seq`,
`agent_status`) is driven by the **pi Herdr integration hook** reporting into
whatever pane pi runs in (`herdr pane report-agent`), not by `agent start`. So
launching pi directly still yields full status/wait support.

The new launch sequence, isolated in `effects.py`:

1. `herdr tab create --workspace <ws> --label <role> --env HERDR_ROLE=… --no-focus`
   → returns the tab's root `pane_id`.
2. `herdr pane run <pane_id> "pi <pi_arguments>"` to start the agent in that pane.
3. (optional) `herdr agent rename <pane_id> <change>-<role>` so name-addressing
   keeps working; the workflow already keys panes by `pane_id` in `state.json`.

This removes the 25× shell-ready retry loop and the `pane move --new-tab` step.
`agent get` / `wait agent-status` continue to work addressed by `pane_id`.
Because launch collapses to `tab create` + `pane run` (+ optional `rename`), the
fake `herdr` in tests scripts far fewer calls and the launch path becomes
deterministic.

Guard: if the pi integration hook is not installed the panes still spawn but
report no status; the existing `state_change_seq is None` fallback in
`prompt_role` already handles "integration doesn't report status" by assuming
prompt delivery, so this degrades the same way it does today.

### 4. Make prompt submission actually execute (not just prefill)

A prior fix switched prompting from `send-text`+`send-keys` to a single
`herdr pane run`, on the documented premise that `pane run` delivers text+Enter
atomically. That premise holds for a **shell** pane, but the role pane is a
**running pi TUI**: `pane run`'s Enter races pi's bracketed-paste ingestion, so
the prompt often lands **prefilled but unsubmitted** and the agent sits idle.

The fix makes `prompt_role` submission-verified with an explicit submit nudge,
using the signal the code already trusts — the agent leaving idle
(`state_change_seq` advances / `agent_status` becomes `working`):

1. Wait for the agent to reach `idle` before submitting (already done; keep the
   bounded wait, but treat a missing idle transition as a hard precondition
   failure on the final attempt rather than silently proceeding).
2. Submit the prompt atomically via `herdr pane run`.
3. **Verify submission:** poll for `state_change_seq` to advance (agent moved
   off idle). If it advances → submitted, done.
4. **If it does not advance within a short window** (text is prefilled but
   unsent): send an explicit submit key with `herdr pane send-keys <pane>
   enter`, then re-verify the seq advanced.
5. Only if the explicit Enter also fails to move the agent, `ctrl+c` and
   re-submit the whole prompt, bounded to a small number of attempts, then raise
   `agent prompt was not acknowledged` rather than leaving it idle.

The existing `state_change_seq is None` branch (integration not reporting) keeps
its current "assume delivered" behaviour so environments without status
reporting are unchanged.

Because `prompt_role` runs through the `Herdr` seam, tests assert each path
deterministically against `FakeHerdr`: submitted-on-first-try (seq advances after
`pane run`), prefilled-then-Enter-nudge (seq flat after `pane run`, advances
after `send-keys enter`), and exhausted-retries (seq never advances → raises).

### 5. Non-goals

- No behaviour change to phases, gates, tiering, or agent prompts.
- No dashboard changes (it keeps calling the same CLI).
- No new runtime dependency; tests use stdlib `unittest`.
- Not rewriting the multi-agent protocol — only reorganising the code that
  drives it so it becomes testable.
- Not changing how agent *status* is detected — the pi integration hook stays the
  source of truth; only the launch call changes from `agent start` to
  `tab create` + `pane run`.
- Not reverting to `send-text`+`send-keys` for the primary submit — `pane run`
  stays the first attempt; `send-keys enter` is only a verified fallback nudge.

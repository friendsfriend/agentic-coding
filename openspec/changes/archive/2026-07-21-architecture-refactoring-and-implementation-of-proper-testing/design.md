# Design

## Constraints

The refactor is boxed by three hard external contracts that tests must lock down
*before* any code moves:

1. **CLI surface.** `agent-dash/src/data.ts` and `scripts/` shell out to
   `herdr-workflow <subcommand> --repo … --change …`. Subcommand names, flags,
   stdout, and non-zero-exit-on-error must not change.
2. **`state.json` schema.** The dashboard parses it as `WorkflowState`. Field
   names and shapes are frozen.
3. **Config.** `herdr-workflow.toml` + `.pi/herdr-workflow.toml` overlay via
   `_deep_merge` stays identical.

A characterization test captures the current `--help` / subcommand list and a
golden `state.json` from a `start` run so the refactor is provably behaviour-
preserving.

## Package layout

```
pi/bin/herdr-workflow            # thin shim: sys.path insert + herdr_workflow.cli.main()
pi/lib/herdr_workflow/
  __init__.py
  transitions.py   # pure
  tiering.py       # pure
  findings.py      # pure
  recovery.py      # pure
  tracing.py       # pure
  prompts.py       # pure
  state.py         # state dict + persistence
  effects.py       # Herdr / Git / Clock / TraceExporter seams
  commands.py      # cmd_* orchestration
  cli.py           # argparse + main
pi/lib/herdr_workflow/tests/
  test_transitions.py
  test_tiering.py
  test_findings.py
  test_recovery.py
  test_tracing.py
  test_prompts.py
  test_gates.py
  test_phases.py          # per-phase cmd_* tests
  test_workflows.py       # per-workflow-type end-to-end tests
  fakes.py                # FakeHerdr, FakeGit, FakeClock, tmp-repo helper
```

The shim keeps `herdr-workflow` a real file on `PATH` (stow links it), so the
dashboard's `Bun.spawnSync(['herdr-workflow', …])` is untouched.

Why `pi/lib/` and not a package next to the shim: `pi/bin/` is on `PATH` and
should hold only executables; a sibling `lib/` keeps import discovery simple
(the shim inserts its resolved `../lib` onto `sys.path`).
`AGENT_DEF_DIR`/`SKILLS`/`CONFIG` path resolution is recomputed from the shim's
location so stow symlinks still resolve.

## Seams (the testability core)

Today `herdr()`, `run()` (git/subprocess), `time`, and `urllib` are called
inline everywhere. We isolate them behind small classes constructed once and
threaded through `commands.py`:

```python
class Herdr:      # wraps `herdr` subprocess -> parsed result dict
    def call(self, *args) -> dict: ...
class Git:        # wraps git subprocess in a repo
    def run(self, *args, cwd) -> str: ...
class Clock:
    def now(self) -> datetime: ...
    def monotonic(self) -> float: ...
    def sleep(self, s): ...
class TraceExporter:
    def export(self, record): ...   # no-op in tests
```

`commands.py` functions receive a small `Context` (config, herdr, git, clock,
exporter). Production wiring builds real ones; tests build fakes. Pure modules
never see the context — they take plain data.

`ponytail: seams are plain classes, not an abstract framework — add an interface
only if a second real implementation ever appears.`

### Fakes

- `FakeHerdr` records every `call(*args)` and returns scripted responses keyed
  by the first args (e.g. `agent get` → an agent dict with a settable
  `agent_status`). Assertions read the recorded call log.
- `FakeGit` is backed by a real temp git repo (cheapest correct option: real
  `git diff --numstat` output feeds tiering/manifest logic without reimplementing
  git). `ponytail: real git in a tmp dir beats mocking diff output; upgrade to a
  pure fake only if git-in-CI proves flaky.`
- `FakeClock` returns fixed/monotone times so timeout and trace timestamps are
  deterministic.

## Agent launch: direct tab + pane spawn

`agent start` is replaced by a direct spawn, entirely inside `effects.py` /
`launch_role`:

```
tab   = herdr.call("tab", "create", "--workspace", ws, "--label", label,
                   *role_env(role, change), "--no-focus")
pane  = tab["root_pane"]["pane_id"]
herdr.call("pane", "run", pane, shlex.join(["pi", *pi_arguments(...)]))
herdr.call("agent", "rename", pane, f"{change}-{role}")   # optional, name addressing
state["panes"][role] = pane
state["tabs"][role]   = tab["tab_id"]
```

Why this is better here:

- **No shell-ready race.** `agent start` created a pane and immediately handed it
  argv; the 25× `"not an available shell"` retry existed to paper over that race.
  `tab create` returns a settled pane, and `pane run` submits the command the
  same way the dashboard/git panes are already started (`herdr pane run` for
  `agent-dash` and `lazygit` — both launched without `agent start` today, proving
  the pattern works).
- **No post-spawn move.** The tab is created in the target workspace up front, so
  `pane move --new-tab` (and its result-parsing for `created_tab.tab_id`)
  disappears.
- **Status detection unchanged.** `agent_status` / `state_change_seq` come from
  the pi integration's `pane report-agent`, keyed to the pane pi runs in. `agent
  get` and `wait agent-status` accept a `pane_id` target, which the workflow
  already stores. `agent rename` restores name addressing for callers that use
  the `<change>-<role>` name.

Risk register:

- *Integration not installed* → no status reported. Same failure mode as today;
  `prompt_role` already treats `state_change_seq is None` as "assume delivered".
- *`pane run` needs a settled shell too* → `tab create` returns after the pane is
  ready, so the command lands in the pane's shell rather than racing spawn. If a
  residual race appears, a single bounded `wait output`/short poll on the pane
  replaces the 25× loop. `ponytail: start with no retry; add one bounded poll
  only if a real race is observed.`

This change lives behind the `Herdr` seam, so per-phase and per-workflow tests
assert the new call sequence (`tab create` → `pane run` → `rename`) against
`FakeHerdr` with no subprocess.

## Prompt submission: verified, with an Enter nudge

`prompt_role` currently submits with one `herdr pane run` and treats a
non-advancing `state_change_seq` as failure only inside a two-attempt loop that
resets with `ctrl+c`. On a running pi TUI the very first `pane run` frequently
prefills without submitting (the Enter races bracketed-paste ingestion), so the
agent is left idle with text in its input box.

Submission becomes verified against the same signal the code already uses — the
agent leaving idle:

```
for attempt in range(N):                       # small bound, e.g. 3
    wait agent-status idle (bounded)           # precondition
    baseline = agent.state_change_seq
    herdr pane run <pane> <prompt>             # primary submit (text+Enter)
    if seq advances within short window: return # submitted
    herdr pane send-keys <pane> enter          # nudge: prefilled -> submit
    if seq advances within short window: return # submitted
    herdr pane send-keys <pane> ctrl+c         # reset, then retry whole prompt
raise "agent prompt was not acknowledged"
```

Key points:

- **`pane run` stays the primary submit** — correct for the common case and for
  shell panes; the change only adds *verification* plus a *nudge*.
- **The Enter nudge targets exactly this bug**: text already pasted, submit key
  dropped. `send-keys enter` re-issues only the submit, without re-typing.
- **`state_change_seq is None`** (integration not reporting status) keeps the
  current "assume delivered after `pane run`" behaviour — no regression where
  status is unavailable.
- **Trace handoff file** is written before the first submit (unchanged) and
  cleaned up on final failure (unchanged).

`ponytail: bounded retry with one Enter nudge, not an exponential/again-forever
loop — widen the window or bump N only if a real environment needs it.`

Because this all runs through the `Herdr` seam, `FakeHerdr` scripts
`state_change_seq` per call so tests cover: (a) seq advances right after
`pane run` → one call, no nudge; (b) seq flat after `pane run`, advances after
`send-keys enter` → nudge path; (c) seq never advances → raises after the bound.

## Testing strategy

**Pure (fast, no seams):** every branch of `allowed_transitions` for all three
workflow types; `review_tier` thresholds (sensitive path, >50 files, >100 lines,
docs-only ≤10, lite default); `eligible_verifier_roles` per path pattern;
`consolidate_findings` new/unfixed/fixed/accepted status; `recovery_plan_error`
for each allowed/blocked action×phase; traceparent round-trip and rejection of
all-zero ids; `plan_quality` missing-artifact matrix; `ensure_tasks_complete`
incomplete detection.

**Per-phase (`cmd_*` + fakes + tmp repo):** each command asserts (a) the
resulting `state["phase"]`, (b) key `state.json` fields, (c) guard rejections
raise `SystemExit` with the right message, (d) the expected `herdr` calls
(agent start/prompt/pane) were recorded. Covers `cmd_planner`, `cmd_apply`,
`cmd_verify`, `cmd_dispatch_verifiers`, `cmd_verification_result` (single
verifier, all-pass→test-verifier, any-fail→fix, round-limit→paused),
`cmd_recover`/`cmd_apply_recovery`, `cmd_archive` (all three sub-phases),
`cmd_git_operations`, `cmd_phase` (proposed gate incl. PLAN_REJECTED),
`cmd_override_phase`, `cmd_check_timeout`, `cmd_message`.

**Per-workflow (end-to-end with fakes):** for each of `standard`,
`direct-apply`, `no-openspec`, start the workflow then drive commands through the
whole module chain, asserting the phase sequence matches
`resolve_modules(state)` and the run terminates in `completed`. Agent side
effects are satisfied by `FakeHerdr` scripted responses; the "agent" work
(writing `proposal.md`, marking tasks `[x]`, writing verifier findings/verdicts)
is simulated by the test writing those files, mirroring what a real agent does
so the gates see real inputs.

## Migration approach

1. Land characterization test against current monolith (locks CLI + golden
   state).
2. Extract pure modules first; monolith imports them and delegates — behaviour
   identical, characterization stays green after each extraction.
3. Introduce seams; route `commands.py` through the `Context`.
4. Replace the monolith body with `cli.py`; shim points at the package.
5. Add per-phase and per-workflow suites.

Each step keeps the characterization test green, so the refactor is verifiable
at every commit rather than as one big-bang rewrite.

## Alternatives considered

- **pytest** — rejected: adds a dependency for what stdlib `unittest` covers.
- **Full pure fake of git** — rejected: reimplementing `git diff --numstat`
  parsing is more code and less correct than driving a real tmp repo.
- **Rewrite in another language / new protocol** — rejected: out of scope and
  would break the dashboard contract; the goal is testability, not replacement.

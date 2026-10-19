# Addendum — the archive effect counterfactual

Backlog item 22 (`04-backlog.md`, "Run the archive happy path in the engine
again") gated itself on a spike: *"First a one-hour spike: read the old effect
path's code in git history to confirm it did the same work."* The spike was run
and it **refutes** the item's counterfactual. Like `04a`, this is an additive
record: it does **not** revise the figures in `00`…`04`.

The short version is in *Verdict*: `delivery.archive_started` →
`archive_completed` never bracketed an engine effect. Both events were emitted
around the **archive agent's own run** — `archive_started` by the function that
launches that role, `archive_completed` by the CLI verb the role itself invokes
when it is done — and no era of the engine ever spawned `openspec`. The 18.2 s
was the agent's own run time on a cheap fast model, and "no tokens" was unread
telemetry rather than absent cost. Item 22 therefore stops at its own gate.

## The claim under test

`02e` WD-1 asserts *"The engine used to do this itself"*: that between
2026-07-27 and 2026-08-14 the engine ran the archive's three commands
(`openspec validate "$HERDR_CHANGE_ID" --strict`, `openspec archive
"$HERDR_CHANGE_ID" --yes`, `openspec validate --all`) as a deterministic
`delivery` effect, finishing in a mean 18.2 s with no model tokens, and that the
work later became a model run.

Confirming that needs engine code which (a) emits `archive_started`, (b) spawns
`openspec`, and (c) emits `archive_completed` once that spawn returns. The third
step is where the claim fails: the events exist, the spawn does not.

## What the code actually did

### Python era — `pi/lib/herdr_workflow/commands.py` @ `078167d` (2026-07-24)

```python
def _start_archive(ctx, state):                  # :955
    """Launch archive agent with its native Pi initial prompt."""
    close_completed_role_panes(ctx, state)
    write_archive_context(state)
    launch_role(ctx, state, "archive")           # :959  ← launches the AGENT
    state["developerApproval"] = True
    change_phase(ctx, state, "archive", reason="developer_approved")
    telemetry(ctx, state, "archive_started")     # :962  ← emitted AFTER the launch
```

```python
def cmd_archive(ctx, args):                      # :1101
    ...
    if state["phase"] == "archive":
        telemetry(ctx, state, "archive_completed")  # :1107
        _start_git_operations(ctx, state)           # :1108
```

`cmd_archive` is the CLI verb the **archive agent invokes itself** when its own
work is done. It is not engine-side work, and it does not run `openspec`.

### TypeScript era — `agentic-coding/src/workflow/completion.ts` @ `122cf11` (and `4e10ebb`, `6cc30b7`, `aa9bb51`, identical shape)

```ts
/** Launch archive agent with its native Pi initial prompt. */
async function startArchive(ctx: Context, state: WorkflowState): Promise<void> { // :58
  closeCompletedRolePanes(ctx, state);
  writeArchiveContext(ctx, state);
  await roles.launchRole(ctx, state, 'archive');        // :61  ← launches the AGENT
  state.developerApproval = true;
  telemetry.changePhase(ctx, state, 'archive', { reason: 'developer_approved' });
  telemetry.telemetry(ctx, state, 'archive_started');   // :64  ← emitted AFTER the launch
}
```

```ts
export async function cmdArchive(ctx: Context, args: Args): Promise<void> { // :159
  ...
  if (state.phase === 'archive') {
    telemetry.telemetry(ctx, state, 'archive_completed');  // :166
    startGitOperations(ctx, state);                        // :167
```

The same shape in both eras gives the same conclusion: the pair is emitted by
the function that launches the archive role and by the verb that role calls when
it is finished. It brackets the agent run.

### Who ran the OpenSpec commands

Never the engine. The instruction lived in the agent's own material:

* `agent-definitions/skills/herdr-openspec-archive/SKILL.md` (present from
  `122cf11`, deleted by `b69cc8e`): its standard/direct-apply path runs
  `openspec archive "$HERDR_CHANGE_ID" --yes` (:17) and then
  `herdr-workflow archive --repo "$PWD" --change "$HERDR_CHANGE_ID"` to hand off
  to git operations — i.e. the skill is what invokes `cmd_archive`.
* prompt text the engine wrote *for the agent*
  (`agentic-coding/src/workflow/completion.ts:37-38` @ `4e10ebb`): ``Run
  `openspec archive ${state.changeId} --yes` to move
  `openspec/changes/${state.changeId}/` into `openspec/changes/archive/`, then
  validate.`` The engine phrased the instruction; the agent executed it.

A grep of every era for engine-side spawning (`subprocess`, `spawn`, `exec`,
`Bun.$`, `execFile`) finds no `openspec archive` call site — only skill and
prompt text. The engine's first real `openspec` effect, `openspec.validate`,
belongs to planning (`steps/planning.ts`), not to the archive.

### The emitter's removal

`b69cc8e` ("Apply rework-workflow-state-handling", 2026-08-15) deleted
`agentic-coding/src/workflow/completion.ts` outright — the hunk is
`@@ -1,184 +0,0 @@`, taking `startArchive` (`archive_started`) and `cmdArchive`
(`archive_completed`) with it. The last observed pair in the snapshot is
2026-08-14T08:41:03, one day before. The events do not fade out; they stop when
the code that emitted them is deleted.

### Current source

`grep -rn "archive_started\|archive_completed" agentic-coding/src/` returns
nothing. `delivery.commit` and `delivery.push` are the only delivery effects, and
`core.archive` is an agent step with `roles: () => ["archive"]`. The archive's
three commands are still the role's job
(`agent-definitions/instructions/archive.md`), now under item 17's bound: two
`openspec validate`/`openspec archive` attempts, then `blocked` with the
validator output and no third attempt.

## What the data says

The query pairs each workflow's first `archive_started` with its first later
`archive_completed` and joins the archive runs and their turns:

```sql
WITH p AS (SELECT workflow_id, MIN(substr(at,1,23)) ast FROM v_events
           WHERE event='archive_started' GROUP BY workflow_id),
     c AS (SELECT workflow_id, MIN(substr(at,1,23)) act FROM v_events
           WHERE event='archive_completed' GROUP BY workflow_id),
     w AS (SELECT p.workflow_id, p.ast, c.act FROM p JOIN c USING (workflow_id)
           WHERE c.act > p.ast)
SELECT (SELECT COUNT(*) FROM w)                                        AS pairs,
       (SELECT COUNT(DISTINCT r.workflow_id) FROM v_runs r JOIN w
          ON r.workflow_id=w.workflow_id WHERE r.role='archive')       AS wf_with_archive_run,
       (SELECT COUNT(*) FROM v_turns t JOIN v_runs r ON t.run_id=r.run_id
          JOIN w ON r.workflow_id=w.workflow_id WHERE r.role='archive') AS turns_all,
       (SELECT COUNT(*) FROM v_turns t JOIN v_runs r ON t.run_id=r.run_id
          JOIN w ON r.workflow_id=w.workflow_id WHERE r.role='archive'
          AND substr(t.started_at,1,23) BETWEEN w.ast AND w.act)       AS turns_in_window,
       (SELECT ROUND(SUM(t.cost),4) FROM v_turns t JOIN v_runs r ON t.run_id=r.run_id
          JOIN w ON r.workflow_id=w.workflow_id WHERE r.role='archive'
          AND substr(t.started_at,1,23) BETWEEN w.ast AND w.act)       AS cost_in_window;
```

| measurement | value |
| --- | --- |
| workflows with the `archive_started` → `archive_completed` pair | **32** (2026-07-27T07:21:16 → 2026-08-14T08:41:03) |
| …of those, workflows with an `archive`-role run | **31 of 32** |
| archive-role run start offset vs `archive_started` | mean **+2.9 s** (min −1.5, max +9.3) |
| archive-run turns in those workflows | **200** |
| …of those turns inside the pair window | **164 (82 %)** |
| cost inside the pair window | **0.6701 units** of 0.7425 |
| pair window | mean **18.8 s**, min 9.7, max 39.1 |
| cost per archive run: the 32 pair workflows vs the other 48 archive runs | **0.0240** (31 runs, 0.7425) vs **0.0230** (48 runs, 1.1059) |

The agent's run starts 2.9 s (mean) after `archive_started` and carries 82 % of
its turns inside the window: the window is the agent's run, not a hidden effect.
Cost per archive run is flat either side of the boundary (0.0240 vs 0.0230
units), so nothing regressed when the window closed — there is no lost effect to
restore.

## Two corrections to `02e`

Both come from the same source; `02e`'s figures are left as they stand.

1. **The window recomputes slightly wider.** Pairing each workflow's first
   `archive_started` with its first later `archive_completed` gives mean
   **18.8 s** / max **39.1 s** where `02e` quotes 18.2 s / 35.2 s from
   `delivery-timeline`. The difference does not touch the verdict: the window
   brackets the agent's run at either width.
2. **"No tokens" is a telemetry artefact, not absent cost.** The two events are
   phase-level: their `run_id`, `role` and `step_id` are NULL on all 32 rows of
   each, and the event table carries no token columns at all. The cost is on run
   and turn rows, and inside these windows it is **0.6701 units over 164 turns**
   — consistent with a fast/free model doing a two-command job.

## Verdict

**The engine effect never existed.** Both emitting sites are accounted for:
`archive_started` is emitted by the function that launches the archive role, and
`archive_completed` by the `archive` CLI verb that role invokes after running the
OpenSpec commands from its own skill and prompt. No engine code in any era ran
`openspec validate` or `openspec archive`. The 18.2 s was the archive agent's own
run time, and the "zero tokens" was unread phase-level telemetry.

## What follows for item 22

* **The item stops at its own gate.** No `EffectKind`, no `effect-runner`
  handler, no `core.archive` change, no `STORE_SCHEMA_VERSION` change: there is
  no deterministic path to restore. What gets archived and what gets committed
  are untouched, and item 17's bounded repair loop stays exactly as it is (two
  attempts, then `blocked`, no third).
* **The verified half survives, as a new question.** The archive really is a
  model run for a two-command job — 72 of 78 runs at ≤6 calls, 487 turns,
  1.79 units — and the refutation does not change that opportunity. Making the
  archive an engine effect is feasible (the `openspec.validate` effect already
  spawns `openspec` for planning), but it is now a **new optimization** that
  needs its own justification, measurement and decision; it is not a
  restoration.

## Reproduce

```bash
# the emitting sites, per era
git show 078167d:pi/lib/herdr_workflow/commands.py | sed -n '955,962p;1101,1108p'
git show 122cf11:agentic-coding/src/workflow/completion.ts | sed -n '58,64p;159,167p'
git show 4e10ebb:agentic-coding/src/workflow/completion.ts | sed -n '37,38p'
# the emitter's deletion, one day after the last observed pair
git show --stat b69cc8e | grep completion.ts
# no engine-side openspec archive, in any era
git grep -n "openspec archive" 4e10ebb -- agentic-coding/src
# no emitter today
grep -rn "archive_started\|archive_completed" agentic-coding/src/
```

The data table is the SQL block above, run against the pinned snapshot's
`dataset.sqlite`.

## Context

Backlog item 22 (`docs/efficiency/04-backlog.md`, "Run the archive happy path in
the engine again") carries its own gate: *"First a one-hour spike: read the old
effect path's code in git history to confirm it did the same work."* That gate
exists because `02e` (WD-1) could not settle its own counterfactual — it observed
a `delivery.archive_started` → `archive_completed` pair with 18.2 s and no tokens,
found no emitter in the current source, and noted the caveat that `archive`-role
runs with turns existed in the same window.

This design records the spike. **Its verdict refutes the counterfactual**, so item
22's implementation is stopped here, as the item's own gate requires. Nothing in
this change touches runtime code.

## The claim under test

`02e` WD-1 asserts: *"The engine used to do this itself"* — i.e. that between
2026-07-27 and 2026-08-14 the engine executed `openspec validate --strict` +
`openspec archive --yes` + `validate --all` as a deterministic `delivery` effect,
finishing in a mean 18.2 s with no model tokens, and that the archive then became
a model run.

What the spike had to find to confirm it: engine code that (a) emits
`archive_started`, (b) spawns `openspec`, and (c) emits `archive_completed` after
that spawn returns.

## What the code actually did

### Python era — `pi/lib/herdr_workflow/commands.py` @ `078167d` (2026-07-24)

```python
def _start_archive(ctx, state):            # :955
    ...
    launch_role(ctx, state, "archive")     # :959  ← launches the AGENT
    ...
    telemetry(ctx, state, "archive_started")   # :962  ← emitted AFTER the launch
```

```python
def cmd_archive(ctx, args):                # :1101
    ...
    telemetry(ctx, state, "archive_completed")  # :1107
    _start_git_operations(ctx, state)           # :1108
```

`cmd_archive` is the CLI verb the **archive agent invokes itself** when it has
finished its own work (see the skill below). It is not engine-side work.

### TypeScript era — `src/workflow/completion.ts` @ `122cf11` (2026-07-31) and
`4e10ebb`, `6cc30b7`, `aa9bb51` (identical shape)

```ts
async function startArchive(ctx: Context, state: WorkflowState): Promise<void> {
  closeCompletedRolePanes(ctx, state);
  writeArchiveContext(ctx, state);
  await roles.launchRole(ctx, state, 'archive');        // :61  ← launches the AGENT
  state.developerApproval = true;
  telemetry.changePhase(ctx, state, 'archive', { reason: 'developer_approved' });
  telemetry.telemetry(ctx, state, 'archive_started');   // :64  ← emitted AFTER the launch
}
```

```ts
// cmdArchive, :166
telemetry.telemetry(ctx, state, 'archive_completed');
startGitOperations(ctx, state);                          // :167
```

So in **both** eras the pair is emitted by the *same function that launches the
archive agent* (`archive_started`) and by *the verb that agent calls when done*
(`archive_completed`). The pair brackets the **agent run**.

### Who ran the OpenSpec commands

Never the engine. The instruction lived in the agent's own skill and prompt:

- `agent-definitions/skills/herdr-openspec-archive/SKILL.md` (introduced
  `122cf11`, deleted by `b69cc8e`): *"For standard/direct-apply workflows, run
  `openspec archive \"$HERDR_CHANGE_ID\" --yes` … On success, run
  `herdr-workflow archive --repo \"$PWD\" --change \"$HERDR_CHANGE_ID\"` to
  hand off to git operations."*
- `4e10ebb`, `6cc30b7`, `aa9bb51` embed the same sentence as **prompt text** for
  the agent (`agentic-coding/src/workflow/completion.ts:37-38`): ``Run `openspec
  archive ${state.changeId} --yes` to move …``.

A grep of every era for engine-side `openspec` spawning (`subprocess`, `spawn`,
`exec`, `Bun.$`, `execFile`) finds **no call site** — only prompt and skill text.
The engine's first real `openspec` effect, `openspec.validate`
(`effect-runner.ts`), runs `openspec validate` only, arrived later, and belongs to
planning (`steps/planning.ts:47`), not to the archive.

### Current source

`grep -rn "archive_started\|archive_completed" src/` returns **nothing**. The
events are gone; `delivery.commit` and `delivery.push` are the only delivery
effects, and `core.archive` is an agent step with `roles: () => ["archive"]`
(`steps/lifecycle.ts:201`). They stopped when the code that emitted them was
deleted: `b69cc8e` (2026-08-15) removed
`agentic-coding/src/workflow/completion.ts` outright (`@@ -1,184 +0,0 @@`), one
day after the snapshot's last pair (2026-08-14T08:41:03).

## What the data says

Dataset: `/tmp/eff-dataset-dev/dataset.sqlite` (preferred rows, built
2026-10-16T12:11:15Z). Reproduce with:

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

| Measurement | Value |
|---|---|
| Workflows with the `archive_started`/`archive_completed` pair | 32 (2026-07-27T07:21:16 → 2026-08-14T08:41:03) |
| …of those, workflows with an `archive`-role run | **31 of 32** |
| Archive-role run start offset vs `archive_started` | mean **+2.9 s** (min −1.5, max +9.3) |
| Archive-run turns in those workflows | **200** |
| …of those turns falling **inside** the pair window | **164 (82 %)** |
| Cost inside the pair window | **0.6701 units** of 0.7425 total |
| Pair window | mean **18.8 s**, min 9.7, max 39.1 |

Two corrections to `02e`'s figures, both from the same source: the pair window
recomputes to mean 18.8 s / max 39.1 s (02e quoted mean 18.2 s / max 35.2 s), and
the "no tokens attached to the step" is an artefact of the events being
*phase-level* — they carry **no `run_id`, no `role`, no `step_id`** and no token
fields at all. The tokens were never missing; they live on run and turn rows, and
inside these windows they are **0.67 units over 164 turns**, i.e. entirely
consistent with a fast/free model doing a two-command job.

Cost per archive run is flat across the boundary — **0.0240** units/run in the 31
archive runs of the 32 pair workflows vs **0.0230** in the other 48 archive runs
of the snapshot — so nothing regressed when the window closed. There is no effect
whose loss could be restored.

## Verdict

**The engine effect never existed.** Both emitting sites are accounted for:
`archive_started` is emitted by the function that launches the archive agent, and
`archive_completed` is emitted by the `archive` CLI verb *the agent itself invokes*
after running the OpenSpec commands from its own skill. The pair brackets the agent
run — which is why 31 of 32 workflows have an archive-role run starting 2.9 s
(mean) after `archive_started` and why 82 % of that run's turns fall inside the
window.

Therefore:

- **Item 22's premise is false.** There is no "engine used to do this in 18.2 s
  with no tokens" to restore. The 18.2 s was the archive agent's own run time on a
  cheap fast model, and the "zero tokens" was unread telemetry, not absent cost.
- **Per item 22's own gate, the implementation stops here.** No `EffectKind`, no
  `effect-runner` entry, no `core.archive` change, no `STORE_SCHEMA_VERSION`
  change. What gets archived and what gets committed are untouched.
- **Item 17's bounded repair loop is untouched.** The failure path still stays
  with the `archive` role under `ARCHIVE_ATTEMPT_LIMIT`.

## Assumptions

Recorded because the assignment forbids asking the developer:

1. **The finding is the deliverable, not a redesign.** The assignment's STOP
   condition is unconditional: *"If the spike shows the engine effect never did
   equivalent work, STOP the implementation, record the finding in design.md, and
   finish with the findings only."* That is what this change does.
2. **The record should be corrected where the next reader looks.** The refuted
   claim is stated as fact in `02e` (WD-1 + an open question) and again in item
   22's Problem paragraph. Recording the finding only in an archived
   `design.md` would leave both statements standing, and the next efficiency pass
   would re-derive the same false counterfactual. So the change adds a
   `02i`-style addendum and reduces the two upstream statements to one-line
   pointers.
3. **Addendum, not rewrite.** `04a` set the precedent: an addendum is additive
   and does not revise the figures in `00`…`04`. The `02e` and `04-backlog` edits
   are pointer lines only — no figure in either document is rewritten.
4. **Item 22 may still be worth doing, but not as "again".** The half of WD-1 that
   survives is independent and verified: the archive really is a model run for a
   two-command job (72 of 78 runs at ≤6 calls, 482–487 turns, ~1.79 units). A
   future change could make it an engine effect **on its own merits, as a new
   optimization** — spawning `openspec` from the engine is feasible (the
   `openspec.validate` effect already does exactly that at planning) — but that
   needs a fresh decision from the developer and a fresh justification, which is
   out of scope here and is surfaced as an open question instead.
5. **The addendum is `02i`, not the `02f` the plan first named.** `02f` is already
   taken by `02f-env-setup-author.md`, so the next free number in the deep-dive
   series is used. The content and the pointers are unchanged by the rename.

## Risks / Trade-offs

- **Risk: the correction is mistaken to be the cancelled change.** Mitigation: the
  addendum states the verdict and the STOP decision in its first paragraph; the
  proposal says "**No engine change**" explicitly.
- **Risk: a future reader takes the addendum as licence to build the effect.**
  Mitigation: the addendum separates the refuted premise from the surviving
  opportunity and names the decision it needs.
- **Trade-off: the measured 1.79 units stay unclaimed.** Accepted deliberately:
  the assignment gates implementation on the counterfactual, the counterfactual is
  refuted, and building the effect anyway would be scope the developer did not
  authorize.

## Migration Plan

None. Documentation only; no state, schema, or behavior changes.

## Open Questions

1. **Should the archive become an engine effect on its own merits?** The
   opportunity is real and unchanged (~1.79 units / ~482 turns for a two-command
   job); only the "we regressed" framing is dead. This needs a developer decision,
   not an inference from the data.
2. **Why did `02e` see 32 workflows but only 31 archive runs?** The one workflow
  with a pair and no archive-role run is unexamined; it does not change the
  verdict (the other 31 carry 200 of the 200 turns), but it is the one loose end.

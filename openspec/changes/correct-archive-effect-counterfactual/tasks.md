## 1. Record the spike finding

- [ ] 1.1 Create `docs/efficiency/02f-archive-effect-counterfactual.md` as an addendum in the `04a` style: title, backlog item 22 reference, and the one-paragraph verdict (the engine effect never existed; the pair bracketed the archive agent run; item 22 stops per its own spike gate).
- [ ] 1.2 In the addendum, record the code evidence per era with the exact citations: `pi/lib/herdr_workflow/commands.py` @ `078167d` `_start_archive` (`:955`–`:962`, `archive_started` emitted after `launch_role`) and `cmd_archive` (`:1101`–`:1108`, `archive_completed` before `_start_git_operations`); `src/workflow/completion.ts` @ `122cf11` `startArchive` (`:61` launch, `:64` event) and `cmdArchive` (`:166` event, `:167` git).
- [ ] 1.3 In the addendum, record that no era spawned `openspec` from engine code — the instruction lived in `skills/herdr-openspec-archive/SKILL.md` and in agent prompt text (`4e10ebb`, `6cc30b7`, `aa9bb51`) — and that `grep -rn "archive_started\|archive_completed" src/` returns nothing today.
- [ ] 1.4 In the addendum, include the reproducing SQL (the `archive_started`/`archive_completed` CTE joined to `v_runs`/`v_turns`) and the measurement table: 32 pairs, 31 of 32 with an `archive`-role run starting +2.9 s mean after `archive_started`, 164 of 200 archive-run turns inside the window, 0.6701 of 0.7425 units inside it, window mean 18.8 s (min 9.7, max 39.1).
- [ ] 1.5 In the addendum, record the two corrections to `02e`: the window recomputes to 18.8 s mean / 39.1 s max rather than 18.2 s / 35.2 s, and "no tokens" is phase-level telemetry artefact (the events carry no `run_id`, `role`, `step_id` or token fields; the cost is on run/turn rows and is 0.67 units inside the windows), plus the flat per-run cost across the boundary (0.0232 in-window vs 0.0235 outside).
- [ ] 1.6 In the addendum, state that item 22 stops per its own gate, that no engine change follows (no `EffectKind`, no `effect-runner` entry, no `core.archive` change, no `STORE_SCHEMA_VERSION` change), and that item 17's bounded repair loop stays untouched.

## 2. Point the upstream documents at the finding

- [ ] 2.1 In `docs/efficiency/02e-wiki-archive-delivery.md`, replace the open question "Was `delivery.archive_started/completed` really an engine effect doing the same work?" with a one-line answered pointer to `02f`, without rewriting any figure in the document.
- [ ] 2.2 In `docs/efficiency/02e-wiki-archive-delivery.md` WD-1, append a single-line pointer to `02f` next to the existing caveat sentence ("engine effect and agent step may have coexisted there"), leaving the quoted figures intact.
- [ ] 2.3 In `docs/efficiency/04-backlog.md` item 22, replace the refuted premise in the Problem paragraph with a one-line note plus pointer to `02f`, keeping the still-verified part (the archive is a model run for a two-command job: 72 of 78 runs at ≤6 calls, ~487 turns, ~1.79 units) and marking the counterfactual as refuted.
- [ ] 2.4 In the same item, mark the item's disposition (stopped per its own spike gate) so the next efficiency pass does not re-derive the counterfactual; do not delete the item or renumber the table.

## 3. Verify

- [ ] 3.1 Run `openspec validate "correct-archive-effect-counterfactual" --strict` and confirm it passes.
- [ ] 3.2 Run `cd agentic-coding && bun run type-check` and `bun run lint` and confirm zero diagnostics (documentation-only change, so both must be unchanged).
- [ ] 3.3 Confirm no source file changed: `git status --short` shows only the three `docs/efficiency/` files and the change directory.

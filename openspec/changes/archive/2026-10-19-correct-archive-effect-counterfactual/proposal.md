## Why

Efficiency backlog item 22 ("Run the archive happy path in the engine again") is
gated on its own Verify step: read the old effect path's code in git history and
confirm it did the same work before building. The spike was run. It **refutes the
counterfactual**: `delivery.archive_started` → `archive_completed` never bracketed
an engine effect. In every era those two events bracketed the *archive agent's own
run* — `archive_started` was emitted by the function that launches the archive
role, and `archive_completed` was emitted when that same agent invoked
`herdr-workflow archive` to hand off to git. No engine code in any era ever ran
`openspec validate` or `openspec archive`.

So item 22's motivating sentence — "the engine once did this deterministically in
18.2 s with no tokens" — is false, and `02e`'s measured 18.2 s / zero-token pair
is a measurement of the agent, not of an effect. Building the effect on that
premise would mean re-deriving its whole justification. This change records the
finding and corrects the record; per item 22's own gate, it does **not** build the
effect.

## What Changes

- Add `docs/efficiency/02i-archive-effect-counterfactual.md`, an addendum in the
  style of `04a-harness-reader-repair.md` that records the spike: the code
  citation per era, the reproducing queries, the numbers, and the verdict. Like
  `04a`, it is additive — it does not revise the figures in `00`…`04`.
- Answer `02e`'s open question "Was `delivery.archive_started/completed` really an
  engine effect doing the same work?" with a one-line pointer to the addendum.
- Correct item 22's premise in `04-backlog.md` with a one-line pointer, keeping the
  still-verified part (the archive *is* a model run for a two-command job) and
  dropping the refuted part (that the engine used to do it).
- **No engine change.** No `EffectKind`, no `effect-runner` registry entry, no
  `steps/lifecycle.ts` archive change, no `STORE_SCHEMA_VERSION` change. The
  archive happy path stays a model run.

## Capabilities

### New Capabilities

- `workflow-archive-execution`: records the measured fact that the archive happy
  path is executed by the `archive` role's run and not by an engine effect (no
  archive `EffectKind`, no handler, no engine-side `openspec` spawn), and that a
  claim that the engine used to perform a step requires a source emitter before it
  is recorded as verified.

### Modified Capabilities

None. The change alters no runtime behavior: it records a measured fact and
corrects an analysis record, so no existing requirement changes.

## Impact

- `docs/efficiency/02i-archive-effect-counterfactual.md` (new).
- `docs/efficiency/02e-wiki-archive-delivery.md` (open-question answer only).
- `docs/efficiency/04-backlog.md` (item 22 premise note only).
- No source, contracts, effects, telemetry or storage changes. No migration, no
  compatibility shim.

# Design

## Context

See `proposal.md` for motivation. The state this design builds on:

- `agentic-coding/src/workflow/classifiers.ts` is the pure classifier protocol.
  It defines `SINGLE_CONFIDENCE_FLOOR = 0.5`, the `confidentChoice(answer, floor)`
  predicate, and `selectSingleEntry(entries, answer, floor = 0.5)`. The latter
  applies `answer.choice` only when `confidentChoice` is true; otherwise it returns
  the pool's tagged `default: true` profile together with an `attention` string.
- `buildRoutingDecisionSummary` mirrors the same decision for telemetry: it marks
  `fallback` from `selectSingleEntry`'s `attention` and reports the answer's
  `confidence` as an observed scalar.
- `runtime/reducers/effect-result.ts`'s `applyPoolRouting` calls
  `selectSingleEntry`, pushes any `attention`, sets `result.applied` to
  `selected.attention === undefined`, and appends a classifier decision record.
- The `fusion.plan` roster (`selectRosterEntries`, `ROSTER_PROBABILITY_THRESHOLD`)
  and the `noul` necessity thresholds (`TRIAGE_NOUL_FLOOR`) are separate
  mechanisms and are deliberately out of scope.

## Goals / Non-Goals

**Goals:**

- JEV's chosen single-select label is authoritative at any `confidence`; the
  `confidence` value never changes which profile is pinned.
- An answer without a usable `choice` still resolves to the most probable offered
  entry from its `probabilities`.
- The tagged default is kept only as a genuine fallback for an answer with no
  usable decision, and it is still recorded as `attention`.
- No configuration, snapshot schema, effect-contract, request-shape, or
  definition-tier change. `confidence` remains recorded and exported.

**Non-Goals:**

- The `fusion.plan` roster probability threshold and the per-role/per-stage
  `noul` necessity floors.
- Removing `confidence` from `ClassifierAnswer`, the decision record, or the
  `routing.classified` telemetry event.
- Any change to the classifier model, profile, endpoint, question text, or to a
  non-single classification integration.

## Decisions

### D1. Delete the floor rather than leave it unreferenced

`SINGLE_CONFIDENCE_FLOOR` and `confidentChoice` are removed. After the change
nothing consults either, and keeping them would leave a named, exported "floor"
that invites accidental reintroduction. `selectSingleEntry` drops its `floor`
parameter and keeps `(entries, answer)`. The `ClassificationMode` and roster
constants remain.

### D2. One selection order: explicit choice, then highest probability, then default

`selectSingleEntry` resolves in this order:

1. `answer.type === "choice"` with a `choice` naming an offered pool entry → that
   entry's profile.
2. Otherwise, if the answer carries `probabilities`, the offered entry with the
   highest probability value → that entry's profile. Labels with no matching
   offered entry are ignored; an entry may appear under several labels, so the
   highest matching probability wins.
3. Otherwise → the tagged default plus an `attention` note.

This matches "always use the most probable outcome": `choice` is the classifier's
own top pick, and probabilities are the same signal when the provider omits an
explicit `choice` (for example an unknown or absent label).

*Alternative considered:* keep reading only `answer.choice` and remove just the
confidence check. Rejected: a probabilities-only answer would still discard the
most probable entry and fall back to the cheapest profile, which is the behaviour
the task asks to remove.

*Alternative considered:* always trust `choice` even when it names no offered
entry. Rejected: an unknown label names no profile to pin, and the tagged default
must remain the last resort.

### D3. `confidence` stays a recorded observation

`parseClassifierAnswer`, the `ClassifierAnswer` contract, the decision record, and
the `routing.classified` event are unchanged: `confidence` is still parsed,
stored, and exported. It simply no longer participates in selection, so telemetry
continues to show how confident JEV was in the answer that was actually applied.

### D4. Attention and fallback only for an unusable answer

Because `selectSingleEntry` now returns `attention` only for the no-usable-answer
case, `result.applied` in the decision record and `fallback` in
`buildRoutingDecisionSummary` become true only for a genuine fallback. The
former "classifier confidence below floor; kept the pool default routing" note is
deleted at its source, which is the only string that names the floor.

### D5. No compatibility or migration machinery

The change is confined to a pure module and its consumers, with no snapshot,
schema, config, or graph change, so no definition-version tier or config
migration is needed. An in-flight workflow gets the new selection on its next
routing pass, which is the intended effect of the request.

## Risks / Trade-offs

- **A confidently-wrong JEV pick is now always pinned.** → The user explicitly
  asked for this. The decision record and `routing.classified` event still carry
  the label and confidence, so a bad pick is auditable after the fact; the removed
  safety net is exactly what was requested.
- **Fewer `attention` entries.** → The `attention` channel is no longer raised for
  a below-floor choice. This is intended; only a genuinely unusable answer (or a
  routing-apply failure) still records attention.
- **An unknown `choice` label with probabilities now selects argmax.** → Only when
  probabilities name an offered entry; otherwise the tagged default is kept. This
  is strictly closer to "most probable".
- **`confidentChoice` is exported and referenced by tests.** → Update
  `test/workflow-classifiers.test.ts` to assert confidence is ignored in both
  selection and telemetry.

## Migration Plan

One change: edit `classifiers.ts` and any consumer wording, update the demo
decision record and the focused tests, and refresh the one architecture sentence.
Validate with `bun test test/workflow-classifiers.test.ts`, `bun run type-check`,
`bun run lint`, and `bun run build` in `agentic-coding/`. Rollback is a revert of
the module change; there is no stored-data or configuration migration.

## Open Questions

None.

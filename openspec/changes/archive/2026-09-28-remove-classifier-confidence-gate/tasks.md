## 1. Classifier protocol

- [x] 1.1 Remove `SINGLE_CONFIDENCE_FLOOR` and the `confidentChoice` predicate from `agentic-coding/src/workflow/classifiers.ts`; confirm nothing else references them.
- [x] 1.2 Rewrite `selectSingleEntry(entries, answer)` to drop the `floor` parameter and resolve in order: an explicit `choice` naming an offered pool entry, else the offered entry with the highest `probabilities` value, else the tagged `default` plus an `attention` note. Do not read `confidence`.
- [x] 1.3 Confirm `buildRoutingDecisionSummary` reports `fallback` only for a genuine no-usable-answer case (it derives from `selectSingleEntry`'s `attention`) while still exporting `confidence`.

## 2. Consumers

- [x] 2.1 Check `applyPoolRouting` in `agentic-coding/src/workflow/runtime/reducers/effect-result.ts`: `result.applied`, the recorded `attention`, and the decision record must follow the new selector with no special-casing; remove or adjust any text that names the confidence floor.
- [x] 2.2 Update the demo decision record in `agentic-coding/src/tui/dash/demo.ts` so a below-floor choice is shown as applied with no attention, keeping its `confidence` value.

## 3. Focused tests

- [x] 3.1 Update `agentic-coding/test/workflow-classifiers.test.ts`: a below-floor choice is applied with no attention; confidence above, at, and below the old floor selects the same entry; a probabilities-only answer selects the highest-probability offered entry; an unknown `choice` label with probabilities selects argmax; a no-usable-answer answer keeps the tagged default and records attention; remove the `confidentChoice` test.
- [x] 3.2 Assert in the routing decision summary that a below-floor choice is not counted as a fallback and still reports its label and confidence.
- [x] 3.3 Run the focused test file (`bun test test/workflow-classifiers.test.ts` in `agentic-coding/`) and any routing/reducer or telemetry test whose expectation referenced the floor.

## 4. Documentation

- [x] 4.1 Update the single-select routing sentence in `agentic-coding/docs/workflow-architecture.md` to state that the pinned profile comes from the classifier's chosen or most probable offered entry and that `confidence` is observed but not consulted.

## 5. Validation

- [x] 5.1 From `agentic-coding/`, run `bun run type-check`, `bun run lint`, and `bun run build` with zero diagnostics; do not hand-edit `src/workflow/embedded.generated.ts`.

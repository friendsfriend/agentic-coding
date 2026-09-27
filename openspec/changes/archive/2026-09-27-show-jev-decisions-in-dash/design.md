# Design

## Context

See proposal.md for motivation. The facts that shape this design:

- **Nothing about a classification survives today.** `workflow_outbox` persists
  only `payload_json` (`{ integration, phase }`), status, attempts and
  `last_error`; the System One answer never reaches the store. The single
  durable writer of workflow facts is the `effect.result` reducer
  (`src/workflow/runtime/reducers/effect-result.ts`), which mutates the
  snapshot. So the reducer is the only place a decision can be recorded
  without inventing a second store.
- **The reducer is not where the request is built.** `src/workflow/effect-runner.ts`
  assembles the pool entries, the classifier model, and the rendered `state`
  prompt, then calls `invokeRoutingClassifier`, which internally builds
  `renderRoutingState(...)` and `routingRequest(...)` and returns only the
  answers map. The input therefore has to be handed back to the caller to
  reach the reducer at all.
- **The input is large and the snapshot is small.** Artifacts are capped at
  96 KiB each and 256 KiB in total, while the snapshot already stores a
  64 KiB `metadata.task` and a 128 KiB bounded `developerDialogue` array.
- **The dashboard detail grid is full and specified.** `panel-grid.ts` is a
  pure 2-column × 2-row occupancy model: Change (0,0), OpenSpec (1,0, only
  while artifacts are listed), Agents spanning the right column. Both
  `dashboard-pane-grid` and `dashboard-panel-navigation` fix that geometry in
  their requirement text.
- **A scrollable detail surface already exists.** The dashboard's `verdict`
  modal takes `{ title, content, lines }`, is opened with
  `keymap.setData("modal.active", "verdict")`, scrolls through `verdictOffset`,
  and optionally renders Markdown — the OpenSpec artifact view and the
  verifier report both use it.

## Goals / Non-Goals

**Goals:**

- One durable record per classifier decision, written by the same command that
  applies it, so the record can never disagree with the routing it explains.
- A record shape keyed by classifier *integration*, so the next jev integration
  records into the same array and renders in the same panel.
- A dashboard panel that answers "what did the model see, what was it offered,
  what did it pick, and what was actually applied" without a second read path.

**Non-Goals:**

- Changing how a decision is selected, gated on confidence, or applied. The
  recording is a side effect of the existing `applyClassifierRouting` path.
- Reconstructing or back-filling decisions for workflows that already ran; the
  field is absent until a classification happens.
- A cross-workflow or historical decision browser, and any durable transcript of
  classifier *requests that failed* (a failed effect records attention through
  the existing mechanism).
- Exposing pool `criteria` verbatim as a separate display concern beyond what
  the record carries per option.

## Decisions

### D1 — Record the decisions in the workflow snapshot, written by the `effect.result` reducer

`WorkflowSnapshot` gains an optional `classifierDecisions: ClassifierDecisionRecord[]`
alongside `developerDialogue`, with a count cap and an aggregate byte cap
enforced when appending (drop oldest first) and re-validated in `decodeSnapshot`
exactly as the dialogue bound is. The dashboard then reads them through the
existing validated workflow view — no new file, no new read path, no staleness
handling, and legacy snapshots keep decoding because the field is optional.

*Alternative considered — a sidecar log file per workflow.* It would allow an
untruncated input, but it adds a second persistence surface, a second read path
through the dashboard's observation layer, and its own truncation/cleanup
story. Rejected: the snapshot already carries comparable bounded content
(`metadata.task`, `developerDialogue`) and survives restarts for free.

*Alternative considered — deriving decisions from the outbox.* The outbox never
stores the result, so the options and the answer are not recoverable. Rejected
outright.

### D2 — The effect result carries the request metadata; the reducer still derives the options

`invokeRoutingClassifier` returns `{ model, state, answers }` instead of just
the answers, so the effect handler's result becomes
`{ integration, phase, model, state, answers }`. The reducer reads `model` and
`state` from that result but **re-derives the options from the preset it already
loads** for `applyPoolRouting`, rather than shipping the question back. Two
consequences: the record's options are exactly the entries the routing used (a
single source of truth), and the result payload stays small apart from the
prompt text, which is in-memory only and never persisted by the outbox.

### D3 — One record per answered question, keyed by integration

A record is:

```
{ id, at, integration, phase?, questionId, model,
  input, inputTruncated,
  options: [{ label, profile, criteria? }],
  answer: { type, choice?, confidence?, probabilities? },
  result: { applied, profiles, attention? } }
```

`integration` and `phase` are the integration-defined discriminators (`routing`
and `plan`/`apply` today); `questionId` is the asked question's id (the step id
for routing). Nothing in the record is named after routing, so a second jev
integration appends rows to the same array and gets the same panel. One record
per question — not per request — is the unit the developer asked for and the
unit that has a single `options`, `answer`, and `result`.

The `result` is recorded from the same `selectSingleEntry` / `selectRosterEntries`
call the routing is built from, so `applied: false` plus `attention` is exactly
the below-floor / roster-collapse fallback the spec already mandates.

### D4 — Bound the stored input, mark truncation, never fail the workflow

`input` is truncated to a per-record byte cap with `inputTruncated: true`; the
append drops the oldest records when the count or aggregate cap would be
exceeded. Recording is best-effort and must never turn a successful
classification into a failed effect: an unrecordable decision is dropped, not
thrown, because a `model.classify` failure would strand the run at a routing
step. `decodeSnapshot` still rejects a snapshot that violates the bound, which
catches corruption rather than a normal write.

### D5 — Store each option's `criteria` as JSON

The model saw the criteria, so the record carries them. Pool config is JSON, so
a small normalize-to-`JsonValue` helper (JSON round-trip, `undefined` on
failure) keeps the snapshot honest without a recursive validator, and the
detail view can render the exact per-option text the classifier received.

### D6 — A third grid row, conditional on having decisions

`panel-grid.ts` becomes 2 columns × 3 rows: Change (0,0), OpenSpec (1,0),
Classifier (2,0), Agents spanning the right column. The Classifier cell is
occupied only while at least one decision exists, reusing the conditional-cell
model `movePanel` already implements for OpenSpec, so non-classifier-routed
workflows and pre-classification workflows keep their current layout and the
`?` help/footer stay free of a binding that does nothing.

The panel itself is a `SelectableList` mirroring `OpenSpecPanel`, with a
bounded `visibleRows` viewport and the full list selectable. Unshifted
`j`/`k`/`↑`/`↓` move the selection, matching the OpenSpec panel.

### D7 — Reuse the `verdict` modal for the decision detail

Enter on the focused row opens the existing scrollable `verdict` modal with
Markdown content and `verdictOffset` scrolling, exactly as the OpenSpec
artifact view does. A pure projection (`classifierDecisionDetail`) renders
metadata, the options table with each entry's probability and the chosen
label, the applied result and any attention note, and a fenced, scrollable
classifier input section. No new modal component, no new modal stack entry, no
new key layer.

### D8 — Panel naming stays integration-neutral

The panel is titled "Classifier" and each row leads with its `integration`, so
the surface reads correctly once a second jev integration exists. The keybind
action is "View selected classifier decision".

## Risks / Trade-offs

- **A truncated input is not the whole input.** The stored `input` is capped per
  record; the tail of a large plan artifact is not shown. → The cap is well
  above the request header (instruction, change, task) and the start of the
  first artifact, `inputTruncated` is rendered in the detail view, and the full
  plan artifacts remain one `o`-free keystroke away in the OpenSpec panel.
- **The snapshot grows.** A run that classifies can add tens of KiB to
  `snapshot_json`, which is rewritten on every command. → The caps are small
  and fixed, the count is bounded, and the field is optional so existing stores
  and rows are untouched.
- **Grid growth costs vertical space.** A third left-column row squeezes the
  Change panel on short terminals. → The panel is only present when there are
  decisions, its list viewport is small, and the Change panel keeps
  `flexGrow`/`minHeight: 0` so it degrades rather than overflowing.
- **Existing grid specs and their tests change.** `dashboard-pane-grid` and
  `dashboard-panel-navigation` fix the 2-row geometry, and `panelGrid` /
  `panel-navigation` / keybind-catalog tests encode it. → Those two capabilities
  get MODIFIED requirement deltas and the affected tests are updated in the
  same change, including the no-decisions case that must behave exactly as
  before.
- **`effect-runner` result shape change.** Anything decoding the
  `model.classify` result must tolerate the added `model`/`state` fields. → Only
  `applyClassifierRouting` consumes it, and it reads the fields defensively.

## Migration Plan

None required. The new snapshot field is optional and the view field defaults
to an empty list, so pre-existing workflow stores and rows read unchanged. Roll
back is a source revert: the field is ignored by any older reader and simply
stops being written.

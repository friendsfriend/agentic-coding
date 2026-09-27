# Proposal

## Why

The jev classifier currently decides which model profile runs every classifiable
step (`core.plan`, `core.verification`, …) with no way to inspect what it saw or
why it chose a profile. The System One request and its answer are never
persisted, so a developer whose run picks an unexpected model can only guess
from the pinned routing — the input, the offered options, and the model's answer
are all lost once the `model.classify` effect completes.

## What Changes

- Record every classifier decision the workflow makes as a durable, bounded
  decision record: the classifier input, the options that were offered, the
  model's answer, and the result that was actually applied to routing.
- Expose those records through the validated workflow view so the dashboard can
  render them.
- Add a focusable classifier-decision panel to the workflow dashboard detail
  view, listing one row per decision, and open a scrollable detail view for the
  selected decision.
- Widen the dashboard panel grid to a third row so the new panel is reachable by
  the existing `J`/`K`/`H`/`L` navigation, and document the new binding in the
  `?` help catalog and the panel footer.
- Shape the decision record around the classifier *integration* rather than the
  routing pass, so the next jev integration can record its decisions without a
  second persistence mechanism or a second panel.

## Capabilities

### New Capabilities

- `classifier-decision-records`: durable, bounded recording of each classifier
  decision — the input, the offered options, the answer, and the applied result
  — and its exposure through the validated workflow view.
- `dashboard-classifier-decision-panel`: the focusable dashboard panel that
  lists the workflow's classifier decisions and the scrollable detail view for
  the selected decision.

### Modified Capabilities

- `dashboard-panel-navigation`: the detail grid gains a third row, the new
  panel becomes a navigation target, and the help modal lists its activation
  binding.
- `dashboard-pane-grid`: the left column stacks a third panel below
  Change/OpenSpec and the Agents panel spans the full height.

## Impact

- Classifier protocol/runtime: the routing effect result carries the classifier
  model and the rendered request state, and the `effect.result` reducer records
  one decision per answered question into the workflow snapshot behind a count
  and content bound.
- Contracts: an optional decision-record type on the workflow snapshot, the
  workflow view, and the dashboard state, plus the view schema. Older snapshots
  and views without the field keep decoding.
- Dashboard: a new panel component, panel-grid geometry and navigation, panel
  selection state, the shared verdict/scroll modal for decision detail, the
  keybind catalog, and a pure projection for the decision rows.
- No new dependency, no schema migration for existing stores, and no change to
  how a decision is selected or applied.

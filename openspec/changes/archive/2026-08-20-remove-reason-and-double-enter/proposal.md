## Why

The dashboard repair modal forces developers to type a free-text reason before a repair can be dispatched, but no downstream consumer requires or uses that reason — it only adds friction. Separately, actions that use the `confirm`/`reason` confirmation modes (e.g. `core.completed` actions like "Create pull request" and "Close workflow", and workflow action confirmation generally) require pressing Enter twice ("Press Enter again to confirm ..."), which is an unnecessary extra step once the action is otherwise valid to dispatch. Removing both frictions speeds up common dashboard workflows without weakening any actual safety check (revision staleness checks, target validity, and reason text where still functionally meaningful continue to apply).

## What Changes

- **BREAKING**: Repair modal no longer collects or requires a reason. The reason input, its keystroke handling, and the "Repair reason is required" validation are removed from the repair modal UI and keymap layer.
- **BREAKING**: The engine's `applyRepair`/repair command path no longer requires a non-empty reason; repair may be dispatched with an empty/absent reason.
- **BREAKING**: The dashboard's workflow-action confirmation flow (`completed-picker` / available-actions modal) no longer requires a second Enter press for actions with `confirmation: 'confirm'` or `confirmation: 'reason'`. A single Enter (with reason text already typed, when the action still requires a reason) dispatches the action immediately. The "Press Enter again to confirm ..." intermediate state is removed.
- Repair modal title/help text is updated to no longer reference a reason requirement or a reason prompt.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `herdr-workflow-state-control`: The "Validated workflow repair" requirement no longer mandates a non-empty reason to repair a workflow; repair dispatch is driven by revision-checked target selection only.
- `dashboard-engine-integration`: The "Repair UI opens" scenario no longer describes a reason requirement gating dispatch. A new scenario documents that available actions with `confirm`/`reason` confirmation dispatch on the first valid Enter press instead of requiring a second confirming Enter.

## Impact

- Affected code: `src/tui/dash/App.tsx` (repair modal state/keymap/render, completed-picker keymap handler), `src/workflow/runtime.ts` / repair command path (reason parameter no longer required), any CLI/engine function backing `applyRepair`/`previewRepair` that currently validates reason presence.
- Affected specs: `herdr-workflow-state-control`, `dashboard-engine-integration`.
- No API/schema surface changes beyond making the repair reason field optional where it was previously required.

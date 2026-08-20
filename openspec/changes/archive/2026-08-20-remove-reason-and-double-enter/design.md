## Context

The dashboard TUI (`src/tui/dash/App.tsx`) has two modal interaction flows relevant here:

1. **Repair modal** (`repair` keymap layer, opened with Shift+O): lets a developer pick a compatible repair target with j/k, type free-text into `repairReason`, and press Enter to call `applyRepair(repo, change, revision, targetStep, reason)`. Enter is rejected with `"Repair reason is required"` if `repairReason().trim()` is empty. `applyRepair` forwards to `repairWorkflow` (`src/tui/dash/data.ts` → `src/workflow/runtime.ts`/engine), which dispatches an `operator.repair` command. That command is parsed by `commandContract` in `src/workflow/contracts.ts`, where `reason: text(input.reason, '$.reason', 2048)` enforces a non-empty, trimmed string. The CLI (`src/workflow/cli.ts`) also declares `reason` as a required flag for the `repair` command and documents it in usage text. The committed snapshot stores `repaired: { reason, fromStep, at }`, and `parseSnapshot` re-validates `reason` as non-empty text when reading a snapshot back.

2. **Available-actions confirmation** (`completed-picker` keymap layer, opened for `core.completed` and other multi/gated actions): each `WorkflowActionView` carries a `confirmation: 'none' | 'confirm' | 'reason'`. For `'reason'`, Enter is rejected until `actionReason().trim()` is non-empty. For any confirmation other than `'none'`, once past the reason gate (if applicable), the *first* Enter only sets `actionConfirmed(true)` and shows `"Press Enter again to confirm …"`; the actual dispatch (`runWorkflow(...)`) happens only on a *second* Enter while `actionConfirmed()` is already true. This double-Enter gate is client-side UI state only — the engine/CLI dispatch path (`runWorkflowAction` / `developer.action` command) has no concept of a two-step confirmation; it executes on a single `developer.action` dispatch.

Both frictions are additive UI/validation steps that do not correspond to any consumer requirement: nothing reads or displays the repair reason as an audit trail requirement beyond storing it, and no engine invariant depends on the extra confirmation keystroke (staleness is instead enforced by the revision check, which stays unchanged).

## Goals / Non-Goals

**Goals:**
- Repair can be dispatched from the modal with a single Enter press and no typed reason; an empty reason is accepted end-to-end (UI → `applyRepair`/`repairWorkflow` → `operator.repair` command parsing → stored snapshot `repaired.reason`).
- Available actions with `confirmation: 'confirm'` dispatch immediately on the first Enter (no intermediate "press again" state).
- Available actions with `confirmation: 'reason'` (e.g. `reject-plan`) keep requiring non-empty reason text, but dispatch immediately on the first Enter once that text is present — the extra confirming Enter is removed.
- Repair modal title/help text stop referencing a reason requirement.

**Non-Goals:**
- Changing which actions require a reason at all (only the repair modal's reason is removed; `reject-plan`/`review-comments` reason semantics are untouched).
- Changing revision-staleness checks, repair target validation, or any other safety invariant.
- Changing the `WorkflowActionView.confirmation` type values (`'none' | 'confirm' | 'reason'` stay as-is) — only the UI's handling of `'confirm'`/`'reason'` loses its second-Enter step.
- Renaming or removing the `reason` field from `operator.repair`'s wire shape or the stored `repaired.reason` snapshot field — it remains present but becomes optional/nullable rather than mandatory, to avoid a schema-breaking rename across CLI, contracts, and storage.

## Decisions

- **Keep `reason` as an optional field end-to-end rather than deleting it.** `operator.repair.reason` and `snapshot.repaired.reason` remain part of the shape (default `''` when not supplied) instead of being removed, because `WorkflowCommand`/`WorkflowSnapshot` are persisted/replayed contracts; dropping the field would require a schema/migration story that is out of scope. Validation changes from `text(...)` (non-empty) to a bounded, allow-empty string check.
- **Confirmation gating change is UI-only.** No change to `WorkflowActionView.confirmation` values or to `developer.action` dispatch on the engine side, since the double-Enter gate never existed there — it is purely `actionConfirmed` client state in `App.tsx`. This keeps the change scoped to `src/tui/dash/App.tsx`.
- **`'reason'` actions keep their reason requirement.** Only the repair modal drops its reason; other `'reason'`-confirmation actions (`reject-plan`) still require non-empty typed text before Enter dispatches — only the *second* Enter is removed for them, consistent with removing "press enter twice" while not touching the separate "reason required" concern for those actions (which the task did not ask to change).
- **CLI `repair` command:** drop `reason` from `REQUIRED_FLAGS.repair`/`FLAG_SCHEMA.repair` positionals-as-required and usage text so `--reason` becomes optional (defaults to `''` when omitted), keeping the flag name for backward compatibility with existing scripts that still pass it.

## Risks / Trade-offs

- [Risk] Removing the repair reason loses an audit breadcrumb explaining *why* an operator repaired a workflow. → Mitigation: `repaired.fromStep`/`at`/target step remain recorded; reason becomes optional context rather than a mandatory one, and nothing downstream currently displays or requires it.
- [Risk] Removing the "press Enter again" step for `'confirm'` actions (e.g. "Close workflow", "Create pull request") makes accidental double-tap Enter presses immediately trigger the action instead of the first press being a safe no-op. → Mitigation: revision-staleness re-check on dispatch still fails a stale action without mutation; this was already the primary safety net, the second Enter was only a UX debounce.
- [Risk] Existing tests/scripts that assert on `"Repair reason is required"` or `"Press Enter again to confirm"` message text will need updating. → Mitigation: covered explicitly in tasks.md.

## Migration Plan

No data migration needed. Existing stored snapshots with a non-empty `repaired.reason` continue to parse unchanged (non-empty is a subset of "allow empty"). No rollback concerns beyond reverting the UI/contract validation change.

## Open Questions

None.

## Context

`src/tui/dash/App.tsx` computes a `workflowStatus` memo that feeds the Change
panel's STATUS badge (rendered around the `Badge` with `text={workflowStatus().text}`).
Today it does two things at once:

1. Picks a phase label (`state.stepLabel ?? state.phase`).
2. If any agent (`data().agents`) has `status === "working"`, it *overrides*
   that label with a hardcoded word based on the busy agent's role
   (`"planner"` → "Planning", role ending in `"verifier"` → "Verifying",
   anything else → "Applying"), and flags the badge as `working: true` for
   the aurora animation.

Per-agent activity is already rendered in the Agents panel (each row shows
`agent.status` with its own animation), so the STATUS row's overlay is
duplicate information that also obscures the actual workflow phase.

## Goals / Non-Goals

**Goals:**
- STATUS row shows exactly one thing: the workflow's current phase label.
- Preserve the existing animated/static badge distinction as a visual cue for
  "workflow still in progress" vs. "workflow finished", without depending on
  any single agent's transient status.
- Keep the change confined to the dashboard rendering layer — no engine,
  data-loading, or persistence changes.

**Non-Goals:**
- Changing how agent status is displayed in the Agents panel.
- Changing phase label text/formatting itself (still `state.stepLabel ?? state.phase`, same as the header and Home list).
- Introducing a new terminal-phase helper if an equivalent concept already
  exists and can be reused as-is.

## Decisions

- **Replace `workflowStatus`'s branching logic with a direct phase readout.**
  `text` becomes `data().state.stepLabel ?? data().state.phase` unconditionally;
  the agent-lookup (`data().agents.find(agent => agent.status === "working")`)
  and the role-based text substitution are removed entirely. Alternative
  considered: keep the agent overlay but move it next to the Agents panel
  instead of removing it — rejected because the task explicitly asks to stop
  showing agent status here, not relocate it.
- **Badge `working` flag derives from workflow terminality, not agent activity.**
  Use the existing terminal-phase check pattern already present in `data.ts`
  (`["completed", "closed"].includes(phase)`, used for `archived` in
  `testDashboard`) to compute `working = !["completed", "closed"].includes(state.status ?? state.phase)`.
  Prefer keying off `state.status` when available (`"active"` vs `"completed"`/`"closed"`)
  since it already encodes terminality without re-deriving it from phase
  strings; fall back to the phase-string check only if `state.status` is
  absent. Alternative considered: always render the badge static (`working:
  false`) — rejected because it silently drops a genuinely useful "workflow
  still running" cue that doesn't require agent-status leakage to provide.
- **No new exported helper.** The logic is a two-line memo body inside
  `App.tsx`; extracting it to `data.ts` is unnecessary indirection for this
  size of change (YAGNI) unless another consumer needs the same "is workflow
  terminal" check — none currently does.

## Risks / Trade-offs

- [Existing test `test/dash/userActions.test.tsx` asserts on the transient
  "Verifying" text produced by the old overlay] → Update the assertion to
  wait on the actual phase value shown at that demo step (`verify`) instead
  of the removed synthetic label. Covered as an explicit task.
- [Losing the "working" animation nuance if `state.status` is missing on some
  data source] → Fall back to the same terminal-phase string list already
  used elsewhere in `data.ts`, so behavior degrades to the same check used
  for `archived`, not to "always static".

## Migration Plan

Single-PR, no data migration: it's a pure rendering change in one component.
No rollback concerns beyond reverting the diff; no persisted state or schema
is touched.

## Open Questions

None — behavior, ownership, and test impact are fully determined by the
existing code paths inspected above.

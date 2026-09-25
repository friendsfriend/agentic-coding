# Design

## Context

`NewWorkflowModal.tsx` gates existing-change selection on the literal
`values().workflowType === "openspec-apply"` in three places: the effect that
prefetches change ids, the workflow-id completion choices, and `listStep()`.
`openspec-jev-apply` shares the CLI's pre-existing-change validation
(`validateStart` treats it identically to `openspec-apply`) but is not listed in
those comparisons, so it falls back to a free-text workflow id. See proposal.md
for motivation.

## Goals / Non-Goals

**Goals:**
- Give `openspec-jev-apply` the same discovered change picker as
  `openspec-apply`, reusing the existing fetch and list rendering.
- Centralize the classification so the three call sites cannot drift apart.

**Non-Goals:**
- Changing how changes are discovered, fetched or validated.
- Affecting `openspec-jev`'s task-input behavior (covered by the companion
  change) or any other workflow type.

## Decisions

1. Introduce one `APPLY_TYPES` set naming the existing-change workflows
   (`openspec-apply`, `openspec-jev-apply`) and use it at all three call sites.
   This removes the repeated literal and makes the set the single source for
   the change-selection decision. Alternative considered: keep the three
   `=== "openspec-apply"` comparisons and add an `|| === "openspec-jev-apply"`
   to each. Rejected because it duplicates the classification three times.
2. Leave the field order and `TASK_TYPES` membership untouched. Both apply
   variants already produce `workflowType`, preset, ticket, workflow id, mode;
   only the workflow-id input kind changes.

## Risks / Trade-offs

- [The prefetch effect must not run for non-apply types] → The `APPLY_TYPES`
  check replaces the existing guard, so non-apply types keep their current
  no-fetch behavior; the added test asserts a non-apply type keeps the
  free-text input.
- [Discovery reads the repository asynchronously] → It already does for
  `openspec-apply`; `discoverChangesLocal` remains the transport-less fallback,
  so the same paths are exercised.

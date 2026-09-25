# Design

## Context

`NewWorkflowModal.tsx` derives the wizard's field order from a single
`TASK_TYPES` set: a type in the set gets the `task` field, and every other type
is treated as selecting an existing OpenSpec change. `openspec-jev` was never
added to that set, so it falls into the change-selecting branch and loses the
task step. The same file special-cases `openspec-apply` for change discovery,
so the set is the only classification that decides task-driven versus
change-selecting. See proposal.md for motivation.

## Goals / Non-Goals

**Goals:**
- Restore the task step for `openspec-jev` with the same field order and
  checkout behavior as `openspec-full`.
- Keep the submitted launch input unchanged in shape: the task text travels
  through the existing `WorkflowLaunchInput.task` into the existing start
  boundary, with no new transport or validation.
- Preserve every other type's field set.

**Non-Goals:**
- Fixing `openspec-jev-apply`'s missing existing-change picker; that is a
  separate well-scoped follow-up proposal.
- Changing engine, registry, CLI `validateStart`, or any workflow semantics.

## Decisions

1. Add `openspec-jev` to the existing `TASK_TYPES` set rather than introducing
   a new classification table or a registry-metadata field. The set is already
   the form's single source for this decision, and the engine contract does not
   differ between `openspec-full` and `openspec-jev` at the form boundary.
   Alternative considered: a per-catalog flag on `PUBLIC_WORKFLOW_CATALOG`.
   Rejected as a larger, cross-cutting change for a one-line omission.
2. Keep the task optional for `openspec-jev`, matching `openspec-full`. The
   existing `canSubmit` gate requires a task only for `wiki`, `research`,
   `quick`, and `no-openspec`, and `validateStart` enforces the same set, so no
   additional required-field logic is added.

## Risks / Trade-offs

- [The same classification may hide another type] → The change adds focused
  test coverage for `openspec-jev` and keeps the existing `openspec-apply`
  task-free assertion, so the change-selecting branch stays verified.
- [Field-count assumptions in existing navigation tests] → Add assertions
  around the `openspec-jev` journey specifically; existing tests navigate to
  other types and are left intact.

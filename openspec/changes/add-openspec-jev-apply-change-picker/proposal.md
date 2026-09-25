# Proposal

## Why

The contextual "New workflow" form only recognizes `openspec-apply` when it
decides whether the workflow-id step is a discovered OpenSpec change picker:
the change fetch, the completion list and the list-step detection all hard-code
that one id. `openspec-jev-apply` starts from a pre-existing validated change
exactly like `openspec-apply` does, so the form asks the user to type a change
id by hand, offers no discovered candidates, and never reads the repository's
change list. The workflow still starts, but the launch experience is
inconsistent with the non-JEV apply flow.

## What Changes

- Treat `openspec-jev-apply` as an existing-change workflow alongside
  `openspec-apply` in the new-workflow form, so the workflow-id step becomes a
  discovered change picker backed by the same fetch.
- Replace the repeated `workflowType === "openspec-apply"` comparisons with one
  explicit set of existing-change workflow types, so both apply variants share
  the behavior and a future variant is not silently missed.
- Keep the field order, task-free field set and checkout-mode behavior for both
  apply variants unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `contextual-workflow-launch`: the form must present discovered existing
  OpenSpec changes for every workflow type that applies a pre-existing change,
  including `openspec-jev-apply`.

## Impact

- `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` — the three
  `openspec-apply` comparisons that gate change discovery, completion choices
  and list-step rendering.
- `agentic-coding/test/dash/newWorkflowModal.test.tsx` — add coverage that
  `openspec-jev-apply` renders the discovered change list and submits the
  selected change id.
- No change to the workflow engine, registry, CLI start validation, or the
  `openspec-jev` task-input fix.

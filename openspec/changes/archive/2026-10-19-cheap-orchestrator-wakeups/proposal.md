## Why

A wake-up in the Home orchestrator conversation is expensive because it is
large, guesses, and fails. Measured in the efficiency corpus
(`docs/efficiency/02h-orchestrator.md`, backlog item 21): `start_workflow` was
called 54 times for 44 workflows with **163,350 B of arguments, 93 % of it the
`task` text** — prose the developer had already written, paid again as output
tokens and re-carried on every later turn. `read` failed 24 of 41 times, **22 of
them ENOENT**, because the orchestrator guessed
`openspec/changes/<id>/proposal.md` paths in five repositories; nothing could
tell it whether a change exists. Polls used the wrong id
(`add-environment-instances` for the real `add-environment-instance-lifecycle`),
because `list_workflows` and `workflow_status` did not agree on one identifier
to carry between them. 12 of the 54 starts were refused, 8 of them "working
tree must be clean".

Compaction and the compact poll already shipped (backlog items 4 and 5); what is
left is the *input* side and the *guessing*: the model re-types what it can
reference, and it probes for facts a primitive should answer.

## What Changes

- **`start_workflow` takes a task reference instead of the text.** A reference is
  either an OpenSpec change in the target repository (a change id or a path, the
  server resolves it to that change's `proposal.md` + `tasks.md` as the task) or
  "the previous developer message" (the host substitutes the session's own last
  developer message). The resolved change id and the resolved task length are
  echoed in the start answer, so a reference that resolved to the wrong change is
  visible instead of silent; a reference that does not resolve is refused with
  the candidate change ids. Inline `task` keeps working unchanged, and every
  reference goes through the same start guard, the same preset/branch rules and
  the same human reviews.
- **An existence/listing primitive for a repository's OpenSpec changes.** One
  new orchestrator tool answers compact rows — change id, title, task progress,
  the change's path and the workflow already implementing it — from the
  repository's `openspec/changes` directory only, so the orchestrator stops
  probing for `proposal.md` and stops guessing whether a change exists.
- **One identifier across the workflow tools.** `workflow_status` accepts the
  `workflowId` that `list_workflows` returns without also being handed the
  repository, and an unknown id answers with the closest existing ids instead of
  a dead end.
- **Keyed multi-id polls.** `workflow_status` takes several ids in one call, each
  with its own `sinceRevision`, and answers compactly per id — an unchanged
  workflow still costs a few bytes, and a single id answers exactly the row it
  answers today.
- **The clean-tree refusal stays bounded but informative.** The refusal already
  names the dirty paths (count plus a bounded list, no file contents); this
  change locks that behavior with a test and keeps the rule unchanged.

Nothing in the store moves: `STORE_SCHEMA_VERSION` stays 6, there is no
migration and no compatibility shim. Results do not grow: the listing is a new
opt-in tool, the added `start_workflow` echo appears only on a start, and a
status answer for one id keeps its current shape byte for byte.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: the orchestrator tool surface gains a task reference on
  `start_workflow`, a repository change listing, and one workflow identifier the
  list and the status poll share — with keyed multi-id polls and candidate
  answers for an unknown id.

## Impact

- `src/agent-host/orchestrator.ts` — tool parameters and descriptions for
  `start_workflow`, `workflow_status`, and the new `list_changes`; the
  previous-message substitution and the reference echo.
- `src/agent-host/orchestrator-resolve.ts` (new) — pure id/reference helpers:
  closest-id ranking, workflow-id → repository resolution over the workflow
  board, per-id `sinceRevision` decoding.
- `src/agent-host/host.ts` — the run context carries the session's last
  developer message (a getter, no new store, no new state on disk).
- `src/workflow/startup.ts` — `resolveTaskReference` (change id or path →
  bounded task text, refusal with candidates) called from
  `prepareWorkflowStart`; the existing `cleanTreeRefusal` stays as it is.
- `src/contracts/actions.ts` — `workflowStartRequestSchema` gains an optional
  `taskRef: { change }`.
- `src/server/operations/observations.ts` — one additive observation
  (`{ kind: "openspec-changes", repo }`) answering the compact rows; the
  existing `{ kind: "changes" }` id list the dashboard reads is untouched, as is
  the orchestrator capability's route allowlist (the observe route is already
  allowed).
- Tests: `test/agent-host-orchestrator.test.ts`,
  `test/agent-host-orchestrator-compact.test.ts`, new focused tests for the pure
  helpers, the observation and the start-reference refusal.

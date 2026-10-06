# Proposal

## Why

The orchestrator only learns about a workflow when the developer asks. A
workflow it started can wait on a plan approval for an hour, park in
`attention-required` after a failed effect, or complete — and nobody is told
until the developer happens to look. "Manages my workflows" needs the
orchestrator to be woken by workflow transitions, and the developer to be
pointed at reviews that are waiting on them.

## What Changes

- A shell-owned **workflow monitor** subscribes to the server's workflow events
  while the shell runs, re-reads the affected workflow, and detects transitions
  with a pure detector.
- Transitions that need the developer (a review step entered, a developer
  question pending) raise a shell notification naming the workflow and step.
- Transitions the orchestrator can act on or should report (attention required,
  failed effect, completed, review waiting) are delivered to the active
  orchestrator session as one bounded, coalesced follow-up note.
- `[agents.orchestrator] monitor = "wake" | "notify" | "off"` (default `wake`)
  controls whether notes reach the session, only notifications are raised, or
  nothing happens.
- Scope: workflows started by the orchestrator (requires
  `attribute-orchestrator-actions`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `home-orchestrator`: adds workflow monitoring and session wake-ups.

## Impact

- New `agentic-coding/src/tui/orchestrator/monitor.ts` (subscription, coalescing,
  delivery) and a pure `src/tui/orchestrator/transitions.ts` (detector).
- `src/tui/orchestrator/session.ts` (ensure host without opening the page).
- `src/tui/otel/app/App.tsx` / `src/tui/index.tsx` (start/stop with the shell).
- `src/workflow/profiles.ts`, `src/server/config.ts` (`monitor` key),
  Settings inventory and the Orchestrator model picker row.
- Depends on `attribute-orchestrator-actions` (`startedBy`).

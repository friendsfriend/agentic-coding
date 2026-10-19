# Deduplicate and digest the monitor notes

## Why

The efficiency corpus holds 86 monitor notes (17.3 kB). The three delivery notes
repeat one workflow id **12 times each**, and a note costs far more than its
201 B: 38 of the 86 turns that follow a note only poll (`$9.07`), 20 make no call
at all, and each of those turns lands on a cold cache — so the note's real price
is the turn it wakes, not its bytes.

Two properties of the current delivery make that price unavoidable:

- the note format is **one line per event**, so a repeated failing effect prints
  the same workflow id and step twelve times;
- the implicit `default` subscription is `wake`, so a burst of info progress
  wakes the session for information it never asked for.

## What Changes

- **One line per (workflow, step, effect), with an attempt count.** The line keeps
  its documented shape `- <workflowId> → <stepId> (<what changed>)` and gains a
  ` ×N` suffix when the same workflow, step and change repeated inside the note.
  The elision count still counts events, not lines.
- **The `default` subscription delivers as a digest** (one note per interval, one
  minute) instead of an immediate wake per event. The digest batches **info
  progress only**: an event whose severity is `warning` or above, an id that names
  a wait/block/failure/review/question, and a workflow's `workflow.completed` /
  `workflow.closed` ride the existing 10 s wake window, so a digest never delays
  what the orchestrator must hear promptly.
- **A pure no-op note is absorbed.** A note whose every line is info progress no
  contributing subscription named in `eventIds`/`categories` is not delivered: its
  events stay recorded and readable with `read_events`, and the session is not
  woken for it. The delivery frame carries one additive, optional `explicit` flag
  per matching subscription so the shell can tell "asked for" from "caught by a
  broad filter".
- **Explicit subscriptions are unchanged**: the orchestrator's own `wake`,
  `digest` and `silent` subscriptions keep their requested mode, filters and
  cadence overrides.
- No new event id, no new state, no store schema change (`STORE_SCHEMA_VERSION`
  stays 6), no migration and no compatibility shim, and no change to the server's
  notification path for human-needed events.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `workflow-event-subscriptions`: the implicit default subscription is a short
  digest whose immediate events are never delayed, and a note is one counted line
  per (workflow, step, change) with a no-op note absorbed rather than delivered.

## Impact

- `src/contracts/workflow-events.ts` (the delivery class of an event, the
  default-digest interval, the optional `explicit` flag on a delivery match).
- `src/server/workflow-events.ts` (`defaultSubscription` is a digest; the
  `filterNamesEvent` predicate), `src/server/workflow-event-bus.ts` (the frame
  carries the flag).
- `src/tui/orchestrator/delivery.ts` (line grouping with counts, the per-event
  window, absorption), `src/agent-host/orchestrator.ts` (the prompt sentence for
  the count suffix and the absorbed note), `docs/orchestrator.md`.
- Tests: `test/orchestrator-monitor.test.ts`, `test/workflow-events.test.ts`,
  `test/workflow-event-bus.test.ts`, `test/orchestrator-subscriptions.test.ts`.

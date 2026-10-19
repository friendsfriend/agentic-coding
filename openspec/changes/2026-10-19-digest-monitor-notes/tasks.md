# Tasks

## 1. One counted line per (workflow, step, effect)

- [x] 1.1 Group a note's events by (workflow, step, rendered change) in the pure
  planner (`src/tui/orchestrator/delivery.ts`), keep the documented
  `- <workflowId> → <stepId> (<what changed>)` prefix, append ` ×N` when the same
  change repeated, and keep the elision count counting events.
- [x] 1.2 Cover it with planner tests: twelve identical `effect.failed` events plus
  two distinct changes produce three lines, a 100-identical-event storm produces
  one counted line, and a storm of distinct changes is still capped with an exact
  remainder.

## 2. The default subscription is a short digest

- [x] 2.1 Classify every event as `immediate`, `completion` or `progress` in the
  contract (`workflowEventDeliveryClass`): severity `warning` or above, or an id
  naming a wait/block/failure/review/question, is immediate; a workflow's
  `completed`/`closed` is a completion; everything else is progress.
- [x] 2.2 Deliver the default subscription in `digest` mode with a one minute
  interval (`DEFAULT_SUBSCRIPTION_DIGEST_MINUTES`), and give a digest subscription
  the wake window for an immediate event or a completion and its own digest window
  for progress, so nothing waits for the interval.
- [x] 2.3 Tests: a digest subscription holds info progress back while a blocked run
  closes on the wake window, a completion is delivered on the wake window, the
  default subscription's own test pins its mode/interval, and a bus frame test
  pins the mode the frame carries.

## 3. A no-op note is absorbed

- [x] 3.1 Carry one additive, optional `explicit` flag per delivery match (true
  when the subscription named the event id or its category), computed by the bus
  through `filterNamesEvent`.
- [x] 3.2 Absorb a note whose every line is info progress no contributing
  subscription named: drop the entries, deliver nothing, and count them; deliver a
  note whole when even one line is wanted.
- [x] 3.3 Tests: absorption with a broad filter, delivery of the named progress,
  the mixed note delivered whole, and a monitor-level test that a no-op frame
  wakes no session while the next completion does.

## 4. Docs, prompt and verification

- [x] 4.1 Update the orchestrator system prompt's note sentence (count suffix, the
  default digest, the absorbed note) and assert the new wording in the prompt test.
- [x] 4.2 Update `docs/orchestrator.md`: the default subscription is a one minute
  digest with immediate events, the note is one counted line per (workflow, step,
  change), and a no-op note is absorbed.
- [x] 4.3 Measure the change: a reproduction that feeds the item's baseline note
  shapes through the real planner shows six identical `effect.failed` lines
  (349 B) collapsing to one counted line (88 B) and a twelve-line one-workflow
  note (582 B) to eight lines (321 B), with a no-op progress note delivering
  nothing. The corpus-level figures (notes per hour, the cost of the turns that
  follow a note) need the efficiency dataset reader, which a parallel workflow
  owns, so this change does not touch `scripts/efficiency`.
- [x] 4.4 `bun run type-check` 0 errors, `bun run test` 248/248 jobs (3746 tests)
  pass, `bun run lint` exits 0, `openspec validate --changes --strict` passes
  (10 items).

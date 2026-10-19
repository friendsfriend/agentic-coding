## 1. The attempt budget in the step behavior

- [x] 1.1 Add the two-attempt budget to `core.archive` in
  `src/workflow/steps/lifecycle.ts`: `ARCHIVE_ATTEMPT_LIMIT`, the
  `loopCounts` keys, `onArrive` counting an engine arrival into the step (the
  graph entry, or the failed attempt's own self-loop), `onEnter` consuming the
  arrival marker and starting a fresh pair when the entry did not come from a
  transition.
- [x] 1.2 Spend the budget in `onAgentComplete`: a `blocked` attempt with budget
  left requests the `blocked` transition (the one repair round) and exports the
  `archive.repair_round` decision event; the last attempt returns no completion,
  so the blocked handoff parks the workflow instead of leaving it active with no
  run.
- [x] 1.3 Render the attempt in `assignmentInputs` and `handoffNote`: the attempt
  number and its duties (attempt 1 repairs nothing; attempt 2 fixes only
  structural merge markers), the single-pair check, and the instruction to hand
  over the validator output verbatim within the handoff contract's bound.

## 2. The parked detail

- [x] 2.1 Redact the `attention` detail a `blocked` handoff parks with in
  `src/workflow/runtime/reducers/agent-handoff.ts` (`redactTelemetryText`), and
  document that the handoff contract's 4096-byte `message` field is the size
  bound that keeps a transcript from arriving unbounded.

## 3. Instructions, telemetry and docs

- [x] 3.1 State the budget in `agent-definitions/instructions/archive.md` and
  regenerate `src/workflow/embedded.generated.ts` with
  `bun run scripts/generate-embedded.ts`.
- [x] 3.2 Add the `archive-attempts` query to
  `scripts/efficiency/lib/queries.ts`: archive runs per snapshot with turns,
  calls, handoff outcome and the 12-call ceiling flag.
- [x] 3.3 Record the budget, the counter, the parked detail and the reset rule in
  `docs/workflow-architecture.md` (step ownership).

## 4. Verification

- [x] 4.1 `test/workflow-archive-attempts.test.ts`: a failed attempt grants
  exactly one repair round; the second failure parks with the redacted validator
  output and launches no third run; a detail beyond the handoff bound is refused
  and leaves the attempt unspent; a developer repair restores a fresh pair; the
  happy path still reaches delivery with one archive run; the behavior's own
  attempt rendering and repair-round decision.
- [x] 4.2 `bun run type-check` 0 errors, the focused tests pass, `bun run lint`
  is clean, and `openspec validate --changes --strict` passes.

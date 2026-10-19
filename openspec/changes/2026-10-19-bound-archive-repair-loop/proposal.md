## Why

Archive is the most expensive step of the OpenSpec tail when its one command
pair fails. In the measured corpus two archive runs spent 110 and 58 turns —
around 40 `openspec` invocations and 90 kB of output between them, 23% of that
family's archive turns — and both ended `attention-required` with an
`operator.repair` afterwards. The archive work itself is two commands; the cost
was an unbounded repair loop inside one run: validate, archive, re-derive the
failure, re-validate, re-archive, with no bound on how many rounds the run
spends and no rule that says which round it is on. The step's graph loop edges
bound the *step* (three entries) but not the attempt: each entry can itself
retry indefinitely, and a parked workflow's detail is whatever the run's last
message happened to be.

## What Changes

- Bound the archive step to **two `openspec validate`/`openspec archive`
  attempts per archive entry**: the entry itself and one structural repair
  round. A failed attempt hands off `blocked` and the engine re-enters the step
  once; the second failure hands off `blocked` and parks the workflow
  `attention-required` with no third attempt.
- State the budget in the step's own assignment and instruction asset: attempt
  1 repairs nothing, attempt 2 fixes only structural merge markers (missing
  `## MODIFIED Requirements`/`## REMOVED Requirements` sections) and never
  rewrites requirement or scenario content, and a failure hands over the exact
  validator output.
- Park with the run's own validator output as the archive step's `attention`
  detail, redacted for known credential shapes by the handoff reducer. The size
  bound is the handoff contract's own 4096-byte `message` field, so a refused
  oversized detail leaves the attempt intact instead of persisting a transcript.
- Grant a fresh pair of attempts on a developer `operator.repair` or `resume`,
  which enters the step without an engine arrival, and report a granted repair
  round as an `archive.repair_round` decision event.
- Keep the happy path, the archive evidence check, the graph's `maxAttempts: 3`
  loop edges, and the `failed` outcome's retry exactly as they are. No snapshot
  schema change (`STORE_SCHEMA_VERSION` stays 6): the counter is step-local
  state in `snapshot.loopCounts`.
- Add the `archive-attempts` efficiency query over the imported telemetry
  (archive runs per snapshot with turns, calls, handoff outcome and the item's
  12-call ceiling flag) and document the budget in
  `docs/workflow-architecture.md`.

## Capabilities

### New Capabilities

- `workflow-archive-attempts`: the archive step's attempt budget, its
  assignment duties per attempt, the bounded redacted failure detail that parks
  the workflow, and the developer-repair reset.

### Modified Capabilities

None.

## Impact

- `src/workflow/steps/lifecycle.ts` (`core.archive` behavior: `onArrive`,
  `onEnter`, `onAgentComplete`, `assignmentInputs`, `handoffNote`),
  `src/workflow/runtime/reducers/agent-handoff.ts` (the parked blocked detail is
  redacted), `agent-definitions/instructions/archive.md` and its regenerated
  `src/workflow/embedded.generated.ts` pin.
- `scripts/efficiency/lib/queries.ts` (one new read-only query),
  `docs/workflow-architecture.md` (the step-ownership section), and a new
  focused engine test.
- No new effect, no new step, no new edge, no transition change, no migration
  and no compatibility shim. `STORE_SCHEMA_VERSION` stays 6; the definitions'
  archive loop edges and the `failed` retry are unchanged.

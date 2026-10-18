# TUI freezes and memory: what the main thread actually pays

Round three of "the TUI freezes and the developer suspects a leak" (workflows
`check-tui-freezing`, `fix-ui-lag-main-thread-work`, this one). Two earlier
rounds fixed individual main-thread costs; the report came back under heavier
load (5+ agent workflows, ~150 workflow records, a 180 MB trace database, the
server-side event bus with its reconcile ticks). This round measured first.

Everything below was measured with `scripts/tui-load-harness.ts` against
synthetic data in a temporary sandbox — never against the real store,
configuration or transcripts.

```sh
bun run scripts/tui-load-harness.ts --rounds 25        # the table below
HARNESS_SPANS=100000 bun run scripts/tui-load-harness.ts
```

The harness builds a store with 150 workflows (8 active and running, with runs,
effects, evidence, dialogue, classifier and gate decisions: 2.4 MiB of
snapshot JSON), one open workflow with 0.8 MiB of telemetry and 745 KiB of
committed verifier artifacts, then drives the real read paths and the real
telemetry stores in-process. It reports wall time per operation, the worst
event-loop block observed, and the bytes each operation allocates.

## Measured, per fix

| # | Operation | Scale | Before | After |
| --- | --- | --- | --- | --- |
| 1 | `listWorkflowViews` (the dashboard listing, and what the event bus calls on every reconcile tick and every debounced repository refresh) | 150 workflows | **97.7 ms** median, 102 ms worst block (115–128 ms in an earlier session) | **53.2 ms** (decode dedupe alone, same session) |
| 2 | the same listing, now three queries instead of ~600 statements | 150 workflows | 63.1 ms median, 75 ms worst block | **49.5 ms**, 52 ms worst block |
| — | five listings back to back (what a burst of `workflow.updated` costs) | 150 workflows | 489 ms | 254 ms |
| — | `decodeSnapshot` × 150 (the schema decode a listing pays **twice** per workflow) | 150 workflows | 36–54 ms per pass, twice per listing | once per listing |
| 3 | `TraceStore.pushBatch` (live OTLP spans) with one subscriber deriving the span tree, as a mounted view does | 100 000 spans in 1 000 batches | 5 663 ms, **1 000 notifications**, RSS +192 MB, heap +66 MB, everything retained | **19 ms**, **1 notification**, RSS +7 MB, heap +13 MB, 20 000 retained |
| 3 | `LogStore.pushBatch` (live OTLP logs) | 100 000 logs in 1 000 batches | 3 591 ms, RSS +173 MB, heap +75 MB, everything retained | **11 ms**, RSS +6 MB, 5 000 retained |
| — | `loadDashboard` for the open workflow (telemetry parse + verifier output reads and hashes + Git state) | 0.8 MiB telemetry, 745 KiB of verifier output | 11.4 ms median | unchanged (measured, not the freeze at this scale) |

Machine noise between sessions reached ±40 % on the decode microbenchmark, so
the table only compares measurements taken back to back in one session (the
`before`/`after` pairs above are from the same session each).

## The three causes that were confirmed

**1. Every snapshot was decoded twice per read.** `view()` decoded
`snapshot_json` and then `validateSnapshot()` serialised the snapshot, parsed it
and ran the same schema decode again, discarding the result. A 150-workflow
listing therefore paid ~300 schema decodes on the main thread per poll, on the
tick the event bus runs every 30 s and on every debounced repository refresh
after a committed effect. The cross-field invariants now live in
`validateDecodedSnapshot()`, and the read path validates the snapshot it already
decoded (`validateSnapshot` keeps its bytes-in behaviour for every other
caller).

**2. A listing was an N+1 read.** Per workflow: its instance row, its runs, its
effects, and an extra column read used only by the diagnostic fallback — ~600
statements for 150 workflows. It is now one query per table, grouped by
workflow, with the child reads still lazy behind thunks.

**3. The live telemetry stores grew without bound and notified per batch.**
`TraceStore` appended every live span for the life of the process (nothing ever
dropped one) and notified on every pushed batch, so a subscriber re-derived the
whole tree over an ever-growing array; `LogStore` re-filtered and re-sorted
everything it held on every batch; `MetricStore` never capped its list. The
receivers push into the process that renders the TUI, so at a few thousand
spans per second this was simultaneously the largest memory consumer and a
per-batch main-thread cost. Retention is now explicit (20 000 live spans beyond
the trace the view has open — which is never trimmed —, 5 000 logs, 20 000
metrics), notifications are coalesced per window, and a read still sees every
pushed record.

## A defect found on the way

`startWorkflowServer` passed the *getter* (`memoizedAgents(...)`) where the
event bus reads `maxEventsPerWindow`/`eventWindowMs` once, as numbers. At
runtime the storm guard compared a count against a function and re-created its
window on every call, so the guard never fired; it also failed `tsc` on main.
The values are resolved at construction now.

## What could not be reproduced

- **The freeze itself.** The harness runs the real read paths and the real
  stores, but not the renderer or a real terminal session; no synthetic run
  froze. The developer's own observation — *"one freeze happens when a handoff
  completes and I am viewing the session in the TUI, then I am stuck in that
  view"* — is the strongest lead and is **not** explained by the fixes above:
  those bound the *cost* of the paths behind the session view (dashboard
  observation, telemetry stores, event-bus listing), they do not prove that one
  of them was the block. The session transcript projection is already
  incremental and budgeted (`createAgentSessionProjection` /
  `streamAgentSessionProjection`, 8 ms slices), so the suspicion is the
  synchronous work *around* it: the dashboard observation that a handoff's
  events trigger, and the per-batch telemetry work above. Both are now timed and
  bounded, which is what makes the next occurrence attributable.
- **The ~720–850 MB startup baseline.** Not measured here: the harness never
  starts the renderer, and running the real TUI against synthetic data is
  outside this run's permissions. What is known is that a *fresh* process
  reached it within two minutes with small agent-host children, which points at
  the module graph plus eagerly opened stores rather than at the workflow data.
  The new memory sampler (RSS, heap, cache entry counts, once a minute) is what
  will show whether the baseline is allocation that stays or a cache that grows;
  `agentic-coding diagnostics --heap` is the follow-up if it grows.
- **Monotonic growth over hours.** The stores named above were the only
  unbounded accumulators this round could find that grow with events; the
  classifier cache, the file-text cache and the canonical-repository cache were
  already bounded by earlier rounds. Whether something still grows needs the
  developer's process, which is exactly what the sampler now records.

## What to capture on the next freeze

See `docs/diagnostics.md`. In short: leave the shell running, then

```sh
agentic-coding diagnostics --tail 50     # which section held the loop, and how often
sample <pid> 5 -file /tmp/tui.sample     # where the thread actually was
```

A freeze that produces no `lag` record means no wrapped section held the loop,
and the native sample is then the only evidence — send both, plus the footer's
`lag …ms ×N` reading.

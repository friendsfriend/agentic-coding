# Fixture snapshot

Hand-made, synthetic evidence directory for the efficiency tooling tests. It is
deliberately tiny and contains no real transcript, prompt, tool argument or tool
result text: the strings in the JSONL and SQL files are invented, and the
`*_secret` values exist only so the redaction tests can prove they never reach
the dataset.

Layout mirrors the real snapshot (see the builder's docs):

- `main-store/telemetry/legacy-wf.jsonl` — the legacy envelope, no run ids.
- `main-store/telemetry/span-wf.jsonl` — the span envelope with run ids.
- `main-store/telemetry/corrupt-wf.jsonl` — a truncated line, a non-JSON line, a
  JSON array and a record with no event name.
- `backend/telemetry/env-setup-demo.jsonl` — a second telemetry source.
- `backend/telemetry/compaction-demo.jsonl` — the compaction vocabulary of the
  cost ceiling: `runtime.compaction` envelopes carrying `kind`
  (`auto-ceiling`/`auto-overflow`/`manual`) and the usage that sets a run's peak
  context.
- `worktrees/span-wf/telemetry.jsonl` — the same file's workflow as seen from a
  worktree, plus a second run whose turn count differs from the main store.
- `sql/*.sql` — the SQLite fixtures (traces, harness, herdr), materialized by
  `test/efficiency/fixture.ts` into a temporary directory.

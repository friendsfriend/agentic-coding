---
name: herdr-openspec-test-verifier
description: Runs full project test suite after all parallel code reviews pass.
---

# Test Verifier

Read-only. Started only after security, AGENTS.md, quality, performance, and OpenSpec verifiers pass. Do not emit chat output; JSONL is durable handoff.

1. Read only `round-N-test-verifier-context.md` for the full-suite instruction, changed behavior, regression coverage, and any prior-round baseline evidence. Do not expand review scope beyond its changed files/diff.
2. Find repository’s standard full test command from root config, CI, and instructions. Run the full configured suite once, including required integration/e2e tests. Do not rerun changed tests with file/test-name filters when the full suite already covered them.
3. If the full suite fails:
   - Reuse matching prior-round baseline evidence from context without rerunning or reconfirming it.
   - Otherwise, only when a failure appears unrelated to changed behavior, one focused baseline reproduction is allowed to determine whether it predates the change. Preserve and restore the working tree in the same command; never discard or edit working changes.
   - A confirmed pre-existing unrelated failure is an `info` finding and permits PASS. An unconfirmed or introduced failure requires FAIL.
4. Write `.herdr-workflow/$HERDR_CHANGE_ID/reviews/round-N-test-verifier.findings.jsonl`:

```jsonl
{"type":"finding","severity":"warning","path":"src/example.ts","line":42,"detail":"missing regression coverage","evidence":"scenario has no covering test","fix":"add test"}
{"type":"verdict","verdict":"PASS"}
```

No passing verdict unless the full suite succeeds or every failure is confirmed pre-existing and unrelated.

5. Submit:

```bash
herdr-workflow verification-result --repo "$PWD" --change "$HERDR_CHANGE_ID" --role test-verifier
```

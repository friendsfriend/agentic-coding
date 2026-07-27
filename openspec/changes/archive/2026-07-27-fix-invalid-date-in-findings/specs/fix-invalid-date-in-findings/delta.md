# Delta: fix-invalid-date-in-findings

## Scenario A: DiffViewModal shows real timestamps

**Before**: Finding note in diff shows `"Invalid Date"` instead of time.

```
● Verifier  Invalid Date
  ❝ Some finding detail ❞
```

**After**: Finding shows relative time like `"2m ago"` or absolute date.

```
● Verifier  2m ago
  ❝ Some finding detail ❞
```

**Edge case — empty timestamp**: `formatTimestamp()` returns `"N/A"` instead of `"Invalid Date"`.

## Scenario B: Verifier only reports actual issues

**Before**: Quality verifier outputs findings like `"Code follows best practices"` alongside a PASS verdict.

```jsonl
{"type":"verdict","verdict":"PASS"}
{"type":"finding","severity":"info","path":"src/app.ts","line":42,"detail":"Code follows best practices","fix":""}
```

**After**: Same PASS verdict, zero findings (or only real issues).

```jsonl
{"type":"verdict","verdict":"PASS"}
```

## Scenario C: Verifier still reports real defects

**Before**: Security verifier finds an actual issue → still reported.

**After**: Still reported. Only the non-issue "implemented correctly" findings are removed.

## Scenario D: Consolidated findings carry timestamps

**Before**: `findings.json` entries have no `createdAt` field.

**After**: Each finding entry in `findings.json` includes `"createdAt": "2026-07-27T12:00:00"`.

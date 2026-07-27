# Design: fix-invalid-date-in-findings

## Overview

Two independent fixes for the verification cycle output quality.

## Issue 1: Invalid Date

### Root cause

`DiffViewModal.tsx` calls `new Date(timestamp)` with empty string timestamps from two sources:

1. **Developer review findings**: `App.tsx` constructs discussion notes with `created_at: ""` when mapping `DeveloperReviewFinding` objects into `Discussion` objects for the diff view.
2. **Verifier findings JSONL**: Verifier findings loaded from `.findings.jsonl` via `loadVerifierFindings()` also lack ISO timestamps; the consolidated `findings.json` has no `createdAt` field.

`new Date("")` produces an Invalid Date. `formatTimestamp()` does not guard against this → `date.getTime()` returns `NaN` → all relative-time comparisons are false → falls through to `date.toLocaleDateString()` which returns `"Invalid Date"`.

### Fix

**`DiffViewModal.tsx`** — Add a guard at the top of `formatTimestamp()`:
```ts
if (!timestamp || isNaN(new Date(timestamp).getTime())) return "N/A";
```

**`App.tsx`** — Replace `created_at: ""` with `created_at: new Date().toISOString()` in both places where discussion notes are constructed (developer comments and verifier finding notes).

**`commands.py`** — In `consolidate_findings()`, include `"createdAt": ctx.clock.now().isoformat()` in each consolidated finding entry.

## Issue 2: Non-issue findings

### Root cause

Verifier prompts tell agents to "Write JSONL findings plus final PASS/FAIL verdict". Without explicit guidance to exclude positive confirmations, some verifier models emit findings like "Code follows best practices" or "Implementation looks correct". These are not actionable issues and clutter the developer review.

### Fix

Append to each verifier role prompt in `prompts.py`:
```
Only report actual defects and issues. Do not include findings that merely confirm code was implemented correctly — if nothing is wrong, write only the PASS verdict with no findings.
```

Affected roles (all 7):
- security-verifier
- agents-verifier
- quality-verifier
- performance-verifier
- openspec-verifier
- usability-verifier
- test-verifier

## Data flow

### Issue 1 — Timestamp flow (current → fixed)

```
Verifier → writes findings.jsonl (no timestamp)
  → commands.py consolidate_findings() reads events
  → writes findings.json with createdAt (FIX)
  → loadDeveloperReviewFindings() reads findings.json
  → App.tsx constructs Discussion with created_at = finding's createdAt (FIX)
  → DiffViewModal formatTimestamp() handles real timestamps + guards invalid (FIX)
```

Developer comments (from `saveDeveloperReview`):
```
Developer → writes developer-review.json
  → App.tsx reads developer-review.json
  → constructs Discussion with created_at = now (FIX)
  → DiffViewModal shows real relative time
```

### Issue 2 — Prompt flow

```
Verifier prompt (appended with issue-only instruction)
  → verifier agent reads context + changed code
  → writes findings.jsonl with only actual defects (or empty + PASS verdict)
  → consolidation finds fewer/no garbage findings
```

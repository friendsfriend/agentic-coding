# fix-invalid-date-in-findings

Fix two verification cycle issues:
1. Findings always show **Invalid Date** in DiffViewModal
2. Verifiers report non-issue findings ("this was implemented correctly") instead of only actual defects

## What changes

### 1. Invalid Date fix
- `DiffViewModal.tsx` - guard `formatTimestamp()` against invalid/empty dates → show `"N/A"` instead of `"Invalid Date"`
- `App.tsx` - populate `created_at` with real ISO timestamps when creating developer review discussion notes and verifier finding notes
- `commands.py` - include `createdAt` timestamp in consolidated findings output

### 2. Verifier prompt cleanup
Update all 7 verifier role prompts in `prompts.py` to explicitly instruct: **only report actual issues/defects** — do not include confirmations that code was implemented correctly. Each prompt gets appended: `"Only report actual defects and issues. Do not include findings that merely confirm code was implemented correctly — if nothing is wrong, write only the PASS verdict with no findings."`

### Files changed
| File | Change |
|---|---|
| `agent-dash/src/devenv-ui/components/DiffViewModal.tsx` | Guard `formatTimestamp()` for invalid dates |
| `agent-dash/src/App.tsx` | Use real timestamps for discussion notes |
| `pi/lib/herdr_workflow/commands.py` | Add `createdAt` to consolidated findings |
| `pi/lib/herdr_workflow/prompts.py` | Append issue-only instruction to all verifier prompts |

## Non-goals
- No changes to triage, worker, planner, archive, or recovery prompts
- No changes to the finding schema validation in `findings.py`
- No change to verdict semantics — PASS/FAIL verdicts remain

## Risk
- Low. UI guard is defensive (only changes display of invalid dates). Prompt change is additive — existing verifiers already produce findings, this just stops garbage entries.

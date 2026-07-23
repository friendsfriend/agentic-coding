---
name: herdr-openspec-worker
description: Applies one approved OpenSpec change, asks persistent planner for clarification, and fixes verifier findings. Use only in worker pane of managed Herdr workflow.
---

# Herdr OpenSpec Worker

## Apply

1. Read fresh OpenSpec apply instructions and referenced artifacts.
2. Implement all tasks with minimum correct diff.
3. Ask planner when proposal intent is unclear:

```bash
herdr-workflow message --repo "$PWD" --change "$HERDR_CHANGE_ID" --from worker --to planner "<question>"
```

4. Run only focused tests covering changed behavior: affected test file/class/module or nearest existing regression test. Never run project-wide test suite; verifier owns that gate. Run relevant non-test build/lint/type checks when cheap.
5. If `openspec/changes/$HERDR_CHANGE_ID/tasks.md` exists (standard/direct-apply), after validating each implemented task immediately change its checkbox from `[ ]` to `[x]`. Do not defer checkbox updates until verification. If it does not exist (no-openspec), implement from `request.md` instead and skip checkbox tracking entirely.
6. If `tasks.md` exists, start verification only after every task is checked; the workflow rejects unfinished tasks. If it does not exist, start verification once the change is applied. Do not send an implementation summary—Git diff and OpenSpec artifacts are authoritative:

```bash
herdr-workflow verify --repo "$PWD" --change "$HERDR_CHANGE_ID"
```

Do not commit, push, archive, or spawn agents.

## Fix

Read only worker fix context path from handoff. Its stable critical/warning finding IDs are the fix checklist; do not reopen consolidated or raw verifier reports. Fix every listed ID, rerun focused tests covering each fix plus relevant non-test checks. Do not run project-wide test suite; verifier runs it. Then start next round with the same `herdr-workflow verify` command. Do not restate report or implementation in handoff. A failed final round, as configured by `workflow.max_verification_rounds`, pauses for developer instruction.

If context includes optional warning/info findings from a passing verification, choose which are worth addressing. Do not treat them as required. For every optional finding left unfixed, add its stable ID to `.herdr-workflow/$HERDR_CHANGE_ID/reviews/accepted-findings.json` as `{"ids":[...]}`, preserving existing IDs. Run focused validation for selected fixes, then start verification; no code change is valid when all optional findings are accepted.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Guessing unclear design | Creates proposal drift |
| Committing | Breaks archive-only commit policy |
| Running full suite | Duplicates verifier’s mandatory gate |

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

4. Run only focused tests covering changed behavior: affected test file/class/module or nearest existing regression test. Do not run standalone formatting, lint, type, full-build, or project-wide test commands; quality and test verifiers own those gates.
5. If `openspec/changes/$HERDR_CHANGE_ID/tasks.md` exists (standard/direct-apply), after validating each implemented task immediately change its checkbox from `[ ]` to `[x]`. Do not defer checkbox updates until verification. Otherwise skip checkbox tracking; implement from `.herdr-workflow/$HERDR_CHANGE_ID/request.md` only when it exists.
6. If `tasks.md` exists, start verification only after every task is checked; the workflow rejects unfinished tasks. Otherwise start verification once the change is applied. Do not send an implementation summary—Git diff and OpenSpec artifacts are authoritative:

```bash
herdr-workflow verify --repo "$PWD" --change "$HERDR_CHANGE_ID"
```

Output containing `triage started:` or `verification already running:` means handoff succeeded and ownership transferred. Stop immediately; never invoke `verify` again. Do not poll workflow status, call workflow help, inspect downstream review/state files, or wait with more tool calls. Triage and verifiers own next steps.

If verification is rejected by a workflow phase/base/state blocker rather than an implementation or task error, report the exact blocker in chat and stop. Never inspect Herdr/agentic-coding implementation source or read/change `.herdr-workflow/*/state.json` to bypass a gate.

Do not commit, push, archive, or spawn agents.

## Fix

Read only worker fix context path from handoff. Its stable critical/warning finding IDs are the fix checklist; do not reopen consolidated or raw verifier reports. Fix every listed ID and rerun only focused tests covering each fix. Do not run standalone formatting, lint, type, full-build, or project-wide test commands; quality and test verifiers own those gates. Then start next round with the same `herdr-workflow verify` command. Output containing `triage started:` or `verification already running:` means handoff succeeded: stop immediately and never invoke `verify` again; do not poll, inspect downstream workflow files, or wait with more tool calls. If a workflow phase/base/state blocker rejects it, report the exact blocker in chat and stop; never inspect workflow implementation source or read/change `.herdr-workflow/*/state.json`. Do not restate report or implementation in handoff. A failed final round, as configured by `workflow.max_verification_rounds`, pauses for developer instruction.

If context includes optional warning/info findings from a passing verification, choose which are worth addressing. Do not treat them as required. For every optional finding left unfixed, add its stable ID to `.herdr-workflow/$HERDR_CHANGE_ID/reviews/accepted-findings.json` as `{"ids":[...]}`, preserving existing IDs. Run focused validation for selected fixes, then start verification; no code change is valid when all optional findings are accepted.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Guessing unclear design | Creates proposal drift |
| Committing | Breaks archive-only commit policy |
| Running full suite | Duplicates verifier’s mandatory gate |

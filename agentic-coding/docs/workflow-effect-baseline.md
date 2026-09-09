# Agent task baseline for the Effect migration

The roadmap evaluates the migration by comparing two representative agent
tasks **before** and **after**: (1) add a handler with one transient failure
and cancellation, and (2) extend a validated command and its pure step
behavior. Improvement is judged by observed results, never a fabricated
productivity percentage. Correctness and compatibility remain mandatory
regardless of productivity results.

The baseline and final comparison runs are tracked as a **separate evaluation
change** (reclassified out of `adopt-workflow-effect-foundation`); this
primary change records the protocol template only.

## Protocol

Each run uses a disposable worktree of the repository at the
`feature/adopt-workflow-effect-foundation` base commit, the same model/version
for both the before and after legs, and records:

- **Model/version**: e.g. `opencode-go/deepseek-v4-flash`.
- **Available instructions**: which `AGENTS.md`/playbook files were linked.
- **Prompt**: the exact task text for each of the two tasks.
- **Checks**: the focused test command(s) and pass/fail.
- **Human corrections**: any steering given mid-run.
- **Failures**: transient failures observed and how they were recovered.

## Task A — add a handler with one transient failure and cancellation

Task text (before leg, phase 1): add a new outbox/effect handler kind with a
single transient failure on first execution and a cancellation path, plus a
focused test asserting the retry and cancel behavior.

## Task B — extend a validated command and its pure step behavior

Task text (before leg, phase 1): extend an existing validated workflow command
with a new optional field and extend its pure step behavior, keeping external
accepted forms and the contract identity/digest unchanged, plus a focused
test.

## Comparison

The final comparison (after phase 4) fills this template with the observed
results. If the comparison shows regressions or is inconclusive, the record
reports that honestly rather than claiming guaranteed productivity gain.

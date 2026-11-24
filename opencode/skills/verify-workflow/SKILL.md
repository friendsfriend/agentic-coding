---
name: verify-workflow
description: "Own an independent review, fix and re-review loop for an implementation, with or without OpenSpec."
---

Verify the implementation named in your assignment against its requirements. You
coordinate; you do not fix your own review.

Read the repository `AGENTS.md` first. Inspect the actual checkout and the
requested scope. Do not assume there is an OpenSpec change.

## 1. Establish the review boundary

Resolve the intended feature branch and base from the assignment or repository
metadata; if ambiguous, return BLOCKED rather than guessing. Resolve the merge
base and inventory the full feature diff against it, including pending tracked
edits and feature-owned untracked files; exclude unrelated dirty files. Record
base/head revisions and paths, including additions, deletions and renames. This
is the review boundary, not a repository-wide audit.

Choose the smallest useful set of independent reviewer agents:

- `openspec-verifier` for an OpenSpec change
- `code-quality-verifier`
- `security-verifier`
- `performance-verifier`
- `migration-verifier`
- `concurrency-verifier`

Give each reviewer an explicit assignment: base/head, the exact changed-file
list (old/new paths for renames and deletions), requirements and concrete checks.
Never send only a broad description or directory. Reviewers may read other files
for context but must report only defects introduced by the assigned changes.
Reviewers investigate, not edit.

Spawn each reviewer with `start_agent` in the same directory. End your turn after
spawning; their completion arrives here. Never poll.

## 2. Inspect every result

Failed or blocked reviewers are not a clean verdict. Reproduce blocking findings
against the assigned diff and requirements. Reject pre-existing, out-of-scope or
preference-only findings and explain each rejection. A broad check failure blocks
only when attributable to this feature; record unrelated baseline failures
separately.

## 3. Fix accepted blockers

If real blocking findings remain, spawn `openspec-fixer` with the exact accepted
findings, relevant requirement/artifact paths and scope. No unrelated
refactoring. Tell the fixer to run required checks and report exact outcomes; in
OpenSpec context it must also keep tasks/artifacts accurate. Do not ask a
reviewer to fix its own work.

## 4. Re-review

After the fixer completes, refresh the feature inventory and each reviewer's
explicit file list/diff, including feature-owned fix files. Spawn fresh reviewers
for affected concerns. A fixer's claim does not replace independent verification.
Repeat at most two fix rounds; unresolved blockers return to the caller.

## 5. Return

Return CLEAN only after reviewers report no blockers and required checks have real
successful results. Otherwise return BLOCKED with remaining issues, failed checks,
attempted fixes and decisions needed. Include findings accepted and rejected and
the reasons.

No archive, push, merge, deployment, credential changes or unrelated edits. If a
scope or architecture decision is needed, report it to the caller rather than
guessing.

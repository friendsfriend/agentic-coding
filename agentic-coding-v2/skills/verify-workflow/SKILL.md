---
name: verify-workflow
description: "Own an independent review, fix and re-review loop for any implementation, with or without OpenSpec."
---

Verify the implementation named in your inputs against its requirements. You coordinate;
you do not fix your own review. Read repository AGENTS.md first. Inspect the actual
checkout and the requested scope. Do not assume there is an OpenSpec change.

Use catalog for profiles and skills. Reuse your Topic and Repository values on every
spawn; workspace must be shared so reviewers and fixers see this implementation, not a
fresh checkout at HEAD. Use requestIds containing your Task ID and round to avoid
collisions with another verification run. End your turn after spawning: the engine
joins your children and resumes you with their outcomes. Never poll for completion.

1. Spawn an independent reviewer with skill review. Supply the requirements, scope,
   relevant paths, and any checks the caller requires. If the caller named an OpenSpec
   change, also spawn openspec-verify-change for artifact conformance. Generic review
   remains independent of OpenSpec. Neither reviewer may edit.
2. Inspect every result. Failed or blocked reviewers are not a clean verdict. Reproduce
   blocking findings against code and requirements; explain any finding you reject.
3. If there are real blocking findings, spawn skill code with the exact accepted
   findings, relevant requirement/artifact paths and scope. No unrelated refactoring.
   Tell the fixer to run required checks and report exact outcomes; in OpenSpec context
   it must also keep tasks/artifacts accurate. Do not ask a reviewer to fix its own work.
4. After the fixer completes, spawn fresh reviewers for the affected scope. A fixer's
   claim of success does not replace independent verification. Repeat at most two fix
   rounds; unresolved blockers then return to the caller, not an infinite repair loop.
5. Return CLEAN only after reviewers report no blockers and required checks have real
   successful results. Otherwise return BLOCKED with remaining issues, failed checks,
   attempted fixes and decisions needed. Include findings accepted/rejected and reasons.

No archive, push, merge, deployment, credential changes or unrelated edits. If a scope or
architecture decision is needed, report it to the caller rather than guessing. You can
be spawned as a task or opened as an interactive session; only ask the developer in the
latter. In a task, return the unresolved question as BLOCKED.

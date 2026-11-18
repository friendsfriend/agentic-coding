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

1. Establish the intended feature branch and target/base from the caller or repository/PR
   metadata; if ambiguous, return BLOCKED rather than guessing. Resolve their merge-base
   and inventory the full feature diff against it, not just HEAD's last commit or the
   working-tree diff. Include pending tracked feature edits and explicitly feature-owned
   untracked files; exclude unrelated dirty files. Record base/head revisions and paths
   (including additions, deletions and renames). This inventory is the review boundary,
   not a repository-wide audit; requirements and OpenSpec artifacts are context, not
   permission to expand it.
   Choose the smallest useful set of independent reviewers from catalog:
   performance-verifier, code-quality-verifier, migration-verifier, security-verifier,
   concurrency-verifier and openspec-verifier. These are lenses, not a mandatory panel;
   use review or another available skill when it fits better. Use openspec-verifier for
   an OpenSpec change. Give EACH reviewer an explicit assignment: base/head and pending
   edits being reviewed, its exact relevant changed-file list (old/new paths for renames
   and deletions), requirements and concrete checks. Pass the applicable diff or commands
   to obtain it. Never send only a broad feature description or directory as its scope.
   A reviewer may read other files for context but must report only defects introduced
   by the assigned changes, anchored to an assigned changed file/hunk and its observable
   consequence; pre-existing defects, unrelated cleanup and optional improvements are
   not findings. Missing tests or requirements must likewise be tied to the assigned
   change, not used to audit the rest of the repository. If a necessary changed file was
   not assigned, the reviewer returns a scope request; you decide whether to reassign it
   from the feature inventory. Parallelize independent reads and avoid duplicate checks.
   Reviewers investigate, not edit.
2. Inspect every result. Failed or blocked reviewers are not a clean verdict. Provider
   failures are not code defects: consider a suitable authorized alternative profile
   with a new requestId, or report the exact blocker instead of spawning a code fix. Reproduce
   blocking findings against the assigned diff and requirements. Reject pre-existing,
   out-of-scope or preference-only findings rather than passing them to a fixer; explain
   each rejection. A broad check failure blocks only when attributable to this feature;
   record unrelated baseline failures separately, not as feature defects.
3. If there are real blocking findings, spawn skill code with the exact accepted
   findings, relevant requirement/artifact paths and scope. No unrelated refactoring.
   Tell the fixer to run required checks and report exact outcomes; in OpenSpec context
   it must also keep tasks/artifacts accurate. Do not ask a reviewer to fix its own work.
4. After the fixer completes, refresh the feature inventory and each reviewer's explicit
   file list/diff, including feature-owned fix files. Spawn fresh reviewers for affected
   concerns; reconsider the selection if risk changes, but never expand into a general
   audit. A fixer's claim does not replace independent verification. Repeat at most two fix
   rounds; unresolved blockers then return to the caller, not an infinite repair loop.
5. Return CLEAN only after reviewers report no blockers and required checks have real
   successful results. Otherwise return BLOCKED with remaining issues, failed checks,
   attempted fixes and decisions needed. Include findings accepted/rejected and reasons.

No archive, push, merge, deployment, credential changes or unrelated edits. If a scope or
architecture decision is needed, report it to the caller rather than guessing. You can
be spawned as a task or opened as an interactive session; only ask the developer in the
latter. In a task, return the unresolved question as BLOCKED.

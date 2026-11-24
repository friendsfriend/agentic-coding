---
name: openspec-workflow
description: "Own one OpenSpec change from exploration to archive: explore with the developer, write the artifacts, and delegate apply, verification and archive to child agents."
---

You take one OpenSpec change from a half-formed idea to an archived change. You
talk to the developer; the implementation, independent verification and archive
run in child agents.

Use the environment-mcp tools for repository, app, service, status, log and
telemetry facts. Do not shell out to `docker` or `kubectl`.

## Worktree

Use one feature worktree per change. Create it after exploration and before
writing proposal artifacts, then move this conversation into it:

```text
create_worktree({ name: "<short-description>" })
move_session({ directory: "<returned directory>" })
```

The proposal, design, tasks and spec deltas are written in that worktree. Pass
the same `directory` to `openspec-apply`, `verify-workflow` and
`openspec-archive`. Do not create another worktree for the same change. A new
worktree is only for an independent workstream.

If worktree creation or the move fails, report the blocker and do not write
proposal artifacts in the original checkout.

## 1. Explore in this conversation

The idea may come from the developer or from the request. If it is present,
investigate immediately; never ask them to repeat it. If absent, ask what they
want to build.

Load `openspec-explore` and follow that stance: read specs, neighbouring changes
and code, discuss options, distinguish findings from assumptions, and do not
implement. Ask only questions whose answers change the work. Once the intent is
clear and the developer says to proceed, continue without a redundant approval
question.

## 2. Propose

Load `openspec-propose` and follow those instructions in this conversation. Use
the schema's artifact graph and `openspec instructions`, not a hardcoded list.
The idea and explore discussion are the input; do not make the developer repeat
them. Validate the change and fix validation issues before applying.

Report the change id, path and artifacts. If the developer asked to read the
proposal first, stop and wait; otherwise continue.

## 3. Apply

Spawn the implementation and end your turn:

```text
start_agent({
  agent: "openspec-apply",
  description: "Apply <change-id>",
  directory: "<same worktree>",
  prompt: "Apply the OpenSpec change <id> in <directory>. Read the proposal,
           design, tasks and spec deltas. Implement every task, run focused
           checks plus lint/type/build, and report changed files and exact
           outcomes. Do not commit, push, archive or spawn agents."
})
```

The child completion arrives in this conversation. Never poll.

## 4. Independent verification

Inspect the apply result; failure is not completion. Then spawn:

```text
start_agent({
  agent: "verify-workflow",
  description: "Verify <change-id>",
  directory: "<same worktree>",
  prompt: "Verify the OpenSpec change <id> in <directory> against its
           requirements, artifacts and implementation. Own independent review,
           fix and re-review. Report CLEAN or BLOCKED with real check results.
           No archive or push."
})
```

End your turn. `verify-workflow` owns the reviewer lenses and the fixer. Do not
run a duplicate repair loop here.

## 5. Read the verification outcome

Proceed only on a CLEAN result backed by independent review and required checks.
A BLOCKED outcome, failed child, unresolved decision or missing evidence stays
here for discussion with the developer. Never archive because the verifier
merely terminated.

## 6. Archive

Check it yourself first: `openspec status --change "<id>" --json` and the boxes in
`tasks.md`. A change with an unchecked task or an unfinished artifact is not
finished.

With nothing unchecked:

```text
start_agent({
  agent: "openspec-archive",
  description: "Archive <change-id>",
  directory: "<same worktree>",
  prompt: "Archive the completed OpenSpec change <id> in <directory>. Every task
           is ticked. Synchronize the verified delta specs to main specs before
           archiving. Do not skip syncing. Do not edit source. If anything is
           unfinished, stop and report what is missing."
})
```

## Commit and push

Do not commit or push unless the developer explicitly asks. If they do, inspect
the diff, stage only the change's exact files, commit the feature branch, and
push only that branch to the existing intended remote. Never force-push, merge,
alter remotes, use credentials from files, or push a protected/default branch.

## Reporting

One short report per phase: change id and path, worktree, what apply changed,
findings accepted and refused, archive path, and specs folded in. Never make the
developer reconstruct what happened.

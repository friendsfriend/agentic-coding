---

name: openspec-workflow
description: "Own one OpenSpec change from exploration to archive: explore with the developer, write the artifacts, and spawn the official OpenSpec skills for apply, verify and archive."
---

You take one OpenSpec change from a half-formed idea to an archived change. You are in a
conversation with the developer, so you talk to them; the work itself is done by
sub-agents you spawn, each running the official OpenSpec skill for its step.

Prefer a separate feature worktree for each new change, not the checkout this
conversation was opened in. Establish it with `feature_worktree` before creating
proposal artifacts or spawning implementation. Then spawn every sub-agent with
`workspace: "shared"`: they share THAT feature worktree and its `openspec/` artifacts,
not the original checkout. Follow the Workspace section below.

`catalog` is where your facts come from: the profile you run with, the configured
repositories and the topics that already exist. Pick one repository for the whole change
and one topic for it, and reuse both for every successor task so the tree stays one
change. Every spawn takes a stable `requestId`, so a repeated call cannot create a
second agent.

After you spawn, end your turn. When the task finishes its result arrives in this
conversation as a durable message — never poll `task_result`, and never treat your own
summary as evidence that the work happened.

## 1. Explore in this conversation

The initial idea is optional. It may come directly from the developer or be forwarded
by the original orchestrator through start_session inputs. If present, read it and
investigate immediately; never ask them to repeat it. If absent, ask what they want to
build and wait for their answer. This is ordinary conversation, not request_review.

Load the official instructions with catalog({ skill: "openspec-explore" }) and follow
that stance here: read specs, neighbouring changes and code, discuss options with the
developer, distinguish findings from assumptions, and do not implement. No tool
filtering: this is a prompt rule. Ask questions only when their answers change the work. Once the
intent is clear and the developer says to proceed (or the initial request already says
so), continue without a redundant approval question.

## Workspace

The default is a separate feature worktree for the whole change. Read-only exploration
may happen in the original checkout, but before creating any proposal or implementation,
call feature_worktree with a lowercase kebab-case name and the optional ticket supplied
by the developer. Do not skip this because later tasks use workspace shared: that mode
shares the directory you bind here. Do not invent a ticket or ask for one just to fill a field:

    feature_worktree({ name: "short-description", ticket: "ABC-123" })

The tool uses Worktrunk and moves this conversation into the returned directory. It
creates/reuses branch feature/ABC-123-short-description, or feature/short-description
without a ticket. Never shell out to git worktree or rename an unrelated branch. Use
an explicit base when the developer specified one; otherwise HEAD of the current
checkout is the starting point, never an assumed main/default branch. Check the
returned path and branch before writing, and report them to the developer. If worktree
creation fails, report the blocker; do not silently implement in the original checkout.

Stay in the current checkout only when the developer explicitly requests it, or when
continuing this same change in its already-established feature worktree. A request to
base work on the current v2 branch rather than main is not, by itself, a request to
edit the original checkout. An existing feature branch name alone does not establish
that the original checkout is isolated.
If resuming a change whose uncommitted artifacts or implementation are still in the
original checkout, do not switch and lose them or silently copy/stash/reset the work:
explain the situation and establish safe relocation or an explicit checkout exception
with the developer first.

Choose a unique short run key once and prefix every requestId below with it. This
keeps two features with the same change name in different repositories independent.
Reuse the same key on continuation/retry, never generate a new one per tool retry.

All later tasks use workspace shared: shared with THIS feature worktree, not the
original checkout. Do not create another worktree per phase. Repository still names
the configured repository; the runtime resolves shared cwd from this conversation.

## 2. Propose

Load catalog({ skill: "openspec-propose" }) and follow those official instructions in
this conversation. Use the actual schema's artifact graph and openspec instructions,
not a hardcoded list of artifact paths. The original idea and the explore discussion
are the proposal input; do not make the developer repeat them. Validate the resulting
change and fix validation issues before applying. Report its id, path and artifacts.
If the developer asked to read the proposal first, stop and wait; otherwise continue.

## 3. Apply

Spawn the implementation and end your turn:

    start_task({ skill: "openspec-apply-change", workspace: "shared", topicId, repository,
                 profile, requestId: "apply:<id>",
                 inputs: "Apply the OpenSpec change <id> in <directory>." })

## 4. Independent verification workflow

When apply reports back, inspect its actual outcome. Failure is not completion. Then
spawn the reusable verifier, rather than implementing a fix loop here:

    start_task({ skill: "verify-workflow", workspace: "shared", topicId, repository,
                 profile, requestId: "verify-workflow:<id>",
                 inputs: "Verify the OpenSpec change <id> in <directory> against its
                          requirements, artifacts and implementation. Own independent
                          review, fix and re-review. Report CLEAN or BLOCKED and real
                          check results. No archive or push." })

End your turn. The verify-workflow agent owns the reviewers and fixers and joins them.
It is reusable for non-OpenSpec work too; OpenSpec is context supplied in its inputs,
not its runtime or a requirement for using it. Do not run a duplicate repair loop here.

## 5. Read the verification outcome

Proceed only on a CLEAN result backed by independent review and required checks. A
BLOCKED outcome, failed task, unresolved decision or missing evidence stays here for
discussion with the developer. Never archive because the verifier merely terminated.

## 6. Archive

Check it yourself first — `openspec status --change "<id>"` and the boxes in `tasks.md`.
A change with an unchecked task or an artifact that is not done is not finished, whatever
the verifier said, and archiving it folds a spec delta into the main specs with nothing
behind it.

With nothing unchecked:

    start_task({ skill: "openspec-archive-change", workspace: "shared", topicId, repository,
                 profile, requestId: "archive:<id>",
                 inputs: "Archive the completed OpenSpec change <id> in <directory>.
                          Every task is ticked. Synchronize the verified delta specs to main specs before archiving; sync is authorized. Do not skip syncing. Do not ask anyone anything: if you find
                          something unfinished, stop and report what is missing." })

A task has no developer listening, so its skill's "ask the developer to confirm" branch
would end the turn unanswered — that check is yours, before the spawn.

## Commit and push

This feature workflow authorizes committing and a normal push of its own feature branch
to the repository's existing intended remote. After clean verification and archive,
inspect git status/diff, stage only the change's exact files, commit and push that branch
with upstream tracking. Never include unrelated work, force-push, merge, alter remotes,
use credentials from files, or push a protected/default branch. If the remote is
ambiguous, ask. If the developer requested local-only work, do not push. Report a push
failure honestly; do not broaden permissions to overcome it.

## Reporting

One short report per phase, in the developer's language, and never make them reconstruct
what happened: the change id and path, what apply changed, the findings you accepted and
refused, the archive path and the specs it folded in. Never deploy, install services, rotate credentials or touch unrelated work.

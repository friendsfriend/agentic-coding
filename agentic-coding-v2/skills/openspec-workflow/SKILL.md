---

name: openspec-workflow
description: "Own one OpenSpec change from exploration to archive: explore with the developer, write the artifacts, and spawn the official OpenSpec skills for apply, verify and archive."
---

You take one OpenSpec change from a half-formed idea to an archived change. You are in a
conversation with the developer, so you talk to them; the work itself is done by
sub-agents you spawn, each running the official OpenSpec skill for its step.

Work in the directory you were opened in. Spawn every sub-agent with
`workspace: "shared"` so all of you see the same checkout: the change lives in
`openspec/` there, and a separate worktree would leave it behind.

`catalog` is where your facts come from: the profile you run with, the configured
repositories and the topics that already exist. Pick one repository for the whole change
and one topic for it, and reuse both for every successor task so the tree stays one
change. Every spawn takes a stable `requestId`, so a repeated call cannot create a
second agent.

After you spawn, end your turn. When the task finishes its result arrives in this
conversation as a durable message — never poll `task_result`, and never treat your own
summary as evidence that the work happened.

## Decide whether to interact

You decide, not a rule, whether the developer's message already contains what you need.

Ask when the answer would change what you write: which capability this touches, whether
the change is one change or three, what must not change, which of two real options they
prefer. Do not ask for permission to do the work you were asked to do, and do not ask
what you could read from the code yourself.

While you are still deciding, stay in thinking mode: read the code, read
`openspec list`, `openspec list --specs`, `openspec show <change>`, sketch options, and
write nothing. `openspec-explore` is that stance in full — follow it if you want the long
form. Do not create or edit files while exploring; the only exception is artifacts the
developer explicitly asks you to write early.

## 1. Explore

Read before you write: which capabilities exist, what the neighbouring specs already
promise, and the code the change would touch. Say what you found and what you assume,
separately. Keep the change smaller than the problem looks: one change is one bounded
capability, and a second capability is a second change.

When the shape is clear, state the intent in the developer's language — one paragraph,
not a design — and continue. Do not stop to ask "shall I proceed" if they already told
you to go.

## 2. Propose

    openspec new change "<kebab-case-id>"
    openspec status --change "<id>" --json

Then write each artifact the schema lists, from the instructions OpenSpec prints for it
and in dependency order — proposal, then specs, then design, then tasks:

    openspec instructions <artifact> --change "<id>"

`openspec-propose` is the fast single-shot version of exactly this; use it if the
developer asked for a proposal with no discussion left. Answer in the artifact files, not
in the chat: the proposal's Capabilities section is a contract with the spec deltas, and
a capability named there needs its `specs/<name>/spec.md`. Finish with

    openspec validate "<id>"

and fix everything it reports. An artifact that does not validate is not written. Report
the change id, its path and what each artifact now says, then continue into apply unless
the developer asked to read the proposal first — if they did, stop and wait for them.

## 3. Apply

Spawn the implementation and end your turn:

    start_task({ skill: "openspec-apply-change", workspace: "shared", topicId, repository,
                 profile, requestId: "apply:<id>",
                 inputs: "Apply the OpenSpec change <id> in <directory>." })

## 4. Verify

When apply reports back, verify before deciding anything:

    start_task({ skill: "openspec-verify-change", workspace: "shared", topicId, repository,
                 profile, requestId: "verify:<id>:1",
                 inputs: "Verify the OpenSpec change <id> in <directory> against its own
                          artifacts and the code that now implements it." })

Add a `review` sub-agent with the next requestId when the change touched real behaviour
and you want an independent read of the diff; one extra reviewer, not a panel.

## 5. Decide

Read every finding and decide yourself. Neither verifier decides for you: a finding you
cannot reproduce in the code is not a finding.

Blocking findings get one fix sub-agent, then a fresh verify with the next number:

    start_task({ skill: "openspec-apply-change", workspace: "shared", topicId, repository,
                 profile, requestId: "fix:<id>:1",
                 inputs: "Address only these findings in the OpenSpec change <id>:
                          <the findings, verbatim>" })

Stop after two fix rounds. Findings that still block after that mean the proposal or the
design was wrong, and rewriting them is the developer's decision, not another sub-agent's
work. Refuse findings that the change never asked for — say which and why.

## 6. Archive

Check it yourself first — `openspec status --change "<id>"` and the boxes in `tasks.md`.
A change with an unchecked task or an artifact that is not done is not finished, whatever
the verifier said, and archiving it folds a spec delta into the main specs with nothing
behind it.

With nothing unchecked:

    start_task({ skill: "openspec-archive-change", workspace: "shared", topicId, repository,
                 profile, requestId: "archive:<id>",
                 inputs: "Archive the completed OpenSpec change <id> in <directory>.
                          Every task is ticked. Do not ask anyone anything: if you find
                          something unfinished, stop and report what is missing." })

A task has no developer listening, so its skill's "ask the developer to confirm" branch
would end the turn unanswered — that check is yours, before the spawn.

## Reporting

One short report per phase, in the developer's language, and never make them reconstruct
what happened: the change id and path, what apply changed, the findings you accepted and
refused, the archive path and the specs it folded in. Never push, deploy, install
services, rotate credentials or touch unrelated work.

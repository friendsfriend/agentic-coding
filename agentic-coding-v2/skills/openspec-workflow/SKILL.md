---

name: openspec-workflow
description: Own one OpenSpec change from exploration through proposal, apply, review and archive, spawning the agents that do the work.
---

You own one OpenSpec change from its first question to its archive. You explore and
write the proposal yourself; every implementation step is a sub-agent you spawn and
wait for. Work in the directory and repository named in your instructions, and give
every sub-agent `workspace: "shared"` so all of you see one checkout: the change lives
in `openspec/` of this directory, and a separate worktree would leave it behind.

Use `this task's own` values everywhere: the `Topic:` and `Repository:` lines in your
instructions for `topicId`/`repository`, and `catalog` to choose a `profile` — prefer
the profile named in your instructions when it is listed. Give each spawn a stable
`requestId` so a repeated call cannot create a second agent: `apply:<change>`,
`review:<change>:1`, `fix:<change>:1`, `archive:<change>`.

You are resumed with the results of the agents you spawn once they have all finished.
End your turn after spawning instead of waiting or polling; the results arrive as a
new turn, and you decide from them.

## 1. Explore

Read before you write anything: `openspec list`, `openspec list --specs`, `openspec show
<change>` for a neighbouring change, and the code the change would touch. State what
you actually found versus what you assume, and keep proposals smaller than the problem
looks: one change is one bounded capability.

Do not create or edit a single file in this phase. That includes `openspec/`, the
repository, and any scratch file inside the checkout.

Close the phase with exactly one `request_review`, whose `title` is the question the
developer answers — for example "Explore: <one-line intent>. Approve to write the
proposal." Give the findings in your own answer, not in the review. `approved` starts
the proposal; `changes-requested` means the developer redirected you, so explore again
with their comments and ask again; `rejected` ends the workflow — report what you
learned and stop.

## 2. Propose

Create `openspec/changes/<change-id>/` with a kebab-case id and write the four
artifacts in this order, each from the instructions OpenSpec prints for it, answering
the developer's comments from the review as you go:

    openspec instructions proposal --change <change-id>
    openspec instructions specs    --change <change-id>
    openspec instructions design   --change <change-id>
    openspec instructions tasks    --change <change-id>

Then `openspec validate <change-id>` and read `openspec status --change <change-id>`.
Fix anything either of them reports; an artifact that does not validate is not written.
The proposal's Capabilities section is a contract with the spec deltas — a capability
named there needs its `specs/<name>/spec.md`, and one not named there has no business
in the change.

## 3. Apply

Spawn the implementation and end your turn:

    start_task({ skill: "openspec-apply", workspace: "shared", topicId: <yours>,
                 repository: <yours>, profile: <chosen>, requestId: "apply:<change-id>",
                 inputs: "Apply the OpenSpec change <change-id> in <directory>.
                          Follow openspec instructions apply --change <change-id>,
                          tick every task in tasks.md as you complete it, run the
                          repository's gates, and validate the change." })

## 4. Review

When apply reports back, spawn one reviewer per concern you actually have. For now
that is the generic `review` skill; a single reviewer is enough unless the change spans
clearly separate areas:

    start_task({ skill: "review", workspace: "shared", ...,
                 requestId: "review:<change-id>:1",
                 inputs: "Review the OpenSpec change <change-id> against its own
                          requirement and spec deltas, and against the code that now
                          implements it. Findings only, no edits." })

## 5. Decide

Read every finding and decide yourself — the reviewer reports, it does not decide.
Blocking findings get one fix sub-agent, then a fresh review with the next review
number:

    start_task({ skill: "openspec-apply", workspace: "shared", ...,
                 requestId: "fix:<change-id>:1",
                 inputs: "Address only these findings in the OpenSpec change
                          <change-id>: <the findings, verbatim>. Tick tasks.md, run the
                          gates, validate." })

Stop the cycle after two fix rounds. If findings still block, report them to the
developer with what you tried: a change that needs a third round is a change whose
proposal or design was wrong, and that is the developer's decision, not another
sub-agent's work. Speculative or stylistic findings that the change did not ask for are
not work: say you are not doing them and why.

## 6. Archive

With nothing blocking left, spawn the archive and end your turn:

    start_task({ skill: "openspec-apply", workspace: "shared", ...,
                 requestId: "archive:<change-id>",
                 inputs: "Archive the completed OpenSpec change <change-id>. Validate it,
                          then archive it; never archive with unchecked tasks." })

## Reporting

One report at the end of each phase, in the developer's language and without asking
them to reconstruct anything: the change id and its path, which artifacts exist, what
apply changed, the findings you accepted and refused, the archive path and the specs it
folded in. Call `request_review` again only for a decision that is the developer's —
never for a step you were already asked to take.

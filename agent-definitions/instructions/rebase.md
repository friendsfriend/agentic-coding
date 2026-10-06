# Rebase

Rebase one branch onto another in this checkout and resolve every conflict. The assignment names the source branch (the branch to rebase) and the target ref (the branch to rebase onto); the engine already verified both and fetched the target remote once, so the checkout is on the source branch and the target ref exists.

## Commands

```bash
git status --short                  # must be clean before you start
git log --oneline -1                # where the source branch is
git log --oneline -1 <target>       # where the target is
git rebase <target>
```

Do not switch branches, create branches, commit unrelated work, push, archive, or launch agents. The commits a rebase itself creates are the point; the engine's next effect owns the finished branch.

## Resolving conflicts

For every stop git reports:

1. `git status` — read the conflict list.
2. Open each conflicted file and read both sides. Keep the target's intent (it is the branch being rebased onto) and re-apply the source branch's change on top of it; never drop a change from the source branch to make a conflict go away, and never resolve by picking one side wholesale unless the other side's change is genuinely superseded.
3. Remove every conflict marker, then `git add <file>`.
4. `git rebase --continue`.

A file that is *both* edited by the source branch and deleted by the target (or the reverse) is a decision, not a mechanical merge: ask with `developer_question` before choosing, then continue.

Repeat until `git rebase` reports it finished. If a conflict is genuinely unresolvable from the repository alone — a semantic conflict where both sides are correct and the result must drop behavior — stop the rebase (`git rebase --abort`), leave the branch exactly as you found it, and report `blocked` with the exact commit and file that could not be reconciled. Never leave a half-finished rebase behind: a stopped rebase with conflict markers is a failed run, not a partial success.

## Finish

After the rebase reports success:

```bash
git status --short                  # must print nothing
git log --oneline -3                # the source branch's commits sit on the target
```

Report `complete` only when the rebase finished, the working tree is clean, and the rebased commits are on top of the target. Write the run's output artifact before the handoff:

```json
{
  "head": "<the rebased HEAD commit sha>",
  "target": "<the target ref you rebased onto>",
  "conflicts": ["<repository-relative path of each file you resolved>"]
}
```

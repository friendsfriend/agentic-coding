---
name: herdr-openspec-git
description: Commits and pushes an approved, verified, archived OpenSpec change. Use only in git pane of managed Herdr workflow.
---

# Herdr OpenSpec Git

Developer approval exists and the archive step already ran. You are here to stage, commit, and push — including any OpenSpec archive move already sitting uncommitted in the tree.

1. Read `.herdr-workflow/$HERDR_CHANGE_ID/reviews/git-context.md` for change, branch, ticket, and verdict.
2. Run branch preflight:

```bash
herdr-workflow preflight-archive --repo "$PWD" --change "$HERDR_CHANGE_ID"
```

3. Stage all changes, including implementation changes and the archive move (e.g. `openspec/changes/archive/$HERDR_CHANGE_ID/`).
4. Create one descriptive commit. Prefix subject with bare ticket identifier and one space when `ticketNumber` exists; otherwise use normal subject:

```text
12345 make preferred date optional
make preferred date optional
```

5. Push current feature branch to `origin` with upstream:

```bash
git push --set-upstream origin "$(git branch --show-current)"
```

Never force-push, merge, or create PR/MR. On push failure, stop and report it; do not mark complete.

6. On success, run:

```bash
herdr-workflow archive --repo "$PWD" --change "$HERDR_CHANGE_ID"
```

to finalize the workflow to `completed`.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Force-pushing | Can destroy remote history |
| Marking complete after failed push | Hides unfinished delivery |
| Leaving the archive move unstaged | Change directory stays un-archived on the pushed branch |

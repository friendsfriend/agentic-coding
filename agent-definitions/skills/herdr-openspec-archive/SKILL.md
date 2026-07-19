---
name: herdr-openspec-archive
description: Finalizes an approved, verified OpenSpec change after git operations complete. Use only in archive pane of managed Herdr workflow.
---

# Herdr OpenSpec Archive

Git operations (commit and push) already completed before this role starts. This role only confirms and signals completion.

## Finalize

1. Read `.herdr-workflow/$HERDR_CHANGE_ID/reviews/archive-context.md` for change, branch, ticket, and verdict.
2. Confirm workflow phase is `archive`.
3. Validate archived artifacts and relevant tests pass.
4. On success, run:

```bash
herdr-workflow phase --repo "$PWD" --change "$HERDR_CHANGE_ID" completed
herdr notification show "OpenSpec change completed" --body "$HERDR_CHANGE_ID finalized; close from dashboard when ready" --sound done
```

## Common mistakes

| Mistake | Consequence |
|---|---|
| Committing after git operations | Duplicate partial commit |
| Marking complete without validation | Skips final consistency check |

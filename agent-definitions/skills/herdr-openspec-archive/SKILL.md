---
name: herdr-openspec-archive
description: Runs the OpenSpec archive move and validation before git operations. Use only in archive pane of managed Herdr workflow.
---

# Herdr OpenSpec Archive

Runs first after developer approval, before commit and push. Git has not run yet — do not commit or push here.

## Archive

1. Read `.herdr-workflow/$HERDR_CHANGE_ID/reviews/archive-context.md` for change, branch, ticket, and verdict, and the exact instruction (standard/direct-apply vs no-openspec).
2. Confirm workflow phase is `archive`.
3. For standard/direct-apply workflows, run:

```bash
openspec archive "$HERDR_CHANGE_ID" --yes
```

to move `openspec/changes/$HERDR_CHANGE_ID/` into `openspec/changes/archive/`. For no-openspec workflows, skip this — there is no OpenSpec directory; validate only.
4. Confirm the working tree is otherwise clean and stageable. Do not create a commit or push.
5. On success, run:

```bash
herdr-workflow archive --repo "$PWD" --change "$HERDR_CHANGE_ID"
```

to hand off to git operations.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Committing or pushing here | Duplicate/partial commit; git role owns commit |
| Running `openspec archive` for no-openspec | Fails — no OpenSpec directory exists |
| Skipping `openspec archive` for standard/direct-apply | Change directory never archived on the pushed branch |

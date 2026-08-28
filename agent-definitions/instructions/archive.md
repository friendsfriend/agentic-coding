# Archive

Your run environment is already set: `$HERDR_CHANGE_ID`, `$HERDR_OUTPUT`, and the other HERDR_* variables identify this run. Do not re-read run.env, workflow state, or list the repository to discover the change id.

Run exactly these commands — no help or discovery needed:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
openspec archive "$HERDR_CHANGE_ID" --yes
```

If archive fails, the change most likely modifies existing requirements without merge markers. Fix only structural issues: add `## MODIFIED Requirements` or `## REMOVED Requirements` sections to the affected spec(s) matching the approved proposal, then re-run validate and archive. Never change requirement or scenario content. If it still fails, report blocked with the exact error.

After a successful archive, verify once with `git status --short` and `openspec validate --all`, promote this change's draft concepts with `agentic-coding workflow wiki verify`, write or update remaining durable knowledge with `wiki write`, mark superseded concepts `status: deprecated`, and append a `wiki log` entry. Wiki access is exempt from the restriction on exploring beyond the change directory. Include touched concept ids in archive evidence; if none is worth recording, state that explicitly. Wiki failures belong in the evidence, not in a blocked outcome. Do not commit or push.

## Revising after wiki review

Read gate comments from `agentic-coding workflow status --json` at `step.context.comments`; each has `comment`, `file`, and optional line anchors. Re-read each named concept, apply the comment, and record which comment each edit resolves. If a comment is invalid or already satisfied, say so explicitly. Do not repeat `openspec archive` for a change already archived.

Do not explore openspec internals, other workflows' artifacts, or the repository beyond the change directory except for the wiki operations above.

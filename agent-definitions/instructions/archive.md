# Archive

Your run environment is already set: `$HERDR_CHANGE_ID`, `$HERDR_OUTPUT`, and the other HERDR_* variables identify this run. Do not re-read run.env, workflow state, or list the repository to discover the change id.

Run exactly these commands — no help or discovery needed:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
openspec archive "$HERDR_CHANGE_ID" --yes
```

If archive fails, the change most likely modifies existing requirements without merge markers. Fix only structural issues: add `## MODIFIED Requirements` or `## REMOVED Requirements` sections to the affected spec(s) matching the approved proposal, then re-run validate and archive. Never change requirement or scenario content. If it still fails, report blocked with the exact error.

After a successful archive, verify once with `git status --short` and `openspec validate --all`, write the run-bound archive evidence, and hand off. Do not commit or push. Do not explore openspec internals, other workflows' artifacts, or the repository beyond the change directory.

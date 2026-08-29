# Archive

Your run environment is already set: `$HERDR_CHANGE_ID`, `$HERDR_OUTPUT`, and the other HERDR_* variables identify this run. Do not re-read run.env, workflow state, or list the repository to discover the change id.

Run exactly these commands — no help or discovery needed:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
openspec archive "$HERDR_CHANGE_ID" --yes
```

If archive fails, the change most likely modifies existing requirements without merge markers. Fix only structural issues: add `## MODIFIED Requirements` or `## REMOVED Requirements` sections to the affected spec(s) matching the approved proposal, then re-run validate and archive. Never change requirement or scenario content. If it still fails, report blocked with the exact error.

After a successful archive, verify once with `git status --short` and `openspec validate --all`. Report the archive result and the validated files in your run-bound evidence. Do not author documentation, alter knowledge metadata, perform human verification, or perform any review-comment revision. Do not commit, push, or clean up the workspace.

If archival fails because the change is already archived, report that exact state rather than repeating archival. Keep the archive step limited to OpenSpec lifecycle duties; documentation is handled and reviewed by its dedicated preceding step.

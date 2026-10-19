# Archive

Your run environment is already set: `$HERDR_CHANGE_ID`, `$HERDR_OUTPUT`, and the other HERDR_* variables identify this run. Do not re-read run.env, workflow state, or list the repository to discover the change id.

The engine bounds this step to **two `openspec validate`/`openspec archive` attempts per archive entry**, and the assignment states which attempt this run owns. There is no third attempt: the second failure hands the validator output to the developer and parks the workflow, so turns spent on a retry the engine will not grant are wasted.

## Attempt 1 of 2

Run exactly these commands — no help or discovery needed:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
openspec archive "$HERDR_CHANGE_ID" --yes
```

If both succeed, verify once with `git status --short` and `openspec validate --all`, report the archive result and the validated files in your run-bound evidence, and hand off `complete`.

If either fails, repair nothing on this attempt: hand off `blocked` with that command's output (stdout and stderr) verbatim, at most 4000 characters. That message is both the next attempt's starting point and the developer's repair brief.

## Attempt 2 of 2 — the structural repair attempt

The previous attempt failed. Start by reproducing the current failure:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
```

When the failure is the structural kind — the change modifies existing requirements without merge markers — add `## MODIFIED Requirements` or `## REMOVED Requirements` sections to the affected spec(s) matching the approved proposal, never changing requirement or scenario content, then run the pair once:

```bash
openspec validate "$HERDR_CHANGE_ID" --strict
openspec archive "$HERDR_CHANGE_ID" --yes
```

When the failure is not structural, do not guess and do not edit documents: hand off `blocked` with the exact validator output immediately. On success, verify as in attempt 1 and hand off `complete`.

## When the pair still fails

Hand off `blocked` with the exact validator output — the failing command's output verbatim, at most 4000 characters — as the message. The engine then parks the workflow `attention-required` with that text and grants no third attempt; the developer fixes the change and repairs the workflow, which starts a fresh pair of attempts.

## Boundaries

If archival fails because the change is already archived, report that exact state rather than repeating archival. Do not author documentation, alter knowledge metadata, perform human verification, or perform any review-comment revision. Do not commit, push, or clean up the workspace. Keep the archive step limited to OpenSpec lifecycle duties; documentation is handled and reviewed by its dedicated preceding step.

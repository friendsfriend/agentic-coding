# Dependency patches

## Coalesced native diff decorations

`@opentui/core@0.6.6` rebuilds unified diff decorations synchronously for each
color setter, while split diffs already coalesce those setters in a microtask.
Hover changes six colors together. The patch gives unified diffs the same
coalescing path, so one hover transition produces one native rebuild instead of
six. Color getters still update immediately; painting uses the latest colors.

Both Bun and Node distributions are patched. On upgrade, remove this patch if
upstream coalesces unified decoration updates, or rebase it and run
`test/dash/transcriptPerformance.test.tsx` and the existing hover tests.

# Tasks

## 1. Per-file tagging

- [ ] 1.1 Extend the per-round classifier request to return, per changed file, the verifier roles that need to see it, in the same single request. Verify with a focused classifier test asserting one request carries both role questions and file tags.
- [ ] 1.2 Derive each verifier's scope as the tags that name a selected role and a path present in the changed-file manifest, discard every other tag, and record discarded tags. Verify with a focused test for a valid scope, a tag for an unselected role, a tag for an unknown path, and a selected role with no tagged file.

## 2. Retiring the triage step

- [ ] 2.1 Register a new definition version tier whose implementation loop replaces the triage step with the tag-derived scope, keeping earlier tiers unchanged. Verify with a focused registry test that the new tier has no triage step, that earlier tiers keep theirs, and that new starts resolve the new tier.
- [ ] 2.2 Remove the triage role, its step behavior entry, and its instruction asset from new definitions while keeping the legacy compatibility mapping for older pins. Verify with a focused registry and asset test that new definitions pin no triage asset and a legacy definition still resolves its triage step and role.
- [ ] 2.3 Retire the triage tab/pane grouping for definitions without the triage step and keep it for those that have one. Verify with a focused pane/tab test.

## 3. Focused verification

- [ ] 3.1 Run `bun run lint`, `bun run type-check`, and `bun run build` in `agentic-coding/` with zero diagnostics, regenerating the embedded assets through the build. Verify: clean runs and no stale generated file.
- [ ] 3.2 Run the focused classifier, step, registry, and pane suites and confirm every case passes. Verify: no failing test.

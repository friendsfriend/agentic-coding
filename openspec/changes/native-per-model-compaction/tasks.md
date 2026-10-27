## Implementation

- [x] Inspect the pinned native exact-policy contract, task ownership, overflow and summarizer model/budget selection; obtain developer design and workaround approval.
- [x] Add exact-model config parsing, field-wise policy resolution, unknown-window fallback and qualified validation; preserve existing defaults and token semantics.
- [x] Feed live native modelOverrides from the catalog without a shared minimum window; isolate host ceilings and retain run/role guards.
- [x] Implement the approved narrow task-ordered beforeCompact workaround without patching dependencies or changing storage.
- [x] Strengthen overlap regressions with latches, admission/wait observations, max active summarizers, both orders, concurrent manuals, background overlap, failures, cancellation, independent progress and temporary SQLite reopen.
- [x] Add focused mixed-window, model-switch, live-edit, identity/fallback, invalid-config, threshold and overflow coverage; preserve settings edits and failure/ceiling regressions.
- [x] Document precedence, native audit, workaround limitations and the explicitly approved pre-upgrade checkpoint boundary.
- [x] Run final focused host/config/settings/recovery regressions with isolated environment roots (179 passing), lint (zero diagnostics; 71 boundary tests), type-check (zero errors) and local build smoke (successful). Strict OpenSpec validation also passes.

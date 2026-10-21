# Verification notes

## Release N defaults

- `browser.snapshot_mode` defaults to `"ai"`; an unknown value resolves to
  `"ai"` rather than enabling the legacy DOM walker.
- The session records the mode when it opens. A later configuration change does
  not alter an existing session.
- `browser-snapshot-unsupported` (501) is the only answer when the installed
  Playwright lacks the public AI snapshot form. There is no fallback.

## Pilot

The checkout has no pinned external stage definition, so the pilot is a
deterministic local session against the fake driver (two clicks, one snapshot
per page state). It measures the loop shape and context growth, not real browser
latency.

| metric | AI mode | legacy mode |
| --- | --- | --- |
| model turns | 3 | 5 |
| driver snapshots | 3 (1 explicit + 2 post-action) | 3 (explicit) |
| driver actions | 2 | 2 |
| result characters | 260 | 432 |
| fake-driver total | 0.48 ms | 0.06 ms |

Per turn: AI `snapshot → click+observation → click+observation`; legacy
`snapshot → click → snapshot → click → snapshot`. The AI path saves two model
turns and 172 characters on this two-action flow, and keeps the full tree out of
the action results. A real pinned-stage run still has to confirm wall-clock and
diagnosis quality before the legacy deletion gate.

## Verification runs

- `bun test test/browser-snapshot.test.ts test/browser-pool.test.ts
  test/browser-routes.test.ts test/browser-settings.test.ts
  test/browser-redaction.test.ts test/browser-stage-sessions.test.ts
  test/agent-host-browser-tools.test.ts test/browser-stage-flow.test.ts
  test/browser-runtime.test.ts` — 240 passed.
- `DEVENV_SMOKE_BROWSER=1 bun test test/browser-smoke.test.ts` — the blocked
  iframe/no-DOM-mutation smoke passes against real Chromium. The pre-existing
  recording case cannot start in this environment because Playwright's ffmpeg
  binary is not installed; the failure is `browser-failed` with Playwright's
  install instruction, not a browser-loop regression.
- `bun run lint` and `bun run type-check` pass.

## Rollback release

Release N is the first release where AI is the default. Release N+1 performs the
scheduled deletion (tasks 8.7 and 8.8), which is now complete:

- `src/workflow/effects.ts` — `browser.snapshot_mode`, `BrowserSnapshotMode` and
  `resolvedSnapshotMode` removed; `ResolvedBrowserSettings` no longer carries a
  mode.
- `src/server/browser/snapshot.ts` — `SNAPSHOT_SCRIPT`, `SNAPSHOT_REF_ATTRIBUTE`,
  `captureLegacySnapshot`, `refSelector` and the `SnapshotMode` type removed.
- `src/server/browser/playwright-driver.ts` — the legacy snapshot branch removed.
- `src/server/browser/session.ts` — the mode field, the `snapshot-mode-legacy`
  refusals for `within`/`diff`/`find`, the legacy ref-to-selector translation and
  the `selectorFor` compatibility method removed.
- `src/server/browser/fake-driver.ts` — the `data-ac-ref` ref parser removed.
- `src/server/browser/routes.ts`, `stage-block-page.ts`, `pool.ts`, `runtime.ts`
  — `snapshotMode` plumbing, `assertObserveSupported` and the legacy action
  result branch removed.
- `src/contracts/browser.ts` — the `mode` status field removed from the timing,
  snapshot, action and find results and from `browserStatusResponseSchema`.
- `src/tui/settings/*`, `docs/settings-inventory.md` — the snapshot-contract row
  and its copy removed.
- `docs/browser-observation-loop.md` — the rollback section replaced by a
  removal note.

There is now exactly one snapshot contract: a configuration that still names
`snapshot_mode` has no effect (the key is not read), and no browser path injects
attributes or resolves a ref through a selector.

Removal gate evidence:

- `test/browser-removal.test.ts` (5 tests) scans the browser source roots for the
  removed symbols, proves the default config has no `snapshot_mode`, proves a
  stale `snapshot_mode: "legacy"` has no effect, pins the absence of the `mode`
  contract field and the rollback docs.
- The legacy-mode routing/settings tests were deleted with the code they pinned.
- Full browser/stage suite: 342 passed, 2 skipped, 0 failed across 15 files.
- `bun run lint`, `bun run type-check` and `bun run build` pass.

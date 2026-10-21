## 1. AI snapshot adapter

- [x] 1.1 Add a snapshot adapter that calls `page.ariaSnapshot({ mode: "ai", depth, timeout })` and a locator adapter for `within`, returning text plus bounded metadata
- [x] 1.2 Parse refs from AI text, including `eN` and iframe-prefixed forms such as `f1e3`; update `isRef`, `snapshotRefs` and any ref-count helper
- [x] 1.3 Remove the default `SNAPSHOT_SCRIPT` path and keep the old script only behind the legacy adapter
- [x] 1.4 Add `browser-snapshot-unsupported` when the public API is unavailable; do not silently fall back
- [x] 1.5 Add a stage-bound safety test that a blocked iframe does not contribute content and that snapshot/find output passes through the redactor
- [x] 1.6 Add a no-DOM-mutation test that a snapshot does not add `data-ac-ref` or other attributes

## 2. Driver and action targets

- [x] 2.1 Add an action target type that carries a ref or a selector, and a driver target resolver using `page.getByRef(ref)` or `page.locator(selector)`
- [x] 2.2 Change driver click/fill/press/select/hover to accept the target type while preserving the selector path
- [x] 2.3 Add a driver `snapshot` method with depth/within options and a `snapshotText`/`snapshotNodes` result shape
- [x] 2.4 Add driver support for `getByRef` resolution across iframes and translate a missing ref into `stale-ref`
- [x] 2.5 Update the fake driver to provide AI-shaped snapshot text, frame-prefixed refs and target resolution; keep it usable without Playwright
- [x] 2.6 Add driver tests for ref actions, selector actions, iframe refs, missing refs and depth/within snapshots

## 3. Snapshot identity and session state

- [x] 3.1 Add `snapshotId` generation and a current snapshot record per session: id, text, parsed nodes, refs, mode and timestamp
- [x] 3.2 Add a bounded snapshot history (at least four states) for diff; evict the oldest state and expose `snapshot-history-missing`
- [x] 3.3 Add optional `snapshotId` to action requests; refuse a mismatch with `stale-snapshot` before touching the page
- [x] 3.4 Keep the existing current-ref validation for requests without `snapshotId`
- [x] 3.5 Invalidate the ref set and set `snapshotRequired` when a post-action observation fails, while preserving the action outcome
- [x] 3.6 Add tests for stale ids, ref chaining after an action, observe failure, history eviction and mode isolation

## 4. Action observation and delta

- [x] 4.1 Parse AI snapshot text into a compact node map with role, name, ref, text and state flags
- [x] 4.2 Add a deterministic diff by ref with a role/name/text fallback for refs that changed
- [x] 4.3 Add the action observation formatter: URL/title, changed-count summary, at most 20 changed lines and a 1,500-character cap
- [x] 4.4 Add the structured `delta` with at most 50 entries per category and `deltaTruncated`
- [x] 4.5 Add a navigation short-circuit that returns a short summary and `snapshotRequired` instead of a cross-document delta
- [x] 4.6 Add stale-ref handling that returns the current snapshot id and never falls back to a selector or same-named element
- [x] 4.7 Add tests for add/remove/change, navigation, large delta, no-change action, stale ref and observation redaction

## 5. Scoped snapshots, diff and find

- [x] 5.1 Extend `browser_snapshot` with `within`, `depth` (default 10, max 14), `maxChars` (default 20,000, max 40,000), `diff` and `since`
- [x] 5.2 Implement `within` for refs and selectors through the locator AI snapshot form
- [x] 5.3 Truncate at a line boundary, mark `truncated`, and keep only returned refs actionable
- [x] 5.4 Implement `diff: true` over the bounded history and refuse an unknown/old `since`
- [x] 5.5 Add `browser_find` with query, within, role, name, limit and a bounded match result; no full tree and no snapshot-id change
- [x] 5.6 Add tests for scoped forms, character caps, depth caps, diff, history miss, find by role/name, no matches and iframe matches

## 6. Contracts and tool surface

- [x] 6.1 Extend `src/contracts/browser.ts` with snapshot options, `snapshotId`, observation/delta result schemas, find request/result and `observe` on script
- [x] 6.2 Extend `src/agent-host/browser-tools.ts` with `browser_find`, `snapshotId` on action tools, snapshot options and `observe` on `browser_run_script`
- [x] 6.3 Add a compact text formatter for action observations and find matches; keep the raw JSON out of the default model output when a text view is enough
- [x] 6.4 Add `timing` to tool result formatting and include `toolMs`/`resultChars` where the agent host can measure them
- [x] 6.5 Add contract tests for every new request/response field and a compatibility test for a client that omits `snapshotId`
- [x] 6.6 Add tests that an action result never contains a full tree and a script without `observe` never takes an automatic snapshot

## 7. Batching and timing telemetry

- [x] 7.1 Add `observe` handling to `browser_run_script` and `browser_wait` (default false) with one post-operation observation when requested
- [x] 7.2 Add timing fields to snapshot, action, diff, find, wait and script routes, including `snapshotMs`, `actionMs`, `observeMs`, `totalMs`, `chars`, `refs`, `changed`, `truncated` and `mode`
- [x] 7.3 Emit one structured `browser.tool` telemetry event per call through the existing sink; include tool, session, mode, timings, counts, changed/truncated and error code only
- [x] 7.4 Add an assertion that telemetry events contain no snapshot text, page URL query values, credentials or observation text
- [x] 7.5 Update the script and wait tool descriptions with the batch, observe and save guidance

## 8. Legacy mode, configuration and scheduled removal (release gate)

- [x] 8.1 Add `[browser] snapshot_mode = "ai" | "legacy"` to the browser settings schema, default `"ai"`, and validate unknown values
- [x] 8.2 Keep the old `SNAPSHOT_SCRIPT` and `data-ac-ref` path behind a legacy adapter; record the mode at session open
- [x] 8.3 Refuse `within`, `diff`, `find` and `observe` in legacy mode with `snapshot-mode-legacy`
- [x] 8.4 Report the active snapshot mode in browser status and the action/snapshot result
- [x] 8.5 Add tests for legacy snapshots/actions, new-feature refusals, mode-at-open isolation and no silent fallback on an AI error
- [x] 8.6 Verify and record that the default mode is `"ai"` for release N, collect the AI-mode pilot evidence and mark the rollback release in the change notes
- [x] 8.7 In release N+1, delete `snapshot_mode`, `SNAPSHOT_SCRIPT`, the `data-ac-ref` parser, the legacy action shape, the legacy status field, the legacy tests and the rollback documentation — release N (AI default) has shipped, so the deletion is done: the setting and `BrowserSnapshotMode`/`resolvedSnapshotMode` are gone from `src/workflow/effects.ts`; `SNAPSHOT_SCRIPT`, `SNAPSHOT_REF_ATTRIBUTE`, `captureLegacySnapshot`, `refSelector` and the `SnapshotMode` type are gone from `src/server/browser/snapshot.ts`; the legacy branch is gone from the Playwright driver, the session (including `selectorFor`), the fake driver's `data-ac-ref` ref parser, `stage-block-page.ts`'s mode refusal and the routes' `assertObserveSupported`/legacy action result; the `mode` status field is gone from `browserTimingSchema`, the snapshot/action/find results, the telemetry event and `browserStatusResponseSchema`; the settings TUI row, catalog copy and `docs/settings-inventory.md` no longer mention it; `docs/browser-observation-loop.md`'s rollback section is replaced by the removal note
- [x] 8.8 Add a test that the removed legacy mode is refused as an unknown setting and that no browser path imports or invokes `SNAPSHOT_SCRIPT`; run the full browser suite as the removal gate — `test/browser-removal.test.ts` scans every browser source root for the removed symbols, proves `DEFAULT_CONFIG.browser` has no `snapshot_mode`, proves a config that still names `snapshot_mode: "legacy"` has no effect (the key is not read), and pins that the contract has no `mode` field and the rollback docs are gone. The removal gate ran: 342 pass, 2 skip, 0 fail across 15 browser/stage files, plus `bun run lint`, `bun run type-check` and `bun run build`

## 9. Instructions, documentation and verification

- [x] 9.1 Update `agent-definitions/instructions/stage-test-execute.md`: snapshot once per page state, act on the action observation, use `snapshotId`, prefer `browser_find`/scoped/diff over a full snapshot, and batch known segments with `browser_run_script`
- [x] 9.2 Update `agent-definitions/instructions/workflow-agent-protocol.md` with the same observation and batching rule
- [x] 9.3 Add `docs/browser-observation-loop.md` covering AI snapshots, ref lifetime, observations/deltas, scoped/diff/find, batching, timing, the one-release legacy rollback and the mandatory removal checklist
- [x] 9.4 Update the browser tool descriptions and any user-facing settings copy for `snapshot_mode`
- [x] 9.5 Run the browser route, session, fake-driver, agent-host browser-tools, redaction, stage-session and settings tests
- [x] 9.6 Run the stage pilot in AI and legacy modes; record turns, snapshot chars, action observation chars, snapshot/observe timings and failure diagnosis in the change notes
- [x] 9.7 Run `bun run lint`, `bun run type-check` and the focused browser tests before finishing

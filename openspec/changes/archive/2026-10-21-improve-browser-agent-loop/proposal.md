## Why

The current browser loop is safe but turn-bound. The stage-test instruction
requires a fresh `browser_snapshot` before every action, and an action result
carries only `{ session, action, url, title }`. The agent therefore spends a turn
on a full snapshot, a turn on the action, and often another snapshot or
`browser_eval` to see what the action changed. A 20-step flow costs roughly
40–60 model turns before any screenshots.

The custom `SNAPSHOT_SCRIPT` walker also has a structural blind spot. It walks
`document.body`, never enters shadow roots or iframes, caps at depth 14 and 1,200
nodes, and mutates the page with `data-ac-ref` attributes. A local Playwright
1.64 spike showed the public AI snapshot is both smaller and more complete:

| page | current walker | Playwright AI snapshot |
| --- | --- | --- |
| GitHub page with depth 34 | 72.6 K chars, 858 refs | 6.0 K chars, 35 refs |
| playwright.dev | 31.6 K chars, 426 refs | 24.3 K chars, 169 refs |

The AI snapshot included shadow-DOM and iframe controls the custom walker missed,
and it was clickable through `page.getByRef()`. Generation took 2–99 ms in the
spike. The browser engine is not the bottleneck; returning a huge tree and
requiring a new full snapshot for every state is.

This change makes the observation loop cheap without weakening the ref contract:
one bounded AI snapshot establishes state, each action returns a compact
observation and a new snapshot id, and scoped/diff/find reads replace full-page
re-reads. `browser_run_script` remains the batch path; no new per-step tool is
added.

## What Changes

- Replace the default `SNAPSHOT_SCRIPT` walker with Playwright's public
  `page.ariaSnapshot({ mode: "ai" })` and `page.getByRef()`. The default is
  `"ai"`. Keep `browser.snapshot_mode = "legacy"` only for the release in which
  AI becomes the default; remove the flag, walker and `data-ac-ref` path in the
  following release. The removal tasks are a release gate: this change is not
  archived until the legacy path is deleted. There is no permanent dual-mode
  contract.
- Return a `snapshotId` from every snapshot and accept an optional `snapshotId`
  on action tools. A ref from a different snapshot is refused with
  `stale-snapshot`; refs from iframes use the AI form (`f1e3`) and resolve
  through `getByRef`.
- Observe after every action server-side: re-snapshot the page, update the ref
  set, and return a compact `observation` plus a structured `delta` (added,
  removed, changed refs/roles/names/text) and the new `snapshotId`. The action
  result SHALL NOT contain the full page tree. If the observation is large or
  the page navigated, return a short summary and mark `truncated` /
  `snapshotRequired`.
- Add scoped snapshots: `browser_snapshot({ within, depth, maxChars })` returns
  only the named subtree; `within` accepts a ref or selector.
- Add diff snapshots: `browser_snapshot({ diff: true, since })` returns only the
  changes since a snapshot id, not the full tree.
- Add `browser_find({ query, within?, role?, name?, limit? })`: search the
  current accessibility state for matching controls/text and return refs and
  labels, without returning the whole tree.
- Add `browser_run_script({ observe?: boolean })`: after a deterministic script,
  optionally return the same compact observation/delta. The tool description
  recommends a script for known sequences and a saved spec for reuse; no new
  batch-action tool is introduced.
- Add timing fields to snapshot, action, find, diff and script results:
  `snapshotMs`, `actionMs`, `observeMs`, `totalMs`, `chars`, `refs`, `changed`,
  `truncated`, and `toolMs` where the agent host can measure it. Emit one
  structured `browser.tool` telemetry event per call with the same fields and no
  page content.
- Update the stage-test and workflow-agent instructions: snapshot once per page
  state, act on refs from the action observation, use `browser_find`/scoped/diff
  before a full snapshot, and batch known segments with `browser_run_script`.
- Update the fake driver and tests: shadow DOM, iframe ref, deep DOM, stale
  snapshot, compact delta, scoped snapshot, diff, find, batching, the one-release
  legacy rollback, mandatory legacy removal and timing.
- Keep ref validation, origin guards, stage policy, redaction, screenshot and
  recording limits unchanged.

## Capabilities

### New Capabilities

- `browser-observation-loop`: AI snapshot generation, snapshot identity and ref
  lifecycle, compact action observations and deltas, scoped/diff snapshots,
  semantic find, batch observation, timing telemetry, the one-release legacy
  rollback and its scheduled removal.

### Modified Capabilities

- `agent-browser-sessions`: snapshot results carry a snapshot id and bounded AI
  tree; action results carry a compact observation; `browser_run_script` may
  return a compact observation; browser tool results carry timing. Existing
  session isolation, ref safety, script restrictions, redaction and evidence
  rules remain in force.

## Impact

- `src/server/browser/snapshot.ts`: replace the default walker with a thin AI
  snapshot adapter, ref parser and cap helper; retain the legacy script behind a
  flag for one release, then delete both.
- `src/server/browser/playwright-driver.ts` and `types.ts`: snapshot options and
  `getByRef` action targets; keep selector fallback and the guard/authorization
  boundary.
- `src/server/browser/session.ts`: snapshot id, ref set, observation/delta state,
  stale-ref refusal and timing.
- `src/server/browser/routes.ts`: snapshot/diff/find handling, action
  observation, batch observation and result shaping.
- `src/contracts/browser.ts` and `src/agent-host/browser-tools.ts`: new request
  and response fields, `browser_find`, `snapshotId`, `observe`, `timing`.
- `src/server/browser/fake-driver.ts` and browser tests: AI snapshot fixture,
  iframe/shadow refs, stale id, delta, scoped/diff/find, legacy rollback and
  legacy removal.
- `agent-definitions/instructions/stage-test-execute.md` and
  `workflow-agent-protocol.md`: the snapshot/observe/batch loop.
- `openspec/specs/agent-browser-sessions/spec.md` and this change's delta:
  observation and timing requirements.
- Configuration: `[browser] snapshot_mode = "ai" | "legacy"` (default `ai`) for
  one release only, bounded defaults for depth/chars, then removal of the flag.
- Documentation: the observation model, ref lifetime, scoped/diff/find usage,
  batching guidance, timing fields, the one-release rollback and the mandatory
  removal checklist.

## Non-Goals

- A CDP/DevTools Protocol rewrite or a different browser engine. The spike shows
  the public snapshot API is the high-leverage change.
- Returning screenshots or vision by default; screenshots remain an explicit
  evidence/inspection tool.
- Removing selector fallback or the ref safety contract.
- One tool per UI action or a new DSL; `browser_run_script` and stage blocks are
  the batch/reuse paths.
- A full snapshot in every action result. The action result is a delta, not a
  page dump.
- A permanent legacy snapshot mode. It is a one-release rollback and SHALL be
  removed in the following release.
- Changing stage origin guards, credential handling or evidence limits.

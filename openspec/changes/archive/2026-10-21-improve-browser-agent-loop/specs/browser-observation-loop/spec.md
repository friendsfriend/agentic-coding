## ADDED Requirements

### Requirement: The default snapshot uses the public AI snapshot
The default browser snapshot SHALL be produced by Playwright's public `page.ariaSnapshot({ mode: "ai" })` (or the locator form for a scoped read), and action refs SHALL resolve through Playwright's public `page.getByRef()`. The snapshot SHALL include shadow-DOM and iframe content that the public AI snapshot exposes, SHALL NOT inject `data-ac-ref` attributes or other snapshot markers into the page, and SHALL remain subject to the stage request guard and the shared redactor. A runtime without the public API SHALL fail with `browser-snapshot-unsupported` rather than silently using a different contract.

#### Scenario: Shadow and iframe controls are visible
- **WHEN** a page puts a button in a shadow root and a form in an iframe and the agent takes a snapshot
- **THEN** both controls SHALL appear in the snapshot with refs and SHALL be actionable through those refs

#### Scenario: Snapshot does not mutate the page
- **WHEN** an agent takes a snapshot
- **THEN** the page SHALL NOT gain `data-ac-ref` attributes or other snapshot-only markup

### Requirement: Snapshot identity makes stale refs explicit
`browser_snapshot` SHALL return a `snapshotId` that identifies the state that produced the refs. Action tools SHALL accept an optional `snapshotId`; when it is supplied and does not equal the session's current id, the action SHALL be refused with `stale-snapshot` before touching the page. When it is omitted, the ref SHALL be validated against the current ref set, preserving the existing behavior. After an action, the server SHALL take a new AI snapshot, replace the ref set and return the new `snapshotId`. If the post-action observation fails, the action result SHALL still report the action outcome, SHALL invalidate the ref set and SHALL set `snapshotRequired: true`.

#### Scenario: Ref from an older snapshot
- **WHEN** an agent takes snapshot `s7`, takes snapshot `s8`, and calls `browser_click` with `snapshotId: "s7"`
- **THEN** the action SHALL be refused with `stale-snapshot` and the page SHALL not be touched

#### Scenario: Chain from an action observation
- **WHEN** an action returns `snapshotId: "s9"` and a ref `e7` from the observed state
- **THEN** a following action using `snapshotId: "s9"` and `e7` SHALL be accepted

### Requirement: Action results carry a compact observation and delta
Every action result SHALL include a bounded `observation`, an optional structured `delta` of added, removed and changed nodes, the new `snapshotId`, `changed`, `truncated`, `snapshotRequired` and timing. The observation SHALL contain the URL, title, a changed-count summary and at most 20 changed-node lines, bounded to 1,500 characters. The delta SHALL be bounded to 50 entries per category. The action result SHALL NOT contain the full page tree. A navigation SHALL produce a short navigation summary and `snapshotRequired: true` instead of a cross-document delta.

#### Scenario: Click returns the changed state
- **WHEN** clicking a Save button changes a status text and adds a confirmation heading
- **THEN** the action result SHALL name the new heading and the changed status with their refs and SHALL not include the rest of the page

#### Scenario: Navigation asks for a snapshot
- **WHEN** a click navigates to a different document
- **THEN** the result SHALL report the navigation, the new URL and `snapshotRequired: true` instead of a full delta

### Requirement: Stale or missing refs are refused, not guessed
If a validated ref no longer resolves at action time, the action SHALL fail with `stale-ref`, SHALL return the current `snapshotId`, and SHALL NOT fall back to a selector, a same-named element or a new snapshot taken on the agent's behalf. A ref action without any current snapshot SHALL fail with `snapshot-required` and SHALL name the `browser_snapshot` call that fixes it.

#### Scenario: Re-render removes the ref
- **WHEN** a page re-renders and the element behind ref `e7` disappears before the click
- **THEN** the click SHALL fail with `stale-ref` and SHALL not click a same-named replacement

#### Scenario: No snapshot yet
- **WHEN** an agent calls `browser_click` with a ref before any snapshot
- **THEN** the call SHALL fail with `snapshot-required`

### Requirement: Scoped snapshots return only the requested subtree
`browser_snapshot` SHALL accept `within` (a ref or a Playwright selector), `depth` (default 10, maximum 14) and `maxChars` (default 20,000, maximum 40,000). `within` SHALL use the locator form of the AI snapshot. Truncation SHALL occur at a line boundary and SHALL set `truncated: true`; only refs present in the returned text SHALL be actionable. The absolute caps SHALL remain in force even when the caller asks for a larger value.

#### Scenario: Scope to a form
- **WHEN** an agent calls `browser_snapshot({ within: "form[data-testid=address]", depth: 8 })`
- **THEN** the result SHALL contain only the form subtree and its refs

#### Scenario: Character cap
- **WHEN** a scoped snapshot exceeds `maxChars`
- **THEN** the result SHALL end at a line boundary, mark `truncated: true`, and expose only the refs it returned

### Requirement: Diff snapshots return changes only
`browser_snapshot({ diff: true, since })` SHALL return the changes between the current state and the state named by `since` (default: the previous state) using the same added/removed/changed shape as an action delta. The session SHALL retain a bounded history of at least the last four snapshot states; a `since` older than that history SHALL be refused with `snapshot-history-missing` and SHALL suggest a full snapshot. The diff result SHALL carry the current `snapshotId` and SHALL not return the full tree.

#### Scenario: Diff since the previous state
- **WHEN** an agent calls `browser_snapshot({ diff: true, since: "s9" })`
- **THEN** the result SHALL list only the nodes added, removed or changed between `s9` and the current state

#### Scenario: Too-old snapshot
- **WHEN** the requested `since` is outside the bounded history
- **THEN** the call SHALL fail with `snapshot-history-missing`

### Requirement: Semantic find avoids a full-page read
`browser_find({ query, within?, role?, name?, limit? })` SHALL search the current snapshot state and return up to 20 matching controls or text nodes as `{ ref, role, name, text?, checked?, disabled? }`, plus `total` and `truncated`. It SHALL support a free-text query and optional role/name filters, SHALL respect `within`, SHALL not return the full tree and SHALL not replace the current snapshot id. A query with no matches SHALL return an empty list and the current `snapshotId`, not an error.

#### Scenario: Find a button by name
- **WHEN** an agent calls `browser_find({ query: "save", role: "button" })`
- **THEN** the result SHALL list matching buttons with refs and accessible names

#### Scenario: No matches
- **WHEN** a search has no matching node
- **THEN** the result SHALL be an empty list with the current `snapshotId`

### Requirement: Batch scripts can return one compact observation
`browser_run_script` SHALL accept an optional `observe` flag. With `observe: true`, the server SHALL take one AI snapshot after the script and return a bounded observation/delta and the new `snapshotId`, in addition to the script's own result. With `observe: false` or omitted, the result SHALL remain the script result with timing and no automatic page observation. The tool description SHALL recommend a script for a known sequence in one page state, `save: true` for a reproduction, and a stage block/plan for a stable reusable flow. No new batch-action tool SHALL be introduced.

#### Scenario: Script with observation
- **WHEN** an agent runs a script that fills and submits a form with `observe: true`
- **THEN** the result SHALL contain the script's return value and a compact observation of the resulting state

#### Scenario: Script without observation
- **WHEN** an agent runs a script with `observe` omitted
- **THEN** the result SHALL contain the script result and timing but SHALL not take an automatic snapshot

### Requirement: Browser timing is returned and telemetered
Every snapshot, action, diff, find and script result SHALL carry timing fields: `snapshotMs`, `actionMs`, `observeMs`, `toolMs` where measurable, `totalMs`, `chars`, `refs`, `changed`, `truncated` and `mode`. The server SHALL emit one structured `browser.tool` telemetry event per call with the tool, session, mode, timings, character count, ref count, changed/truncated flags and error code. The event SHALL contain no page text, snapshot content, URL query values or credentials.

#### Scenario: Result timing
- **WHEN** an action completes
- **THEN** its result SHALL report the snapshot, action and observation durations and the returned character/ref counts

#### Scenario: Telemetry has no page content
- **WHEN** a snapshot contains a secret-shaped value
- **THEN** the `browser.tool` event SHALL contain counts and durations only, not the value or the snapshot text

### Requirement: AI is the only snapshot contract
AI mode SHALL be the only snapshot contract. The one-release `[browser] snapshot_mode` rollback SHALL be removed in the release after AI becomes the default: the setting, `SNAPSHOT_SCRIPT`, the `data-ac-ref` contract, the legacy action shape, the legacy status field, the legacy tests and the rollback documentation SHALL be deleted. A configuration that still names `snapshot_mode` SHALL have no effect, and no browser path SHALL use the old walker or resolve a ref through a selector. Removal SHALL be a release gate, not an indefinite compatibility promise.

#### Scenario: No silent fallback
- **WHEN** an AI snapshot fails
- **THEN** the call SHALL fail with the AI snapshot error and SHALL not switch to another snapshot contract

#### Scenario: Legacy removal release
- **WHEN** the release after the AI-default release is built
- **THEN** the legacy setting, walker, `data-ac-ref` parser, the `mode` status field, the legacy tests and the rollback documentation SHALL be absent, and a configuration that still names the removed setting SHALL have no effect

### Requirement: Existing browser safety contracts are unchanged
The snapshot and observation changes SHALL preserve selector fallback, stage origin guards, credential masks, screenshot and recording limits, evidence rules, session isolation and the shared redactor. Every snapshot, action observation and find result SHALL pass through the redactor before it leaves the server. A selector action SHALL remain available when no ref names the element. A stage-bound snapshot SHALL not widen the stage allow-list.

#### Scenario: Selector still works
- **WHEN** an agent clicks a selector instead of a ref
- **THEN** the click SHALL use the selector path and the action SHALL still return a compact observation

#### Scenario: Secret in an observation
- **WHEN** an action observation would include a configured secret
- **THEN** the result SHALL contain a redaction marker instead of the secret

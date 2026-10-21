## Context

The current browser loop is deliberately conservative: `browser_snapshot`
returns a bounded tree, the action tools accept a ref from that snapshot, and a
ref from an older snapshot is refused. The safety property is right. The cost is
wrong.

`SNAPSHOT_SCRIPT` walks `document.body` with a depth cap of 14 and a node cap of
1,200, injects `data-ac-ref` attributes, and never enters shadow roots or
iframes. The action result is only `{ session, action, url, title }`, so the
agent must take another full snapshot to learn what changed. The stage-test
instruction also tells the agent to snapshot before every action, which doubles
the turn count.

A local Playwright 1.64 spike showed the public AI snapshot is smaller on real
pages, includes iframe and shadow-DOM controls, and produces refs that
`page.getByRef()` can act on. Snapshot generation was 2–99 ms. The browser engine
is not the first bottleneck; the observation contract is.

This change keeps the ref safety property and makes each state cheap: one AI
snapshot establishes the state, an action returns a compact delta for the next
state, and scoped/diff/find reads answer targeted questions without dumping the
whole page.

## Goals / Non-Goals

**Goals:**

- Use Playwright's public AI snapshot and ref locator instead of the custom DOM
  walker.
- Make a snapshot an identified state (`snapshotId`) and make stale refs
  explicit.
- Return a compact, structured observation after every action, with the new
  snapshot id, so the next action usually needs no extra snapshot turn.
- Support scoped snapshots, diffs and semantic find for the cases where the
  delta is not enough.
- Keep `browser_run_script` as the batch path and let it return the same compact
  observation.
- Measure snapshot/action/observe cost and context size per call.
- Keep a one-release legacy mode for rollback, then remove it on a scheduled
  release gate.

**Non-Goals:**

- CDP or a browser-engine rewrite.
- Vision or screenshots as the default observation.
- Removing selector fallback, stage guards, redaction or ref validation.
- A new per-action tool or a new action DSL.
- Full-page snapshots in action results.
- A permanent legacy snapshot contract. The rollback is removed in the release
  after AI becomes the default.
- Changing the session pool, login hand-off, evidence limits or recording
  behavior.

## Decisions

### D1. The public AI snapshot is the canonical state

The driver calls:

```ts
const text = await page.ariaSnapshot({
  mode: "ai",
  depth,
  timeout,
});
```

and actions resolve a ref through:

```ts
await page.getByRef(ref).click({ timeout });
```

`mode: "ai"` includes `[ref=eN]` markers and iframe snapshots; shadow DOM is part
of the accessibility tree. The refs are the contract; no `data-ac-ref`
attributes are injected, so the page's DOM is no longer mutated by a snapshot.

The driver keeps a selector path for login recipes and for an action with no
ref. `getByRef` is used only when the session has validated the ref against the
current snapshot id.

**Why not `_snapshotForAI`:** it is a private API and the pool must not depend on
it. **Why not keep the walker:** it misses shadow roots and iframes, and its
depth/node caps produce a larger, less useful tree on deep pages.

### D2. Snapshot identity and ref lifecycle

`browser_snapshot` returns:

```ts
{
  session: "default",
  snapshotId: "s7",
  url: "https://...",
  title: "...",
  refs: 35,
  chars: 6012,
  truncated: false,
  snapshot: "- heading \"...\"\n- button \"Save\" [ref=e7]\n..."
}
```

The session stores:

- the current `snapshotId`;
- the current ref set (including iframe-prefixed refs such as `f1e3`);
- the current parsed node map used for diff/find;
- a bounded history of the last four parsed states for `diff: true`.

A ref is valid only for the snapshot that produced it. Action tools accept an
optional `snapshotId`:

- when supplied, it must equal the session's current id; otherwise the call is
  refused with `stale-snapshot`;
- when omitted, the ref must be in the current ref set, preserving today's
  behavior for clients that do not send the id.

After an action, the server takes a new AI snapshot, replaces the ref set and
returns the new `snapshotId`. An agent can therefore chain actions using the refs
from the action observation without a separate `browser_snapshot` turn.

If the post-action observation fails, the action result is still returned (the
action may have succeeded), but the ref set is invalidated and the result says
`snapshotRequired: true`. The next ref action is refused until a fresh snapshot.

Ref parsing accepts `eN` and iframe-prefixed forms such as `f1e3` (and nested
frame prefixes). `isRef` and `snapshotRefs` are updated accordingly; a
`[data-ac-ref]` selector is no longer the action contract.

### D3. Action results carry a compact delta, not a page

The action route takes a snapshot before the action (the current state) and after
the action. It compares the two parsed node maps by ref, falling back to a
role/name/text path when a ref is not stable. The result is:

```ts
{
  session: "default",
  action: "click",
  url: "https://.../customer/42",
  title: "...",
  snapshotId: "s8",
  changed: true,
  observation: "url: .../customer/42\n+ heading \"Customer 42\" [ref=e3]\n~ text \"Saved\" [ref=e9]",
  delta: {
    added: [{ ref: "e3", role: "heading", name: "Customer 42" }],
    removed: [],
    changed: [{ ref: "e9", role: "text", text: "Saved" }]
  },
  truncated: false,
  snapshotRequired: false,
  timing: {
    snapshotMs: 12,
    actionMs: 84,
    observeMs: 18,
    totalMs: 114,
    chars: 620,
    refs: 35
  }
}
```

Rules:

- `observation` is at most 1,500 characters and contains a URL/title line, a
  changed-count summary, and at most 20 add/remove/change lines.
- `delta` is capped at 50 entries per category; beyond that, `deltaTruncated` is
  true and the observation says to take a snapshot.
- If the action navigated, the observation is a short navigation summary and
  `snapshotRequired: true`; the delta is not attempted across documents.
- If the action opened a dialog or a new page, the observation names it and the
  new snapshot id; the detail remains available through `browser_snapshot`.
- If a ref is no longer resolvable at action time, the route returns
  `stale-ref` with the current `snapshotId` and asks for a fresh snapshot; it
  does not fall back to a same-named element.
- The full page tree is never included in the action result.

Actions with a selector still work, but the observation is the same; a selector
action without a previous snapshot simply returns an observation with no delta.

### D4. Scoped snapshots, diffs and find replace full re-reads

`browser_snapshot` gains:

```ts
{
  session?: string;
  within?: string;      // a ref or a Playwright selector
  depth?: number;       // default 10, max 14
  maxChars?: number;    // default 20_000, max 40_000
  diff?: boolean;       // return changes only
  since?: string;       // a snapshot id in the bounded history
}
```

- `within` uses `page.getByRef(ref).ariaSnapshot({ mode: "ai", depth })` or
  `page.locator(selector).ariaSnapshot({ mode: "ai", depth })`.
- `maxChars` truncates at a line boundary, marks `truncated: true`, and only
  refs present in the returned text are actionable.
- `diff: true` returns the changes from `since` (default: the previous state) as
  the same delta shape, with `snapshotId` of the current state. A `since` older
  than the bounded history is refused with `snapshot-history-missing`.
- `browser_find({ query, within?, role?, name?, limit? })` searches the current
  parsed nodes and returns up to 20 matches as
  `{ ref, role, name, text?, checked?, disabled? }` plus `total` and
  `truncated`. It does not return the tree and does not change the snapshot id.

The default depth is lower than the legacy cap because the AI snapshot is
denser; a caller that needs more can ask for 14 or scope to a subtree. The
server still enforces the absolute caps.

### D5. Batch paths return one observation

The existing `browser_run_script` is the batch path. It gains:

```ts
{
  session?: string;
  code: string;
  save?: boolean;
  caption?: string;
  observe?: boolean;   // default false
  timeoutMs?: number;
}
```

With `observe: true`, the route takes one AI snapshot after the script and
returns the compact delta/observation, not the full tree. The script result
remains the script's own JSON. The tool description recommends:

- a script for a known sequence of interactions in one page state;
- `save: true` for a rerunnable reproduction;
- a stage block/plan for a stable, reusable flow.

No new `browser_batch` tool is added: the script surface already exists, and a
second action-list tool would duplicate its policy and timeout handling.

`browser_wait` MAY accept `observe` on the same terms; the default remains
false so a wait that is followed by a deliberate read does not pay twice.

### D6. Timing is a first-class result field

Every snapshot, action, diff, find and script result carries a `timing` object:

```json
{
  "snapshotMs": 12,
  "actionMs": 84,
  "observeMs": 18,
  "toolMs": 120,
  "totalMs": 114,
  "chars": 620,
  "refs": 35,
  "changed": true,
  "truncated": false,
  "mode": "ai"
}
```

`toolMs` is measured by the agent host around the server call; the other fields
are measured by the server. The server emits one structured `browser.tool`
telemetry event per call with the tool, session, mode, timings, chars, refs,
changed/truncated flags and error code. The event contains no page text, URL
query values, credentials or snapshot content.

The result fields are the source for the agent's own turn-cost analysis; the
telemetry event is the source for aggregate reporting.

### D7. Legacy mode is a one-release rollback, then it is removed

`[browser] snapshot_mode` accepts `"ai"` (default) and `"legacy"`. In legacy
mode the old `SNAPSHOT_SCRIPT` and `data-ac-ref` path remain, the action result
keeps the old shape plus timing, and the new `within`/`diff`/`find`/`observe`
fields are refused with `snapshot-mode-legacy`. The mode is reported by browser
status so a run can tell which contract it has.

The rollback window is exactly the release in which `"ai"` becomes the default.
In the following release, delete the `snapshot_mode` flag, the `SNAPSHOT_SCRIPT`
and `data-ac-ref` implementation, the legacy action shape, the mode status field,
the legacy tests and the documentation that presents legacy as an option. A
release that still accepts `"legacy"` after that point SHALL fail the change's
removal task; there is no indefinite compatibility promise. The removal is a
release gate, not a follow-up idea.

Do not support both paths in the same session; a session records its mode at
open and refuses a mode change. The AI path must not depend on the legacy code
remaining.

**Alternative rejected:** silently falling back to the legacy walker when the AI
snapshot fails. A fallback would hide a broken public API and produce two
different ref contracts in one workflow.

**Alternative rejected:** keeping the flag indefinitely. It would preserve two
ref contracts, two test suites and a stale DOM walker with no product value after
the rollback window.

### D8. Stage safety and cross-frame content

The AI snapshot may include iframe content. The stage request guard remains the
authority for what can load: a frame whose origin is outside the stage
allow-list is aborted before its document loads, so it cannot contribute page
content. A frame that is allowed is stage content and may appear in the
snapshot. The shared redactor runs over the snapshot text and the action
observation exactly as it does today.

The session does not inject attributes or scripts into the page for snapshots;
`getByRef` uses Playwright's snapshot registry. This removes the old mutation
side effect and keeps the stage guard, credential masks and screenshot rules
unchanged.

### D9. Contract changes are additive where possible

`browser_snapshot` returns new fields; existing fields keep their meaning.
Action tools accept an optional `snapshotId`; clients that omit it keep the
current-ref behavior. `browser_find` is new. `browser_run_script` gains optional
`observe`. A result may omit `delta` when the state did not change; callers must
treat `delta` as optional.

The `browser_snapshot` text remains YAML-shaped and ref-marked, so existing
instruction examples that pass `[ref=eN]` remain valid. The ref grammar expands
to include frame-prefixed refs.

## Risks / Trade-offs

- **AI snapshot output is less controllable than a hand-written walker.** The
  `depth` and `maxChars` caps, scoped snapshots and find keep the result bounded;
  the 40 K absolute cap remains.
- **`getByRef` refs can go stale on a re-render.** The session returns
  `stale-ref` and a new snapshot id instead of falling back to a same-named
  element.
- **Post-action snapshots add server work.** The spike measured 2–99 ms; the
  action result is still one model turn cheaper than a separate snapshot. The
  observation can be disabled per action? No: the default is to observe, because
  the turn saving is the point.
- **Diffs can be noisy.** The delta is capped, navigation returns a summary, and
  `snapshotRequired` tells the agent when the delta is not enough.
- **Iframe content widens what a snapshot can contain.** The stage request guard
  and redactor remain in force; a blocked frame never loads. The snapshot does
  not bypass the guard.
- **Legacy mode can drift.** The flag is temporary, reported in status, and
  removed in the release after AI becomes the default; the removal task deletes
  the flag, walker, tests and docs, and a release that still accepts legacy fails
  that gate.
- **Text parsing is less structured than JSON.** The parser is narrow (role,
  name, ref, key properties) and tested against the AI format; if the format
  changes, the fixture fails and the parser is updated. The raw text remains
  available.
- **Telemetry could leak page content.** The event contains counts and timings
  only; it never includes the observation text or URL query values.

## Migration Plan

1. Add the AI snapshot adapter and `getByRef` driver path behind
   `snapshot_mode = "ai"`; keep legacy as the default only for the pilot.
2. Add `snapshotId`, ref parsing, action observation and timing to the session
   and routes; update the tool result formatters.
3. Add scoped snapshots, diff and `browser_find`.
4. Add `browser_run_script({ observe })` and the instruction guidance.
5. Run the stage pilot on the AI mode; compare turns, snapshot chars, action
   observation chars and failure diagnosis with legacy.
6. Make `"ai"` the default in release N, record the mode in browser status and
   keep `"legacy"` for rollback during release N only. Collect AI-mode evidence
   and confirm no blocking regressions.
7. In release N+1, delete `snapshot_mode`, `SNAPSHOT_SCRIPT`, the `data-ac-ref`
   contract, the legacy action shape, the legacy status field, the legacy tests
   and the rollback documentation. Verify an unknown/removed legacy mode is
   refused and run the full browser suite. This removal is a required release
   gate, not an optional follow-up.

## Open Questions

- **Default depth:** 10 keeps a deep page compact; a scoped snapshot or
  `browser_find` handles the rest. Should the default be 8 for stage sessions and
  10 elsewhere?
- **Snapshot text vs JSON:** the text form is the canonical ref producer; if a
  future Playwright version makes `ariaSnapshotJSON` the only ref-registering
  call, switch the adapter and keep the same contract.
- **Observation default:** always observe after an action, or let the action tool
  pass `observe: false` for a deliberately blind action? The recommendation is
  always observe; the extra 2–99 ms is cheaper than a model turn.
- **Telemetry sink:** use the existing workflow telemetry event stream; if a run
  has no sink, the result fields still carry timing.
- **Cross-origin iframe policy:** rely on the request guard (recommended) or
  additionally filter snapshot text by frame origin. Filtering would require a
  per-frame snapshot composition and is not planned unless the guard proves
  insufficient.

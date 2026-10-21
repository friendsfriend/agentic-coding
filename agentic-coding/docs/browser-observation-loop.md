# Browser observation loop

The browser surface is built for an agent that needs a page state, not for a
person repeatedly asking for a tree. One snapshot establishes a page state; each
action returns the small part of the next state that changed.

## AI snapshots

`browser_snapshot` calls Playwright's public
`page.ariaSnapshot({ mode: "ai", depth, timeout })` (or the locator form when
`within` is present). The returned text uses `[ref=eN]` for the page and
`[ref=f1e3]` for a frame. No DOM walker runs and no attribute is injected into
the page. The refs resolve through `page.getByRef(ref)` or the corresponding
frame locator.

Bounds:

| option | default | absolute maximum |
| --- | --- | --- |
| `depth` | 10 | 14 |
| `maxChars` | 20,000 | 40,000 |
| history states | 4 | — |
| delta entries per category | 50 | — |
| observation lines | 20 | — |
| observation characters | 1,500 | — |

Truncation happens at a line boundary; a single line longer than the cap is cut
at the cap. Only refs present in the returned text are actionable. The
`snapshotId` names the exact state; a ref without the matching id is checked
against the current state, and a stale id or unknown ref is refused.

## Ref lifetime

A snapshot starts a state. Actions validate the ref before touching the page.
After an action the server takes one post-action snapshot, records a new id and
returns a compact observation plus a `delta`:

- `snapshotId` — the state the next action should cite;
- `changed` — whether the observation found a change;
- `delta` — added, removed and changed nodes, capped at 50 per category;
- `deltaTruncated` — whether the structured list was capped;
- `snapshotRequired` — true after a navigation or a failed observation, where
  refs from the previous document must not be reused.

The full tree is never part of an action result. If the post-action observation
fails, the action outcome is preserved, the ref set is invalidated and
`snapshotRequired: true` is returned. A stale ref is never translated to a
selector or resolved to a same-named element.

## Scoped, diff and find reads

- `within` takes a ref or selector and reads only that subtree through the
  locator AI snapshot form.
- `diff: true` compares the current state with `since` (or the previous state).
  The bounded history keeps at least four states; an evicted or unknown id is
  `snapshot-history-missing`. `diff` and `within` are mutually exclusive.
- `browser_find` searches the current node map by query, role, name and optional
  `within`; it returns refs and bounds only, never the tree, and does not change
  the current id.

## Batching

`browser_wait({ observe: true })` and
`browser_run_script({ observe: true })` take one post-operation observation and
return the same observation/id contract. Use a script for a deterministic
stretch, then act on its observation. `observe` defaults to `false`, so a script
whose result alone is needed does not pay for a snapshot. A navigation inside a
script short-circuits the delta and returns `snapshotRequired: true`.

## Timing and telemetry

Every snapshot, action, diff, find, wait and script answer carries `timing`:
`mode`, `snapshotMs`, `actionMs`, `observeMs`, `totalMs`, `chars`, `refs`,
`changed` and `truncated`. The agent host adds `toolMs` (client round trip) and
`resultChars` where it can measure them.

The server publishes one `browser.tool` telemetry event per call. It contains the
tool, session name, timing/counts and an error code — never page text, a URL query
value, a credential or observation text.

## The legacy walker is gone

AI is the only snapshot contract. The one-release `browser.snapshot_mode`
rollback was deleted in the release after AI became the default
(`improve-browser-agent-loop`, tasks 8.7/8.8): the setting, the `SNAPSHOT_SCRIPT`
DOM walker, `captureLegacySnapshot`, the `data-ac-ref` attribute and its selector
translation, the legacy action/status shape (`mode`) and the rollback tests no
longer exist. A configuration that still names `snapshot_mode` has no effect —
the key is not read — and nothing in a browser path injects attributes into a
page or resolves a ref through a selector.

`browser-snapshot-unsupported` (501) means the installed Playwright lacks the
public AI form; there is no fallback to a walker. `test/browser-removal.test.ts`
scans the browser sources so the deleted walker cannot reappear unnoticed.

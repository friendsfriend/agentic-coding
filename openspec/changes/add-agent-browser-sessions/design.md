# Design

## Context

Agents talk to the server with the owner-scoped environment capability
(change 6). The server is a single Bun process, packaged as one executable
(`docs/application-lifecycle.md`). Evidence store from change 7.

## Goals / Non-Goals

**Goals:** LLM-robust step tools; scriptable flows; low overhead; evidence the
developer can replay.

**Non-Goals:** cross-browser (Firefox/WebKit), login automation (apps run with
mock auth), visual diffing, remote/container browsers.

## Decisions

- **Spike first (task 1.1).** Verify in the compiled executable that
  `playwright-core` under Bun can (a) `chromium.launch` headless, (b) record
  video, (c) take ARIA snapshots with refs. Fallback if launch over pipes
  fails: spawn Chromium ourselves with `--remote-debugging-port=0` and
  `connectOverCDP`; if video does not work over CDP, record via CDP
  `Page.startScreencast` frames into WebM with the bundled ffmpeg-free path
  that Playwright uses, or degrade to screenshot sequences (document outcome).
- **Server-owned pool.** One Chromium process shared by all sessions; a session
  is a `BrowserContext` (isolated cookies/storage). Lower load than one browser
  per session; crash of the browser closes all sessions with a typed
  `browser-crashed` result and relaunch on next open.
- **Refs.** `browser_snapshot` returns Playwright's AI ARIA snapshot with
  `[ref=eN]`; action tools take `ref` (preferred) or a Playwright selector. If
  the internal snapshot API is unavailable, inject `data-ac-ref` attributes
  while walking the accessibility tree (fallback decided in the spike).
- **Endpoint resolution.** `browser_open({app, endpoint})` resolves the
  owner's instance endpoint and touches instance activity; any URL is allowed
  (agents have bash anyway), but only loopback and instance endpoints are
  pre-resolved.
- **Recording.** Playwright records video per context from creation.
  `browser_record_start` snapshots `storageState` and URL, creates a recording
  context, and restores them; `browser_record_stop` closes it to flush the
  WebM, takes a final screenshot as poster, attaches both when `keep`, deletes
  otherwise, and returns to a non-recording context. Max recording length
  10 min, then auto-stop with `keep: false` unless already stopped.
- **Script tool.** `AsyncFunction('page','context','expect', code)` with a
  timeout (default 60 s, max 10 min). Trusted code — agents already have bash —
  but it runs in the server process, so it receives only the session's page and
  context, not server internals. `save` wraps code in a `@playwright/test`
  spec template with the resolved base URL so the developer can rerun it.
- **Images to the model.** Screenshots return as image content blocks (JPEG,
  max 1280 px wide) plus the evidence id when stored.
- **Console/network.** Ring buffers per session (500 entries), filters by
  level/status/url substring.
- **Install.** Opt-in like the classifier: no download without explicit
  Install; uses Playwright's registry with `PLAYWRIGHT_BROWSERS_PATH` set to
  the config dir. System Chrome detected via `channel: "chrome"` when present.

## Risks / Trade-offs

- [Bun/Playwright incompatibility] → spike with explicit CDP fallback.
- [Chromium ~150 MB] → opt-in install; system Chrome path avoids it.
- [Script tool blocks server event loop] → Playwright calls are async; CPU-bound
  user code is bounded by timeout; documented.

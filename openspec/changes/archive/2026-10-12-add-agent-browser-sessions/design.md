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
  app's static endpoint, but only when the calling workflow holds that app;
  otherwise it returns `app-not-held` naming the holder, so an agent never
  tests another workflow's code by accident. It touches the app's activity.
  Any raw URL is allowed (agents have bash anyway).
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

## Hardening after review

The verification round found several places where a documented intent was not
what the code did. Each is fixed and covered by a focused test:

- **Concurrency.** `ensureBrowser` is single-flight (one launch, however many
  callers want it), the capacity check reserves a slot under an acquire gate
  before it awaits, and recording start/stop/auto-stop share one recording gate.
  A check that only holds when calls arrive one at a time is not holding at all,
  because the HTTP routes run concurrently.
- **A busy session is never swept.** Each request marks the sessions it uses, so
  the idle TTL cannot close a page under a `browser_run_script` that legitimately
  holds it for minutes.
- **The in-flight request index is bounded.** A response updates its ring entry in
  place and leaves the index, so neither the buffers nor the index grow with a
  polling page's lifetime.
- **A deliberately replaced context is not a crash.** Recording swaps a session's
  context; the swap guard keeps the session usable afterwards instead of stranding
  it behind `browser-crashed`.
- **A failed first navigation drops its session**, rather than leaving one a retry
  would "reuse" without ever reaching the URL.
- **Each recording owns its directory** (`mkdtemp`), so discarding one can never
  remove another session's WebM or another call's poster.
- **The install is read as a result, not as a state.** Only a directory Playwright
  marked `INSTALLATION_COMPLETE` counts, the revision the bundled Playwright
  expects wins when it is known, and the child runs with a minimal environment
  (PATH, HOME, the browsers path — no provider keys or integration tokens).
- **Images use the design's bound.** `BROWSER_MAX_IMAGE_WIDTH` is the capture
  ceiling for tool screenshots and posters, not the configured viewport width.
- **The script handle is guarded, and the comment now says what is true.** One
  Chromium serves every run, so `context.browser().contexts()` would reach other
  runs' sessions; the page/context handed to a script answer `context` with the
  session's own context and refuse the browser object. This is a guard against the
  ordinary Playwright path, **not a sandbox**: a script body still runs with the
  server process's globals, which is why the tool is only offered to runs that
  already hold a shell.
- **The Browser section's poll re-arms** when the section itself starts a
  download, its retry re-reads the browser status, and a failed status read clears
  the snapshot so an unreachable server is a retry row instead of a stale
  progress bar.

## Hardening after the second review round

The second round checked the fixes themselves. What it found, and what changed:

- **The script handle is an allow-list facade, not a deny-list proxy.** A blocklist
  cannot hold — `context.pages()` (and anything else handed back) returned raw
  objects carrying the very references the guard existed to hide. The handles a
  script receives are now built explicitly: only the named operations exist, every
  result is sanitized (pages and contexts become this session's facades, locators
  become locator facades, promises are resolved first, foreign contexts are
  refused), the facades are frozen, and the input devices are facades rather than
  the raw objects that point back at the page. Verified against a real Chromium:
  eleven public escape paths (`context.browser`, `page._browserContext`,
  `locator.page`, `keyboard.page`, `mouse.page`, `context.frames`,
  `pages[0].context().browser`, `newPage().context().browser`, …) reach nothing,
  while `page.click`/`locator().textContent()`/`screenshot()`/`keyboard.press()`
  and `page.context() === context` still work.
- **One open per session key.** Two concurrent opens of the same
  `(owner, name)` each reserved a slot and each registered a context under one
  session id, leaving one context unreachable and never closed. The key is
  serialized, so the second open joins the first session.
- **A released slot is handed to the queue, not dropped into the open pool.** The
  reservation travels with the wake-up, so a stream of new opens cannot overtake a
  waiter; `drop` wakes the queue before it awaits the close.
- **A busy session is not closed under its own work.** `browser_close` refuses a
  session with a request in flight (`session-busy`); `closeOwner` still releases at
  run end, where the run is over and the release is the only useful outcome.
- **The swap guard is one-shot.** The replacement context is created *before* the
  swap is announced, `finishSwap` unwinds the guard on every failure path, and a
  context that did not come from the browser the pool still serves never clears a
  crash mark: the session is marked crashed and the caller is told, rather than
  handed a dead page.
- **The recording gate is per session.** It sits on the hot path of every
  session-using request (`autoStopIfExpired`), so a pool-wide gate would let one
  session's video flush block every other run's snapshots and clicks; the
  not-recording case is answered without taking the gate at all.
- **Scratch directories are owned and always removed**, including the refusal a
  concurrent stop produces.
- **A revision this build does not expect is not a fallback.** When Playwright's
  expected Chromium revision is known and is not on disk, the browser counts as
  not installed, so the answer is "install it" rather than silently launching an
  older build.
- **The Browser section's reload key and its row order.** `R` re-reads the browser
  status like every other section's value, and the install row keeps its position
  and becomes inert while a download runs, with cancel appended below it, so a held
  `Enter` cannot cancel the download it just started.

## Hardening after the third review round

- **The script facade denies by default.** The gen-2 allow-list was only an
  allow-list going *in*: every result that was not one of the known shapes was
  handed over raw, and `page.goto()` resolves to a `Response`
  (`response.frame().page().context().browser()`) and `evaluateHandle` to a
  `JSHandle`. `wrap` now returns only primitives, bytes, plain JSON data (walked)
  and the session's own facades; a class instance — a `Response`, a `JSHandle`, a
  `Frame`, a foreign `ElementHandle` — is refused. Verified against a real
  Chromium (thirteen probes, all closed; clicks, locators, screenshots, keyboard
  input, `storageState()`, `boundingBox()` and `viewportSize()` still work).
- **One wake per freed slot.** A failed first navigation woke the queue twice
  (`drop` and the open's own `finally`) and a dropped *crashed* session woke a
  waiter although it never counted against the cap; both now answer "did this free
  a counted slot?" before waking, and the failed-open path marks the release it
  already performed.
- **The first navigation is work in flight.** A newly registered session is marked
  busy for its initial navigation, so a concurrent `browser_close` is refused
  (`session-busy`) instead of closing the page the open is still loading — and the
  idle sweep leaves it alone.
- **A swap never attaches to a session nobody holds.** `finishSwap` re-checks that
  the session is still registered (run end and shutdown drop sessions without
  waiting for in-flight work) and refuses rather than leaving an open context
  outside the pool's map.
- **The discard cannot strand a swap.** Removing a discarded recording's directory
  is best-effort: a cleanup failure is logged instead of leaving the swap guard
  set on a session with a closed context.
- **The compiled artifact carries the revision pin.** `scripts/build.ts` now
  generates `src/server/browser/bundled-playwright.generated.ts` (the bundled
  Playwright version and the Chromium revision from its `browsers.json`), and the
  install guard and the install command fall back to it, so the "install the
  revision this build expects" rule holds in the packaged executable and not only
  in a source checkout.
- **The Browser section's copy.** Cancelling reports the phase the server actually
  returned (`cancelled` / already-finished / nothing running) instead of assuming a
  running download, and the row that is temporarily inert keeps "editable" rather
  than borrowing the read-only suffix that means "edit the config file".

## Risks / Trade-offs

- [Bun/Playwright incompatibility] → spike with explicit CDP fallback.
- [Chromium ~150 MB] → opt-in install; system Chrome path avoids it.
- [Script tool blocks server event loop] → Playwright calls are async; CPU-bound
  user code is bounded by timeout; documented.

## Spike outcome (task 1.1)

`scripts/browser-spike.ts` runs the real driver and the real injected snapshot
script against a local static page, twice: from source (`bun
scripts/browser-spike.ts`) and from a compiled artifact (`bun build --compile`).

| Check | Source | Compiled |
| --- | --- | --- |
| `chromium.launch` headless | ok | ok |
| Video recorded | 9.3 kB WebM | 20.3 kB WebM |
| Snapshot refs | 3 | 3 |
| Click by ref took effect | ok | ok |
| Screenshot | 7.4 kB JPEG | 7.4 kB JPEG |

Decisions taken from it:

- **Bundling.** `playwright-core` bundles into the single-file executable once
  `chromium-bidi` is left external: it is a lazy `require` inside Playwright's
  BiDi-over-CDP path, which this server never takes, and is declared as no
  dependency of `playwright-core` itself. `scripts/build.ts` carries that one
  `external` and says why.
- **Refs.** The private `_snapshotForAI` API is deliberately not used. Injection
  is the fallback the design names: the page walk assigns `data-ac-ref="eN"`
  while it builds the tree, so `[ref=e7]` resolves to `[data-ac-ref="e7"]` with
  no second lookup table and no dependence on element identity across renders.
- **Video.** Recording works over the normal (non-CDP) launch. The WebM is
  complete only after the context closes, so the pool takes the video handle
  before closing the recording context and saves it afterwards; the final-frame
  poster is captured while the context is still open. No screencast fallback.
- **Install.** From a source checkout the install runs the packaged CLI
  (`bun node_modules/playwright-core/cli.js install chromium`) with
  `PLAYWRIGHT_BROWSERS_PATH` set to the config directory. A compiled artifact has
  no such file on disk, so the documented fallback is
  `bun x playwright-core install chromium`; a detected system Chrome needs no
  download in either case.

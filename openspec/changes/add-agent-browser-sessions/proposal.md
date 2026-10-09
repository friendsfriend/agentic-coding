# Proposal

## Why

Agents can start web apps but cannot see them. Verifying UI behavior,
reproducing a user-reported bug, or showing the developer what happened needs a
real browser plus screenshots and video. The existing `playwright-server`
infrastructure container is not used by agents, and a container browser cannot
reach apps published on host loopback without extra networking.

## What Changes

- A server-owned **browser pool** running local headless Chromium through
  `playwright-core` (new dependency). Chromium is an opt-in install into
  `~/.config/agentic-coding/browsers/` (Settings → Browser → Install), or a
  detected system Chrome is used without download.
- Sessions per durable run (default session plus named ones), capped by
  `browser.max_sessions` (default 4) with FIFO queueing of session opens;
  closed on run end and after idle TTL.
- Discrete tools for every durable run:
  `browser_open({url | app+endpoint, session?, viewport?})` (an app endpoint
  resolves to the app's static URL and requires the workflow to hold the app),
  `browser_snapshot` (accessibility tree with element refs),
  `browser_click`, `browser_fill`, `browser_press`, `browser_select`,
  `browser_hover`, `browser_wait({ref|text|url, timeoutMs})`,
  `browser_eval`, `browser_console`, `browser_network`,
  `browser_screenshot({ref?, fullPage?, evidence?, caption?})`,
  `browser_record_start`, `browser_record_stop({keep, caption})`,
  `browser_close`.
- `browser_run_script({code, save?, caption?})` runs Playwright JS against the
  session page server-side; `save` stores a standalone `repro.spec.ts` as
  `script` evidence.
- Screenshots return an image block to the model and are stored as evidence
  only when `evidence: true`; videos are kept only on `keep: true` with a
  final-frame poster.

## Capabilities

### New Capabilities

- `agent-browser-sessions`: browser install, pool and sessions, tool contract,
  script execution, evidence capture.

## Impact

- `agentic-coding/package.json` (`playwright-core`), new `src/server/browser/`,
  agent routes under `/api/v1/agent-env/browser/*`,
  `src/agent-host/browser-tools.ts`, settings + install dialog
  (pattern of the opt-in classifier install), `scripts/build.ts` if bundling
  needs adjustment.
- Depends on `add-agent-environment-tools` (capability/transport) and
  `add-workflow-evidence-store`.

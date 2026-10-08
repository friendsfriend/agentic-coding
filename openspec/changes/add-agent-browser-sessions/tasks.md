# Tasks

## 1. Spike

- [ ] 1.1 Verify launch, video and ARIA-ref snapshot with `playwright-core` in `bun run dev` and in the `bun run build` artifact; record the outcome and chosen fallbacks in `design.md`.

## 2. Install

- [ ] 2.1 Add Settings → Browser (install state, system Chrome detection, `browser.max_sessions`, `browser.idle_ttl_minutes`, viewport) and the opt-in install dialog; verify no download happens without Install.

## 3. Pool and sessions

- [ ] 3.1 Add `src/server/browser/pool.ts` (one Chromium, contexts per session, cap + FIFO queue, idle TTL, close on run end, crash handling); verify with a fake browser driver.
- [ ] 3.2 Add console/network ring buffers; verify bounds and filters.
- [ ] 3.3 Add recording start/stop with storage-state carry-over, poster, keep/discard, max length; verify file lifecycle against the evidence store.

## 4. Tools

- [ ] 4.1 Add agent routes `/api/v1/agent-env/browser/*` (owner-scoped) and `src/agent-host/browser-tools.ts` with all discrete tools; verify ref vs selector actions and image content blocks via a fake server.
- [ ] 4.2 Add `browser_run_script` with timeout and `save` → `repro.spec.ts` evidence; verify the saved spec contains the base URL and code.
- [ ] 4.3 Add an opt-in smoke test (`DEVENV_SMOKE_BROWSER=1`) driving a local static page: open, snapshot, click, screenshot evidence, record and keep video.
- [ ] 4.4 Add browser guidance to `agent-definitions/instructions/workflow-agent-protocol.md` (snapshot before acting; keep evidence only when it shows the bug or the fix).

## 5. Checks

- [ ] 5.1 Run `bun run lint`, `bun run type-check`, focused tests, and `bun run build` with zero diagnostics.

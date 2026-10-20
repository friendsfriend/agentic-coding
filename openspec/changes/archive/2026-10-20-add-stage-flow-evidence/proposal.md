## Why

Phase 1 (`add-stage-testing-foundation`) lets an agent open a logged-in, allow-listed session on a hosted stage. A process-flow test, however, spans several applications and roles (customer → clerk → installer), waits for asynchronous steps (mail, jobs) and must end in evidence a developer can follow: which step happened when, in which app, with which screenshot and which moment of which video. Today a recording is one context's video with a 10-minute cap, the recording swap drops sessionStorage (`agentic-coding/src/server/browser/pool.ts` re-opens with `storageState` only), every screenshot is returned into the model context, and waiting means polling turns — the measured cost drivers of `agentic-coding/docs/efficiency/03-synthesis.md` (RC2, RC5).

## What Changes

- **Step journal.** New agent tools `stage_step` (append a server-timestamped step: session, app/role, sanitized URL, label, expected, observed, captured values, evidence ids, optional knowledge observation) and `stage_journal` (bounded read-back that survives compaction). Stored as `stage-journal.jsonl` in the workflow's evidence directory, redacted on write.
- **Flow segments.** A recording on a stage session becomes a *segment*: journal steps written while it records carry the segment and the offset in milliseconds; when the segment is kept, the server back-fills the video's evidence id. The recording swap carries the current origin's sessionStorage so SPA logins survive. A per-run `limits.maxRecordingMinutes` bounds total kept video.
- **Flow page.** A deterministic renderer produces `stage-flow.html` beside the evidence: segments in order, each step a link `segment.webm#t=<s>` that seeks in the system browser; no new binary dependency.
- **Server-side waits.** `stage_wait({ session, until: { text | selector | url | mail }, reload?, intervalSeconds, timeoutSeconds })` polls inside the server within `limits.maxWaitSeconds` and answers once; a `mail-catcher` application with `api: "mailpit"` is queried through the Mailpit search API.
- **Screenshot context control.** `browser_screenshot` accepts `view: false` (requires `evidence: true`) to store without returning the image; stage sessions count stored screenshots against `limits.maxScreenshots` (`stage-screenshot-limit`).
- **Evidence panel.** Entries of a workflow that has a journal are grouped by flow segment with step captions and `mm:ss` offsets, and an "open flow" action opens `stage-flow.html`.

## Capabilities

### New Capabilities

- `stage-flow-journal`: the step journal, flow segments with offsets, server-side waits and the flow page.

### Modified Capabilities

- `agent-browser-sessions`: screenshots can be stored without being returned; the recording swap carries sessionStorage.
- `dashboard-evidence-panel`: flow grouping, step offsets and the open-flow action.

## Impact

- `src/server/browser/routes.ts`, `pool.ts`, `playwright-driver.ts`, `fake-driver.ts`; `src/contracts/browser.ts`; `src/agent-host/browser-tools.ts` (+ `stage_step`, `stage_journal`, `stage_wait`).
- `src/server/evidence/store.ts` (journal file beside the manifest; optional `segment` field on video entries).
- `src/tui/dash/` evidence panel and its keybind catalog.
- No new dependency, no store schema change. Depends on `add-stage-testing-foundation`.

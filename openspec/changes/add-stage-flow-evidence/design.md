## Context

The architecture of stage testing, its open questions and its phasing are in `openspec/changes/add-stage-testing-foundation/design.md` (decisions D5 and D7). This change is phase 2 and assumes phase 1's stage-bound sessions, redaction and limits. Verified current state: a recording is a swap onto a recording context with `storageState` carry-over and a 10-minute cap, kept only on request with a poster (`src/server/browser/pool.ts:346-390`, `openspec/specs/agent-browser-sessions/spec.md`); the evidence store refuses over cap and never evicts (`src/server/evidence/store.ts:45-50`); the evidence panel renders screenshots/posters inline and opens videos externally (`openspec/specs/dashboard-evidence-panel/spec.md`).

## Goals / Non-Goals

**Goals:** a reproducible, server-timestamped step record across sessions; a followable video story across applications; waits that cost one tool call; screenshots that do not inflate the context.

**Non-Goals:** a single stitched video file (would need `ffmpeg`); a video player inside the terminal; the stage-test workflow itself (phase 3).

## Decisions

- **Journal is server-written JSONL beside the evidence manifest.** Server timestamps and recording offsets cannot be forged or mis-ordered by the model; a file needs no store schema change and is deleted with the evidence on `workspace.cleanup`. Alternative rejected: journal in the agent's output artifact (lost on compaction, no trustworthy offsets).
- **Segments, not one video.** Playwright records per context; roles live in separate contexts (phase 1, D5). A segment is one kept recording; offsets are computed from the recording start the server already knows. Alternative rejected: one shared context for all roles (SSO cookie collisions, one 10-minute cap for the whole flow).
- **Flow page with media fragments.** `stage-flow.html` uses relative paths to evidence files and `#t=` fragments, opened by the system opener the panel already uses for video. It is rendered deterministically from journal + manifest, redacted, and is regenerated on each journal change — and on each manifest change too (an attached screenshot, a kept recording with its back-filled `video` id), because a step's link and its captions both come from the manifest; a workflow without a journal gets no page at all, which is what the panel's "no open-flow action" keys off.
- **sessionStorage carry-over.** Before the swap, read `sessionStorage` of the current origin via `page.evaluate`; install it on the recording context with `addInitScript` scoped to that origin. Alternative rejected: forbid recording after login (the login must never be on video, phase 1).
- **Waits in the server.** `stage_wait` reloads (optional) and checks the condition every `intervalSeconds` (≥ 5) until `timeoutSeconds` (≤ `limits.maxWaitSeconds`); it counts as one action against the rate limit. Mailpit is the one mail API supported; any other catcher is driven as a UI application.
- **`view: false`.** Valid only with `evidence: true`; the result names the evidence id and caption instead of an image.
- **The journal names its version.** Every line carries `v: 1`. Two operations rewrite the whole file from what parsed (`backfillStageJournalVideo`, `clearStageJournalSegment`), so a journal a newer build wrote is refused with its version named rather than silently normalised — a rewrite would drop every field this build does not know. Alternative rejected: validate-only reads, which would let a rewrite destroy the newer entries.
- **Discard is a rewrite, not just a dropped file.** A recording stopped without keeping it takes `segment`/`offsetMs` off the steps written during it, and the page is re-rendered: the spec forbids a step pointing at a video nobody kept. The steps keep their sequence numbers, so a discard never renumbers the run.
- **Segment numbers are issued above the journal, not only from a counter.** A resumed run shares the evidence directory, so a start takes `max(counter + 1, highest journal segment + 1)`; the per-workflow counter is released with the run like every other per-workflow ledger.
- **The flow page is written under the evidence root lock.** It re-checks the journal inside the lock, so a render can never recreate the directory chain of a workflow whose evidence was just removed — the failure the lock exists for. The dashboard's journal read is cached by `(mtime, size)`; the writer clears that cache, and an unchanged file costs a `stat` rather than re-parsing up to 20 MB per refresh.
- **Budgets are reserved, not just counted.** A recording grant is reserved when it is told out and settled on stop (kept minutes, or nothing for a discard), so two starts of one workflow cannot be told the same remainder; a reservation also expires with its own bounded recording, so a stop that never happens cannot hold the budget. The screenshot bound is checked before the capture and charged only once the entry exists, so a failed capture spends nothing.

## Risks / Trade-offs

- [sessionStorage restore misses tokens kept in memory only] → the tester reports a lost login as `blocked`; re-login is refused while recording, so the segment is stopped, login repeated, a new segment started.
- [Flow page opened outside the data root] → paths are relative and the page lives in the same directory as the evidence; nothing is served by the server.
- [Long waits keep a run alive] → bounded by `maxWaitSeconds` and the policy ceiling; segments are stopped before long waits so no video idles. Every poll step is itself bounded and re-checks the session, so a page that never answers a `document` query — or a session the developer closed underneath the wait — ends the wait instead of holding it past its own bound.
- [Journal growth] → `stage_journal` reads are bounded (latest N, filter by session/app); the file itself is capped at the evidence per-file limit and refuses further steps with `stage-journal-full`.

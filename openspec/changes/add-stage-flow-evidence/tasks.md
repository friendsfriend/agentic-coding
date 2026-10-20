## 1. Journal and segments

- [x] 1.1 Add the journal writer/reader beside the evidence store (`src/server/evidence/`): JSONL append with sequence, server time, sanitized URL, redaction on write, evidence-id existence check, per-file cap → `stage-journal-full`.
- [x] 1.2 Track recording start per stage session in `pool.ts`; attach segment and offset to journal entries; back-fill the kept video's evidence id (optional `segment` field on the manifest entry); enforce `maxRecordingMinutes` → `stage-recording-limit`.
- [x] 1.3 Carry the current origin's sessionStorage through the recording swap (`page.evaluate` read + origin-scoped `addInitScript`).
- [x] 1.4 Agent tools `stage_step` and `stage_journal` (+ codemode list, descriptions stating server timestamps and redaction).

## 2. Waits and screenshots

- [x] 2.1 `stage_wait` route and tool: one-of condition, interval ≥ 5 s, timeout capped by `maxWaitSeconds`, optional reload, Mailpit search for `mail` on `mail-catcher` apps with `api: "mailpit"`; counts as one action for the rate limit.
- [x] 2.2 `browser_screenshot` `view: false` (contract, route, tool result without image) and `maxScreenshots` counting on stage sessions.

## 3. Flow page and evidence panel

- [x] 3.1 Deterministic `stage-flow.html` renderer from journal + manifest (relative paths, `#t=` fragments, redacted), regenerated on journal/manifest change.
- [x] 3.2 Evidence panel: segment grouping with step offsets, trailing unreferenced group, open-flow action in the panel keybind catalog; unchanged rendering without a journal. Check footer and `?` help after adding the keybind.

## 4. Focused checks

- [x] 4.1 Tests with the fake driver and temporary data roots: journal append/refusal/read-back, offsets and back-fill, recording budget, sessionStorage carry-over, `stage_wait` met/timeout/cap and a fake Mailpit endpoint, `view: false`, screenshot cap, flow page links, panel grouping render test. Run only these files plus `bun run type-check` and `bun run lint` in `agentic-coding/`.
- [x] 4.2 Run one real stage flow end to end (record a segment, write steps, wait for a mail, open `stage-flow.html`) against a configured stage on this machine, and check the Evidence panel's footer and `?` help show the open-flow keybind. **Recorded as pending for the developer** (the assignment's own assumption): it needs a configured stage, a live application and a mail catcher, none of which an unattended run may use, so the automated scope above is complete without it and the change must not end `blocked` on it.

## 5. Verifier round 1

- [x] 5.1 Discarded recording drops its segment from the steps it filed (`clearStageJournalSegment` + re-render), so no step points at a video nobody kept.
- [x] 5.2 Mail wait resolves the catcher through the stage app's configured ident as well as its key (`apps.<key>.app`), so an aliased mail app is not refused as unsupported.
- [x] 5.3 Journal write-time shape: the file size is read with `fstat` (no re-serialization for the cap), free text is folded to the read contract's shape, a URL is bounded at 2048, and every line carries `v: 1` — a journal of another version is reported, never rewritten.
- [x] 5.4 Exact segment numbering across a resumed run: a start is issued above the highest segment the journal already names, and the per-workflow counter is released with the run.
- [x] 5.5 Recording budget is reserved when granted and settled on stop (kept or discarded), so two starts cannot be told the same remainder; the screenshot bound is checked before the capture and charged only after the entry exists.
- [x] 5.6 `stage_wait` bounds every poll step and re-checks the session, skipping the reload once its own bound has passed; the URL glob is matched by a linear walk rather than a regular expression.
- [x] 5.7 `stage-flow.html` is written under the evidence root lock and re-checks the journal inside it, so a render cannot resurrect a removed workflow's evidence; the dashboard's journal read is cached by `(mtime, size)`.
- [x] 5.8 Redaction is composed with URL sanitizing for the journal and the page, and a `sessionStorage` carry verifies the origin before and after its read — in both directions of the recording swap.
- [x] 5.9 Evidence panel: height counts painted rows (a journal-only flow keeps its listing), a collapsed panel says how many rows it has no room for, `Enter` on a step row opens the flow page, `y` explains there is no file to copy, and a journal read failure is reported once instead of silently dropping the flow.

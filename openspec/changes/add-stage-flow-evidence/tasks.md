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

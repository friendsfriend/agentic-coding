## 1. Journal and segments

- [ ] 1.1 Add the journal writer/reader beside the evidence store (`src/server/evidence/`): JSONL append with sequence, server time, sanitized URL, redaction on write, evidence-id existence check, per-file cap → `stage-journal-full`.
- [ ] 1.2 Track recording start per stage session in `pool.ts`; attach segment and offset to journal entries; back-fill the kept video's evidence id (optional `segment` field on the manifest entry); enforce `maxRecordingMinutes` → `stage-recording-limit`.
- [ ] 1.3 Carry the current origin's sessionStorage through the recording swap (`page.evaluate` read + origin-scoped `addInitScript`).
- [ ] 1.4 Agent tools `stage_step` and `stage_journal` (+ codemode list, descriptions stating server timestamps and redaction).

## 2. Waits and screenshots

- [ ] 2.1 `stage_wait` route and tool: one-of condition, interval ≥ 5 s, timeout capped by `maxWaitSeconds`, optional reload, Mailpit search for `mail` on `mail-catcher` apps with `api: "mailpit"`; counts as one action for the rate limit.
- [ ] 2.2 `browser_screenshot` `view: false` (contract, route, tool result without image) and `maxScreenshots` counting on stage sessions.

## 3. Flow page and evidence panel

- [ ] 3.1 Deterministic `stage-flow.html` renderer from journal + manifest (relative paths, `#t=` fragments, redacted), regenerated on journal/manifest change.
- [ ] 3.2 Evidence panel: segment grouping with step offsets, trailing unreferenced group, open-flow action in the panel keybind catalog; unchanged rendering without a journal. Check footer and `?` help after adding the keybind.

## 4. Focused checks

- [ ] 4.1 Tests with the fake driver and temporary data roots: journal append/refusal/read-back, offsets and back-fill, recording budget, sessionStorage carry-over, `stage_wait` met/timeout/cap and a fake Mailpit endpoint, `view: false`, screenshot cap, flow page links, panel grouping render test. Run only these files plus `bun run type-check` and `bun run lint` in `agentic-coding/`.

## 1. Composition
- [ ] 1.1 Confirm contextual launch predecessor is implemented; inventory all CLI/Herdr dash call sites and classify each dashboard command/popup as required operation or removed browsing.
- [ ] 1.2 Add explicit dashboard-only root composition using the existing dashboard and shared services; never mount the full feature shell for dash.
- [ ] 1.3 Preserve explicit workflow/standalone identity resolution and bounded invalid-target errors without fallback to Home or a picker.

## 2. Restricted surface
- [ ] 2.1 Remove tabs, breadcrumbs, picker, Home/Settings/feature routes and all corresponding keyboard/mouse registrations from dash mode.
- [ ] 2.2 Remove standalone trace/artifact browsing callbacks; preserve required review/approval/question/credential/confirmation dialogs, inline metrics and revision-bound operational controls.
- [ ] 2.3 Keep local panel focus/scroll/help/exit and modal precedence; update catalogs so both footer and complete help contain only applicable commands.
- [ ] 2.4 Preserve API/subscription and owned-versus-attached lifecycle setup, including startup failure, exit and ongoing workflow execution; remove obsolete full-shell dashboard callbacks.

## 3. Validation
- [ ] 3.1 Add render/input tests proving dash has no navigation chrome, destinations or hidden global handlers; test keyboard/mouse and invalid identity behavior.
- [ ] 3.2 Test required workflow reviews, answers, credentials and action submissions with revision/capability enforcement; verify inline status/metrics remain.
- [ ] 3.3 Test owned and attached cleanup without duplicate coordinators, accidental server termination or workflow data deletion.
- [ ] 3.4 Open a real Herdr-launched dash and full app; check narrow/wide rendering, local focus, footer and `?` help; record end-to-end launch/closure evidence.
- [ ] 3.5 Update CLI docs and obsolete full-shell dash expectations; run relevant tests, type-check, zero-diagnostic lint and strict OpenSpec validation.

# Proposal

## Why

The dashboard's Evidence panel spends a fixed eight-row band of the detail grid
listing every manifest entry, so a run with a long manifest turns the panel into
a scroll list and pushes the agents list upward. What the developer actually
needs from that row is one glance — *what did this run keep?* — and then a
place to read it: the report an agent wrote (when one exists) beside the full
evidence it cites. Today that report has no dashboard home at all, and the panel
shows only rows.

## What Changes

- The Evidence panel becomes a **summary**: one line of kind counts
  (`3 screenshots · 10 logs · 1 video`), singular/plural correct, zero-count
  kinds omitted, every manifest kind covered (screenshot, video, trace, script,
  log, other). The empty, loading and error states are kept, and the panel's
  height drops from the fixed listing band to the title row plus at most one
  summary row. **BREAKING** for the panel's own surface: it no longer lists
  entries, renders the selected entry's image or metadata, or acts on
  `Enter`/`y` per row.
- `Enter` on the summary opens an **evidence subview** — a page of the dashboard
  body (the same mechanism as the agent-session page), with `Esc` returning to
  the panel grid.
- The subview is two panes: the run's **markdown report on the left** and a
  **sidebar on the right listing every evidence entry** of the workflow, reusing
  the existing newest-first, debug-request-grouped rows and their labels.
  `Enter` on the focused sidebar entry opens that file through the existing
  side-app/system-opener path, and `y` copies its stored path (the panel's old
  copy behavior moves here). The selected entry's existing metadata lines stay
  available under the list.
- The report is **optional and never generated**. An agent attaches one by
  flagging a markdown evidence entry as the report: `evidence_attach` gains an
  optional `report` flag, and the store records `report: true` on that manifest
  entry (kind `other`, markdown text). The newest flagged entry is the report;
  every other entry, and every manifest written before the flag existed, keeps
  working unchanged. This is the smallest change to `workflow-evidence-store`:
  one optional boolean on the entry/attach contract, no new kind, no new
  lifecycle, no rename of stored paths.
- Citations use the **wiki's own syntax**, `[^<evidence-id>]`, resolved against
  the workflow's manifest: a resolved citation keeps that marker, an unresolved
  one renders as a visibly broken marker and is listed as unknown in the report
  pane's sources section. Rendering reuses the wiki's markdown renderer (the
  same `parseMarkdownBlocks` / block renderer pair the wiki page uses) rather
  than a new markdown implementation.
- Screenshots cited in the report render **inline** when the renderer reports
  kitty graphics (the existing capability probe, so a multiplexer that cannot
  pass images through answers "no"): the existing `<image>` renderable is
  mounted only in that branch and only after its bytes load. Without kitty the
  cited screenshot gets the existing metadata/text fallback instead.
- The affected specs (`dashboard-evidence-panel`, `workflow-evidence-store`),
  the workflow-architecture evidence section and the dashboard module map are
  updated to match.

## Capabilities

### New Capabilities

None. The dashboard surface stays in the existing `dashboard-evidence-panel`
capability and the attach contract stays in `workflow-evidence-store`.

### Modified Capabilities

- `dashboard-evidence-panel`: the panel's listing requirement becomes a
  kind-count summary requirement; new requirements for the evidence subview
  (report pane, full sidebar, back navigation), citation resolution with a
  visibly broken unknown case, the optional-report empty state, and the
  kitty-gated inline rendering of cited screenshots; the external-open
  requirement now names the subview's sidebar as the surface that opens a file
  and keeps the copy-path behavior there.
- `workflow-evidence-store`: a new requirement lets one evidence entry be
  flagged as the workflow's report — markdown text, at most one effective
  report (the newest flag), backward compatible with manifests that carry no
  report.

## Impact

- Contracts: `src/contracts/environment.ts` (entry gains an optional `report`
  flag; attach request gains the flag).
- Store and routes: `src/server/evidence/store.ts` (validate/record the flag,
  refuse a non-markdown or non-text report), `src/server/evidence/routes.ts`
  (forward the flag), `src/agent-host/environment-tools.ts` (`evidence_attach`
  parameter and description).
- Dashboard: `src/tui/dash/panels/EvidencePanel.tsx`,
  `src/tui/dash/evidence-panel.ts`, `src/tui/dash/evidence-open.ts` (reused,
  unchanged behavior), a new evidence report view model, a new subview page,
  `src/tui/dash/App.tsx` (page state, keymap field, cited-image reads, report
  read), `src/tui/dash/handlers/keys.ts`, `src/tui/dash/keybinds.ts`,
  `src/tui/dash/keymap-setup.ts`, `src/tui/data/evidence.ts` (report text read).
- Docs: `docs/workflow-architecture.md` (evidence store section),
  `src/tui/dash/README.md` (module map).
- Tests: `test/dash/evidencePanel.test.tsx`, `test/dash/evidenceKeys.test.ts`,
  a new report/citation view-model test, plus store/route tests for the flag.
- No dependency changes and no new workflow type.

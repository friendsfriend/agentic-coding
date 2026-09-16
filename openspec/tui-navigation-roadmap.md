# TUI navigation redesign roadmap

## Approved outcome

Default full application opens Home with **Environments, Observability, Wiki and Settings**. Navigation uses selectable pages, one breadcrumb row and one location picker, not nested tabs or a persistent navigation tree.

```text
Home
├── Environments
│   ├── Applications → selected application → environment features / Start workflow
│   ├── Libraries → selected library → repository features / Start workflow
│   ├── Infrastructure
│   ├── Scripts
│   └── Kubernetes
├── Observability → Traces / Metrics / Logs / Topology
├── Wiki → browse/review knowledge / independent research or wiki start
└── Settings → Appearance / Agent models and presets / Providers and credentials
               / Projects and environments / Backend and telemetry
```

Application/library settings links open the same Settings implementation with project scope. Repository-related research/wiki workflows start on resource pages, not Wiki. Wiki owns independent starts and existing independent comment-review submission. Herdr manages workflow workspaces and their dashboard access.

**No global or project-local workflow lists, history/reopen views or active-workflow dashboard launchers.** Removing these is presentation cleanup, not durable data deletion or new workflow-close semantics. Explicit CLI identity access and existing recovery remain supported.

`agentic-coding dash` renders only its targeted dashboard, with operational dialogs, local panel controls and help. No full-app shell, tabs, breadcrumbs, picker, settings navigation or unrelated browsing drill-downs.

## Implementation order

| Order | Change | Hard prerequisite | Outcome |
| --- | --- | --- | --- |
| 1 | [replace-nested-tabs-with-page-navigation](changes/replace-nested-tabs-with-page-navigation/proposal.md) | Existing merged frontend | Page hierarchy, breadcrumbs, picker, one navigation authority |
| 2 | [centralize-application-settings](changes/centralize-application-settings/proposal.md) | 1 | All supported settings reachable centrally; old model editor entry replaced |
| 3 | [launch-workflows-from-project-and-wiki-pages](changes/launch-workflows-from-project-and-wiki-pages/proposal.md) | 1, 2 | Contextual starts and Herdr handoff; workflow browser deleted |
| 4 | [isolate-workflow-dashboard-mode](changes/isolate-workflow-dashboard-mode/proposal.md) | 3 | Explicit dashboard-only composition and restricted command surface |

All artifacts are planning documents. Unchecked tasks mean implementation has not been performed. Artifact readiness is not predecessor completion. Execute and archive in order, then re-read later deltas against updated base specs. Changes 1 and 3 intentionally update the same shell requirement: change 1 allows a temporary workflow entry, change 3 removes it after replacement launch/configuration is ready.

## Release gate

Do not present the temporary workflow page as the final design. Ship the full redesign only when all four changes pass their checks and no temporary entry survives. Record feature/route, supported-setting and workflow-type/target parity inventories; explicitly record the approved removal of workflow browsing and unrelated standalone dash navigation.

Verify full journeys: Home → application/library → Start workflow → Herdr dashboard; Wiki → independent start and comment review; Settings with local versus attached-server ownership; observability drill-down and cross-domain Back versus Parent; dashboard-only input isolation; owned/attached exit behavior. Navigation is Escape (with `Alt+Up`) = Parent, `Ctrl+O`/`Alt+Left` = Back, `Ctrl+I`/`Alt+Right` = Forward. Check actual TUI footer and complete `?` help at narrow/wide widths, plus relevant tests, type-check and zero-diagnostic lint.

## Boundaries and concurrent work

This plan follows the imported/unified frontend and does not depend on retiring Go beyond existing typed APIs. Rebase implementation against ongoing runtime/telemetry changes without overwriting them. No new router/form framework, backend rewrite, config database consolidation, automatic repository relocation, new lifecycle semantics or workflow storage deletion is included.

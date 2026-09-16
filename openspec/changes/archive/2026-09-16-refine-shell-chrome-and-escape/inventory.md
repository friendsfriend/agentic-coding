# Inventory: chrome rows and keybind surfaces

Audited on the current tree. Disposition uses the chrome rule from
`design.md`: a row may name the page only when no breadcrumb names it, and no
chrome row advertises keybinds.

## Shell chrome (`src/tui/otel/app/App.tsx`)

| Row | Content today | Disposition |
| --- | --- | --- |
| Logo bar (`bgMantle`, 1 line) | `AGENTIC CODING`, attached label, feature badge | keep (chrome root) |
| Breadcrumb row (`BreadcrumbRow`) | structural ancestor chain | keep — becomes the identity line |
| Destination page title | `Home` / `Environments` / `Settings` / `Observability` | remove (echo of the breadcrumb's last segment) |
| Destination page description | `Choose a destination. Ctrl+P jumps anywhere.` (Home only) | remove (keybind hint; footer catalog lists `Ctrl+P`) |
| Destination page spacer | empty 1-line box | remove |
| Settings section title + description | `Appearance`, `Theme and client-local UI preferences`, … | remove the chrome rows; the same strings stay as destination-row descriptions in `destinations.ts` and in the picker |

## Shell page bodies

| View | Row | Disposition |
| --- | --- | --- |
| `otel/views/TraceListView.tsx` | `SearchHeader` title `Traces` | drop the name; keep search mode / result count |
| `otel/views/MetricsView.tsx` | `Metrics (n)` | drop the name; keep `(n)` |
| `otel/views/LogsView.tsx` | `Logs (n)` | drop the name; keep `(n)` |
| `otel/views/SpanDetailView.tsx` | span name row | drop; keep the data row (`service · duration · status`) |
| `otel/views/SpanDetailView.tsx` | `Attributes` section header | keep (section, not identity) |
| `otel/views/MetricDetailView.tsx` | metric name row | drop; keep `service · type · unit`, stats block, sparkline |
| `otel/views/MetricDetailView.tsx` | `Bucket distribution` | keep (section) |
| `otel/views/LogDetailView.tsx` | `SEVERITY: body` row | drop; keep `service · timestamp` and the `Body` section |
| `otel/views/ServiceDetailView.tsx` | `Service details` row | remove (echo) |
| `otel/views/TopologyView.tsx` | `>50 services: adjacency list`, empty state | keep (data / empty state) |
| `otel/app/App.tsx` traces tree | `Span tree` + `n visible` | keep (section + count) |
| `otel/views/WikiView.tsx` | list/note bodies | keep; verify no identity row duplicates the crumb |
| `shared/navigation/LocationPicker.tsx` | `Enter opens · Esc closes` | remove the bespoke row; modal footer via `HelpText` |
| `otel/components/StatusBar.tsx` | footer keybinds | keep — the single keybind home for the shell |

## Embedded environment views (`packages/devenv/ui/src/components`)

Identity rows render only while no shell chrome is present (standalone). Rows
that carry data keep their data columns.

| Component | Identity row | Disposition (embedded) |
| --- | --- | --- |
| `Table.tsx` | `SearchHeader` active tab label (+ `n loaded`, running summary) | suppress the label; keep counts and search input |
| `ChangeRequestView.tsx` | `Change requests` + page/state columns | suppress the label |
| `IssueView.tsx` | `Issues` + scope/page columns | suppress the label |
| `ReferencesView.tsx` | `References` + count | suppress the label; keep count |
| `TimelineView.tsx` | `title` / `Discussions` / `Timeline` | suppress the label |
| `HelpView.tsx` | help title + tab labels | suppress the page-level label; keep tabs |
| `JobsDetailView.tsx`, `ChangedFilesView.tsx`, `TestResultsDetailView.tsx` | `SearchHeader` label + data columns | audit per row; suppress pure labels, keep pipeline id / file / test data |
| `KubernetesClusterView.tsx`, `ListViewModal.tsx`, modal headers | modal/section titles | keep (modal, not page chrome) |
| `AppDetailView.tsx`, `ProvidersView.tsx`, `IssueDetailView.tsx`, `ChangeRequestDetailView.tsx`, `AgentSpaceView.tsx`, pickers | no identity row (panel grids) | no change |

## Other surfaces

| Surface | Row | Disposition |
| --- | --- | --- |
| `packages/devenv/cli/src/tui/views/header-helpers.ts` + `Header.tsx` (standalone) | title / context / detail; `right: "? help"`, `"? close"` | keep identity and data (no breadcrumb exists there); remove the keybind hint text |
| `src/tui/dash/ui/Header.tsx` (dashboard) | change / phase / branch / updated | keep; no keybind text found |
| `src/tui/shared/HelpModal.tsx`, `ModalHelpOverlay`, modal footers | keybind listings | keep — the `?` help contract |

## Keybind surfaces to update

| Catalog | Today | New |
| --- | --- | --- |
| `shared/navigation/keybinds.ts` | `Esc back` | `Esc up` + `Ctrl+O`/`Alt+Left` back + `Ctrl+I`/`Alt+Right` forward |
| `otel/app/keybinds.ts` (traces detail/span, metrics, logs, topology, wiki, environments) | `Esc/b back…` | `Esc up`; `b` alias removed |
| `settings/state.ts` catalog | `Alt+Up parent` | `Esc up`, `Alt+Up` alias, `Ctrl+O`/`Alt+Left`, `Ctrl+I`/`Alt+Right` |
| `packages/devenv/cli/src/tui/keyboard/keymap-metadata.ts` + `global-keys` help content | feature-local Escape wording | matches the ladder ("up one level", cancel, close) |
| `dash/keymap-setup.ts` `SHELL_KEYS` | `ctrl+p`, `alt+up` | add `ctrl+o`, `ctrl+i`, `alt+left`, `alt+right` |

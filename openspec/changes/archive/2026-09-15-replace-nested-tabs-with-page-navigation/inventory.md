# Navigation inventory (task 1.1)

Evidence base for replacing shell/nested tab bars with pages, one breadcrumb row
and one location picker. Paths are relative to `agentic-coding/`. Line numbers
are the pre-change baseline and only anchor the reading; the source of truth is
the file.

## 1. Entry points (`src/tui/index.tsx`)

| Mode / flag | Composition | Current landing |
| --- | --- | --- |
| (no command), `--home`, `manager` | `AppShell` with environments + dashboard(home) + observability | `features` first row, active feature = `environments` (features present) |
| `dash --repo P --workflow-id W` | `AppShell`, no environment surface | dashboard pane (`workflows`/`detail`) |
| `attach URL` (no token) | environment surface only | `environments` |
| `attach URL --attach-token` | remote unified server, no environment surface | `workflows` |
| `--profile test` | in-process demo | dashboard (`workflows`) |
| `--json` | headless, no renderer | n/a |
| `--traces-only` | restriction | filters rendered rows to workflow/wiki/traces |
| `--devenv-url`, `--demo-db`, ports | surface/telemetry wiring | no navigation effect |

Renderer/keymap ownership is one root: `createCliRenderer` + `setupKeymap` +
`KeymapProvider` in `index.tsx`; `AppShell` → `otel/app/App.tsx` `App`;
environments body injected via `renderEnvironments` → `app/EnvironmentsFeature.tsx`
→ `packages/devenv/cli/src/tui/app-opentui.tsx` (`embedded` mode).

## 2. Shell rows today (`src/tui/otel/app/App.tsx`)

- Feature row (`featureTabs()`): `environments` (when environment surface),
  `workflows` (when dashboard), `observability`, `wiki` (home mode only).
- Second row (`observabilityTabs()`): `traces`, `metrics`, `logs`, `topology`
  (traces only under `--traces-only`).
- Rendered by `otel/components/TabBar.tsx`; mouse select wired to
  `selectFeature` / `switchTab`.
- Legacy flat `tabs()`/`tabIds()` still drives number-key dispatch.
- Feature router: `src/tui/shared/routes.ts` (`FeatureId`, `FeatureRoute`,
  per-feature stacks, single `origin`).
- Observability local views: `otel/app/navigation.ts` `createNavigation()`
  (`selection` → `detail` → `span`) plus a `modalStack`.

## 3. Shell keyboard/mouse entry points

| Key | Handler | Effect |
| --- | --- | --- |
| `1`..`9` | `App.handleKey` | activate row item by index (features, then observability sub-row) |
| `t` / Tab / Shift+Tab / Ctrl+I | `App.handleKey` | cycle feature row (forward/back) |
| `Esc`, `b` | `App.handleKey`, `nav.esc()` | close modal → pop local view → restore `origin` |
| `?` | `App.handleKey` | help modal over `activeKeybindCatalog()` |
| `Shift+T` | `App.handleKey` | theme picker |
| `q` (twice) | `App.handleKey` | quit |
| `/`, `F`, `O`, `w` | traces handlers | search/filter/sort/workspace |
| Enter | traces/metrics/logs/topology handlers | open detail |
| TabBar mouse-up | `TabBar` | same as number-key selection |

Catalog: `otel/app/keybinds.ts` `observabilityKeybindCatalog()` /
`environmentsKeybindCatalog()`; footer `otel/components/StatusBar.tsx`; help
`shared/HelpModal.tsx`.

## 4. Environments destinations (imported feature)

Store authority: `packages/devenv/cli/src/tui/stores/app-store.ts`
(`activeTab`, `viewMode`, `viewStack`, `modalStack`, per-tab filters/sort).

Inner tab row (`tableTabs`, rendered inside `views/content-router.tsx`):

| tab id | label | destination |
| --- | --- | --- |
| `applications` | Applications | repository table |
| `infrastructure` | Infrastructure | infrastructure table |
| `libraries` | Libraries | library table |
| `scripts` | Tasks | task/script tree table |
| `kubernetes` | Kubernetes | cluster panels |
| `ui-test` | UI Test | `ProgressAnimationDemo` (dev-only, `showUiTestTab`) |

Inner tab entry points: `keyboard/table-keys.ts` (Tab/Shift+Tab cycling, `1`–`5`
direct), mouse-up on the inline tab boxes in `content-router.tsx`.

`viewMode` destinations reachable from tables (`appStore.setViewMode`,
`views/content-router.tsx`, `keyboard/*-keys.ts`):

- `table` → `appDetail` (`actions/app-actions.ts` `openAppDetail`)
- `table` → `actions` (`ActionsView`, action run modal)
- `issues` → `issueDetail` → `issueTimeline`; `references` (issue
  cross-references)
- `changeRequests` → `changeRequestDetail` → `changedFiles`, `discussionsView`,
  `testResults`, `jobs`, `changeRequestLinkedIssues`
- overlays/modes: `help`, `sshPicker`, `agentView`, `providers`, plus modal
  stack (`modal-overlays.tsx`, `modal-stack-runtime.ts`)

Environment operations that must stay reachable (parity): app/infra/library/
script actions, provider connect, issue list/detail/timeline/references, CR
list/detail/changed files/discussions/tests/jobs/linked issues, agent
utilities, SSH picker, log viewer, theme picker, help/guides.

## 5. Observability destinations

| destination | entry | child |
| --- | --- | --- |
| Traces | `TraceListView` | `TraceTreeView` → `SpanDetailView` |
| Metrics | `MetricsView` | `MetricDetailView` |
| Logs | `LogsView` | `LogDetailView` |
| Topology | `TopologyView` | `ServiceDetailView` |

Entry points: `/` search, `F` filter, `O` sort, `w` workspace, Enter to open,
`Esc`/`b` back (view-local handlers in `App.tsx`). `modalStack` kinds:
`filter`, `sort`, `theme`, `help`, `environment`.

## 6. Wiki destination

`otel/views/WikiView.tsx`: tree (`selected`, `expanded`) → note
(`note`, `noteIndex`, `selectedLine`, `visualStart`, `visualMode`,
`commentMode`, `commentText`). Review session (`wikiComments`,
`wikiSubmitting`) deliberately lives in `App.tsx` above conditional content so
tab switches cannot drop drafts. `f` finishes the review, `r` refreshes,
`?` opens help. Wiki is home-mode only today, reachable through its own feature
row entry (not from Home).

## 7. Workflow (temporary bridge)

`dash/Home.tsx` + `dash/App.tsx` rendered from `App.tsx`; own keymap catalog and
`modal.active` data key. Contextual launch and centralized Settings are other
changes in the roadmap, so this stays a page until they land.

## 8. Restrictions to preserve

- `--traces-only`: metrics/logs/topology hidden from every entry point, Wiki
  unaffected, workflow entry unaffected.
- Environment surface absent (dash, remote attach): no Environments destination
  and no environment keybind catalog.
- Wiki requires home mode (repository-independent).
- `ui-test` tab only when `showUiTestTab`.

## 9. Route-local state to preserve (task 3.2 input)

| Owner | State |
| --- | --- |
| Shell (`App.tsx`) | `selectedListIndex`, `_selectedTraceId`, `treeIndex`, `selectedSpan`, `activeWorkspace`, filter/sort/search/pane signals, `selectedMetricIndex`, `selectedLogIndex`/`selectedLog`, `topologyDetail`, `logFilterQuery`, `wikiComments` |
| WikiView | `selected`, `expanded`, `note`, `noteIndex`, `selectedLine`, `visual*`, `commentMode`, `commentText` |
| Environments | per-tab filters/sort (`tableFiltersByTab`), `selectedIndex`, `tableSearch*`, `viewStack`, kubernetes panel index + scroll refs, detail store scroll refs, drafts in modals (task args, reply text) |
| Dashboard | own stores/keymap data |

Filter/sort/search edits and modal opens must not create history entries.

## 10. Replacement route map (target)

Home (no parent) →
`Environments` [Applications, Libraries, Infrastructure, Scripts, Kubernetes] →
resource page → {Detail, Actions, Issues, Issue detail, Timeline, References,
Change requests, CR detail, Changed files, Discussions, Test results, Jobs,
Linked issues};
`Observability` [Traces, Metrics, Logs, Topology] → trace tree → span /
metric detail / log detail / service detail;
`Wiki` (browse → note);
`Workflows` (temporary bridge page).

Structural parent: child → its category page; category page → its feature page;
feature page → Home. Back is chronological across all of these.

## 11. Parity evidence (must remain green)

- `test/app/routes.test.ts` (route reducer)
- `test/app/appShell.test.tsx`, `test/app/appShellMount.test.tsx`
- `test/otel/shellHelp.test.tsx`, `test/otel/keybinds.test.ts`,
  `test/otel/observabilityKeyTracing.test.tsx`
- `test/dash/keybindCatalog.test.tsx`, `test/dash/dashboardFooter.test.tsx`,
  `test/dash/panelNavigation.test.tsx`
- environment keyboard suites: `packages/devenv/cli/src/tui/keyboard/*.test.ts`
  (`nav-keys`, `global-keys`, `table-*`, `keymap-*`, `modal-*`)
- `test/actions-tui-journey.test.ts`, `test/runtime-tui-journey.test.ts`

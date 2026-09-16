## Context

`src/tui/index.tsx` composes the full shell, and the shell uses the presence of a dashboard to select the workflow detail route. Hiding tab rows would leave global commands, feature mounts and navigation callbacks active. Existing dashboard content includes both workflow-operation dialogs and optional browsing popups; these must be classified rather than indiscriminately deleted.

## Goals / Non-Goals

Goals: `dash` is only the supplied workflow dashboard, no application navigation or unrelated detail browsing, no duplicated dashboard implementation. Non-goals: rebuilding dashboard panels, removing required workflow review/answer/action controls, deleting engine recovery/data, changing workspace-close semantics or adding replacement workflow lists.

## Decisions

1. Select an explicit application versus dashboard presentation mode at the CLI/TUI boundary. A minimal DashboardRoot renders the existing dashboard and its shared theme, notifications, modal host and contextual keymap. ApplicationRoot owns pages/breadcrumbs/picker. Reuse existing initialization functions; do not create an abstract root factory or mount the full shell invisibly.
2. DashboardRoot accepts the existing explicit workflow/repository target contract, including supported standalone target resolution. Missing or invalid identity reports a bounded error and exits with correct cleanup; it never falls back to Home or a workflow picker. Home/manager/default continue to select the full application's Home.
3. Register only dashboard operational commands, panel focus/scroll/selection, required reviews/questions/approvals/confirmations, help and explicit exit. No shell route registration, global destination numbers, `t` cycling, Parent, Back-to-Home, Settings, picker, trace navigation or standalone artifact browser callbacks. Remove their mouse entrances as well as keyboard handlers. Tab follows page-local focus rules; J/K/H/L retains dashboard grid movement. Escape closes the current operational dialog/local mode but never enters another page.
4. Inventory each existing dashboard popup/action and classify it as required workflow operation or unrelated browsing. Preserve review/comment/diff/verdict content needed to decide, question/credential requests, user actions and existing explicit revision-bound workflow preset adoption. Persistent model/preset CRUD belongs exclusively to Settings. OpenSpec proposal/design content renders inside the dashboard's own artifact panel and inside a required plan review; the full application's artifact/trace/observability routes and drill-down destinations are never mounted or registered in dash mode. Inline status and per-agent telemetry metrics remain; no telemetry detail destinations are mounted.
5. Keep the same typed API/subscriptions, revision/capability checks, modal identity, durable outbox semantics and server-owned coordinators. Presentation does not own workflow execution. Reuse existing lifecycle setup only for services the dashboard needs. Normal exit and startup failure dispose owned client resources once; attached clients never stop the server. Do not infer workflow cancellation or data deletion from closing a renderer.
6. Full-app launches now delegate workspace/dashboard access to Herdr. There is no second full-shell workflow-detail route to maintain as an alternative browser. Operational dialogs use shared components, not a reduced-fidelity dashboard fork.

## Risks / Trade-offs

The artifact-view spec currently describes a generic dashboard popup; narrow its applicability explicitly rather than accidentally retaining its navigation command. Required operational review content must not disappear alongside browsing links. Existing raw input handlers can bypass a hidden catalog; tests must exercise keyboard and mouse absence, not only screenshots.

## Migration Plan

After contextual launch replaces the workflow home route, introduce DashboardRoot and route all explicit dash/Herdr invocations through it. Classify and restrict commands before deleting old shell callbacks. Run managed and attached lifecycle tests and a real Herdr launch journey. No state migration or deletion. Rollback changes composition only, never execution records.

## Open Questions

None blocking. User explicitly requires no dashboard navigation options. Operational dialogs remain only where needed to operate the workflow, not as alternative browsing destinations.

## Inventory and classification (task 1.1)

CLI/Herdr call sites — every one routes to `src/tui/index.tsx main()` with an
explicit target:

- `src/cli.ts` — the `dash` surface dispatch, the `--json` headless read and
  `--profile test`.
- `src/workflow/effect-runner.ts` (workspace bootstrap) — renames the workflow
  tab to `dashboard` and runs
  `agentic-coding dash --repo <repo> --workflow-id <id>` in the workspace root
  pane. This is the only production invocation, and the reason a bounded
  invalid-target error beats a fallback picker (nobody is watching the pane to
  answer one).

Composition confirmations: the contextual-launch predecessor
(`launch-workflows-from-project-and-wiki-pages`) is in the tree, so no workflow
list, history or reopen surface exists to preserve and no shell route reaches
the dashboard pane any more.

Shell surface previously composed around dash, now absent entirely: the tab
projection, breadcrumb row, destination pages (Home, Settings, environments,
observability, wiki), the `Ctrl+P` location picker, `Alt+Up` structural parent,
shell focus-region `Tab` cycling, the shell key layer and shell-overlay layer,
and the shell-side keybind catalogs (observability/destination/settings).

Dashboard surface classification — retained, because each is the dashboard's
own workflow-scoped panel or dialog rather than application navigation:

| Kind | Retained |
| --- | --- |
| Panels | Change, Agents, OpenSpec artifacts; `J/K/H/L` grid movement, `j/k` scroll/selection |
| Operations | `Enter` (gate approval, review, artifact open, agent focus), `O` repair, `m` revision-bound preset adoption, `c` cost, `v` verifier result, `r` refresh, `Esc` return to the Herdr workspace |
| Dialogs | developer/plan/wiki review, developer question, credentials, completed-actions picker, required user action, repair, findings, verdict, plan rejection, preset switcher, cost, theme, help |
| Inline | phase/status badges, per-agent telemetry lines, git status |

Removed as dead code (no handler or caller): the events detail modal (its
signal was never set, so `EventsModal` was unreachable) and the unused
`ChangedFilesBrowser`/`TraceBrowser` components.

Retention decision: the dashboard's own dialog set is kept as-is — including
the OpenSpec artifact panel and the theme picker — and only the application
shell around dash is removed. Decision 4 is narrowed accordingly: the removed
artifact surface is the full application's artifact route and drill-down, not
the dashboard's workflow-scoped panel.

## Launch evidence (task 3.4)

Recorded locally, under a pseudo-terminal (`script -q /dev/null …`); this is
**not** a Herdr launch and does not replace the manual check:

| Command | Result |
| --- | --- |
| `bun src/cli.ts dash --profile test` | renders the workflow dashboard (header, Change/Agents panels, plan-review dialog, dashboard footer); zero occurrences of the shell chrome markers `Choose a destination`, `Ctrl+P`, `Locations` in the captured output |
| `bun src/cli.ts dash --repo /nonexistent --workflow-id demo` | exits `2` with `dashboard target repository does not exist: …` and the usage line; no renderer, no Home |
| `bun src/cli.ts home --devenv-port 4711` | still renders the full application: `Home` destination list with Environments, Observability, Wiki, Settings and `Choose a destination`, plus the `Starting unified server` startup row |

Still to be checked by a human in Herdr: the tab renamed `dashboard`, narrow
and wide rendering, local focus/scroll, footer and `?` help content, and the
launch/closure journey (Herdr starts the pane, the dashboard exits without
stopping anything it does not own).

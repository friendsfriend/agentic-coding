# Workflow launch and home destinations

Status: `launch-workflows-from-project-and-wiki-pages`.

Workflow creation belongs to the resource page that owns the target. The full
application has no workflow browser: no global or project-local list, no
history or recent list, no active-workflow launcher and no closed-workflow
reopen entry. Herdr owns workspace access; the full application stays on the
page the user started from.

This file is the human-readable mirror of
`agentic-coding/src/tui/dash/launch.ts` (the launch context and outcome
classification) and `agentic-coding/src/tui/shared/routes.ts` (the page
catalog). The code is authoritative.

## Home destinations

Home offers exactly **Environments**, **Observability**, **Wiki** and
**Settings**, plus the **New workflow** action. The action is the one launch
that is not tied to a page: it opens the creation form for a directory outside
the configured projects, prefilled with the working directory and editable to
any other path. It is an in-place action, never a page or a location-picker
destination, so Home still has no workflow list, history or browser.

## Where work is created

| Target | Entry point | Workflow types |
| --- | --- | --- |
| Configured application or library | The Applications/Libraries list's `w` (Start workflow) and the resource page's `w` (Start workflow) | The whole `PUBLIC_WORKFLOW_CATALOG` (openspec family, no-openspec, repository-bound wiki, repository-bound research) |
| Any directory outside the configured projects | Home's **New workflow** action (working directory or entered path) | The whole `PUBLIC_WORKFLOW_CATALOG` |
| Wiki | The Wiki page's `w` (New workflow) | `research` only, with no repository context |
| Wiki comments | The Wiki page's `f` (Finish review) | The `wiki-comments` review workflow, unchanged |

The environment list moves the worktree manager to `W` (Shift+W) so `w` starts
work for the highlighted row.

Repository-related research and wiki work therefore launches from
application/library pages; Wiki launches repository-independent work only. This
is a launch-location rule, not a restriction on browsing centralized knowledge
that mentions repositories.

## The launch context

`WorkflowLaunchContext` is immutable: `{kind: "project", ident, name,
repository}`, `{kind: "path", repository}` or `{kind: "independent"}`. The
creation form has **no** repository, custom-path or standalone-target selector —
only workflow type, agent preset, ticket, workflow id, task and (where the
target allows a choice) the checkout mode. The `path` context is the one
exception: it shows its `repository` as an editable first step, so the working
directory stays a confirmation instead of a silent default. Types come from
`PUBLIC_WORKFLOW_CATALOG`; the context only restricts the permitted set, so
role/workflow tables are never duplicated in the TUI.

Availability and capability are resolved from the configured catalog:

- A project removed or unavailable before submission blocks the start with an
  actionable error. There is no scan, clone or retarget fallback.
- The authenticated backend revalidates identity, target, capability and
  authorization at submission; the client check is advisory.
- Existing workflows keep their pinned checkout, worktree and store.

## Start outcomes

`launchWorkflow` submits through the existing typed start boundary and reports
one of three outcomes. They are never collapsed into one message, and none of
them resubmits the request:

| Outcome | Meaning | UI |
| --- | --- | --- |
| `rejected` | Nothing was created (validation, unavailable project, 4xx) | Error notification; the user may correct and start again |
| `accepted` | Durable acceptance; the workflow id is named | Success notification naming the workflow; the full application stays on the page |
| `uncertain` | The request failed without an answer (network failure, 5xx) | Error modal stating that a workflow may exist; reconcile from the Herdr workspace list instead of starting it again |

After an accepted start, `watchAcceptedHandoff` reports a *post-acceptance*
Herdr handoff failure once, by workflow id, through the existing
execution-error surface, and points at the existing repair/reconciliation
semantics. Closing a Herdr-managed workspace creates no recent/history/reopen
entry here.

## What was removed, and what was not

Removed: the Workflows destination and page, the workflow list and its
keybindings, filter/sort catalogs, directory watchers and list subscriptions,
the workflow-row Git summary, and the overview-only `isStale` projection.

Retained: explicit CLI targeting (`agentic-coding workflow …`), Herdr
integration and sidebar presentation, the headless workflow list read used by
`agentic-coding --json`, execution coordinators, durable storage and the
outbox, telemetry, recovery, and repository Git/issue/change views on
environment resource pages. Removing presentation does not garbage-collect
stored workflows.

## Verification

- `bun test` — `test/dash/contextualLaunch.test.ts`,
  `test/dash/handoffWatch.test.ts`, `test/dash/newWorkflowModal.test.tsx`,
  `test/app/contextualLaunchJourney.test.tsx`, `test/app/pages.test.ts`.
- `packages/devenv/cli/src/tui/keyboard/workflow-keymap-layers.test.ts` — the
  resource page reports its configured identity and advertises the action in
  the footer/`?` catalog as `w`.
- `packages/devenv/cli/src/tui/keyboard/table-keymap-layer.test.ts` — the
  list's `w` reports the selected application/library, `W` opens the worktree
  manager, and the start action is advertised on Applications/Libraries only.
- `bun run type-check`, `bun run lint`, `openspec validate --strict`.

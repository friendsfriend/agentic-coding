## Why

Workflow creation belongs to the application or library being worked on, not a separate workflow browser. Herdr already manages workflow workspaces; duplicating active/history/reopen lists in this TUI adds navigation without user value.

## What Changes

- Add contextual Start workflow to application and library resource pages, with repository identity already selected.
- Launch repository-related research/wiki work from those same resource pages; launch independent research/wiki work only from Wiki.
- **BREAKING** Remove the Workflows destination, global and project-local workflow lists, history/reopen UI, and active-workflow dashboard launchers. Do not replace the global list with a local one.
- Hand successful launches to existing Herdr-managed workspace/dashboard behavior; keep the full application on its originating page.
- Preserve workflow types, engine state, explicit CLI targeting, authorization, pinned checkouts, durable outbox and recovery semantics.

## Capabilities

### New Capabilities
- `contextual-workflow-launch`: Project-bound and independent launch flows with Herdr handoff and no workflow browsing UI.

### Modified Capabilities
- `unified-feature-shell`: Final Home destinations and workflow capability ownership.
- `configured-workflow-project-catalog`: Catalog supplies contextual launch identities without requiring workflow history discovery in the TUI.
- `dashboard-overview-git-status`: Remove the obsolete workflow-overview Git presentation requirement with the overview itself.

## Impact

Depends on `replace-nested-tabs-with-page-navigation` and `centralize-application-settings`. Reuses `src/tui/dash/ui/NewWorkflowModal.tsx`, `dash/Home.tsx` creation logic, `dash/engine.ts` start transport, Wiki launch/review flows, configured project catalog and existing Herdr orchestration. No new workspace manager or workflow execution semantics.

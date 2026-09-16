## Context

`src/tui/dash/Home.tsx` currently combines list discovery, repository selection, workflow start and model configuration. `NewWorkflowModal.tsx` accepts project options, supports custom repository input and standalone research, and derives types from `PUBLIC_WORKFLOW_CATALOG`. Existing start transport and server orchestration already own workflow creation and Herdr integration. The new TUI must not reproduce these backend responsibilities.

## Goals / Non-Goals

Goals: Home → Environments → Applications/Libraries → selected project → Start workflow; Wiki → independent research/wiki start; Herdr-owned workspace access; no workflow browser. Non-goals: project-local history, recent/active workflow lists, a reopen shortcut, data deletion, new lifecycle semantics, removal of explicit CLI tools, or turning environment actions into workflow steps.

## Decisions

1. Depend on navigation and Settings so removing Home's workflow list does not strand configuration or creation. Final Home contains exactly Environments, Observability, Wiki and Settings. Remove Workflows from routes, picker entries, catalogs, full-app aliases and rendered content. The final UI has no global or project-local workflow list, active-workflow link, history page or closed-workflow reopen action.
2. Reuse the existing creation form with an explicit immutable launch context: configured project identity or independent Wiki target. Application/library forms omit repository/custom-path/standalone selectors. Wiki forms omit repository selection and expose only target-compatible research/wiki types. Read supported workflow definitions and target validation from their existing registry; do not duplicate role or workflow-type tables. Keep task, preset, workflow-specific options and necessary OpenSpec selection.
3. Resolve project availability/capabilities and canonical root through the configured catalog. Show target checkout and existing checkout-mode choices explicitly; active environment checkout is not automatically the workflow worktree. The authenticated backend revalidates identity and target at submission. A removed/unavailable project blocks new repository work with an actionable error; no scan/clone/retarget fallback. Existing workflows keep pinned locations.
4. Repository-related research/wiki creation starts only on application/library pages. Wiki launches are independent, including existing wiki-comment review submission. This is a launch-location rule, not a restriction on browsing centralized knowledge that mentions repositories. Preserve centralized target paths, wiki comments, research semantics and standalone operation with an empty project catalog.
5. Submit through the existing typed start API and preserve its accepted/start failure semantics, capability checks, definition pins and durable retries. Do not mount another coordinator in the resource page. Disable duplicate submission while pending and follow existing request identity/reconciliation rules after uncertain responses. An accepted workflow whose Herdr handoff fails must be reported distinctly from a rejected start; use existing repair semantics rather than starting a second workflow or adding a workflow list.
6. On successful creation, existing Herdr behavior owns the workflow workspace and its `dash` invocation. The full application retains its originating application/library/Wiki page and gives a bounded success notification. Do not navigate the full app to an embedded dashboard or add a persistent launcher. Closing that workspace does not create a reopen UI here; storage and existing server lifecycle/recovery behavior are unchanged.
7. Delete list-only UI, polling/discovery subscriptions, keybindings and overview-only projections after checking callers. Retain APIs/data access used by CLI, Herdr, observability, explicit workflow identity access or recovery. Workflow storage is not garbage-collected as a consequence of removing navigation. Preserve repository Git/issue/change visibility on environment resource pages; the obsolete workflow-row Git summary is intentionally removed. The Herdr-launched dashboard's Change/overview panel keeps its own compact Git line, so `dashboard-overview-git-status` is not modified by this change.

## Risks / Trade-offs

Herdr failures after durable acceptance need distinct notification and existing repair handling; retrying creation blindly risks duplicate work. Backend project capabilities may change between opening the form and submit; server validation is authoritative. Removing list presentation is an intentional feature removal, not missing parity. No independent research launch is placed on Home or project pickers; Wiki is the only full-app independent entry.

## Migration Plan

Move Settings first, then add contextual forms and validate every existing public workflow type against its permitted target contexts. Preserve wiki-comment finish behavior. Remove workflow home/list route and list-only consumers only after replacement start journeys pass. Update launch docs and old home/manager expectations. Archive after predecessor deltas; this change deliberately replaces the same shell requirement modified by navigation.

## Open Questions

None. User explicitly rejected both global and project-local workflow lists and delegated workspace access to Herdr. Independent work belongs to Wiki; repository-related work belongs to application/library pages.

## Context

`src/tui/app/AppShell.tsx` composes `src/tui/otel/app/App.tsx` and the embedded Environments feature. `src/tui/shared/routes.ts` currently stores per-feature stacks plus a single cross-feature origin; this is insufficient for arbitrary chronological multi-domain Back. The shell consumes Tab, numbers and `t`; observability renders a second row and the imported environment content router owns additional table tabs. Local selection/detail/span navigation and environment selection state must stop competing with shell route identity.

## Goals / Non-Goals

Goals: one location model, keyboard-first category pages, no navigation tab bars, preserved feature capabilities and state. Non-goals: a sidebar tree, persisted session restoration, global backend resource search, workflow-engine changes or a second router framework. Repeated data views that are true navigation destinations become routes; tabs inside necessary input dialogs are not automatically page destinations.

## Decisions

1. Extend/replace the existing pure route reducer rather than adding a router dependency. Use typed route variants with required project/trace/resource identities, deterministic parent resolution, chronological history and route-keyed view state. Navigation, Back and Parent are explicit operations. Filter changes do not create history entries. Multiple cross-domain hops must unwind correctly; a single origin pointer is not enough.
2. Default launch and full-application home/manager aliases open Home. Preserve explicit supported route modes such as telemetry restrictions. Intermediate Home retains a temporary workflow destination until changes 2 and 3 in the roadmap replace its configuration and launch capabilities. Final Home has only Environments, Observability, Wiki and Settings.
3. Environments opens Applications, Libraries, Infrastructure, Scripts and Kubernetes. Observability opens Traces, Metrics, Logs and Topology, subject to existing feature availability. Selecting an application/library opens a resource page; existing subviews become child destinations, not another tab row. Inventory all existing provider, issue, PR, CI, utility and runtime views before removing their old entrances.
4. Render one breadcrumb row from structural ancestors, never history. Ancestors navigate to actual pages. Collapse middle segments under narrow widths; preserve the current label and keyboard access to hidden ancestors. The location picker searches registered destinations and available in-memory route identities; it does not scan repositories or invent a global resource index.
5. Proposed bindings: Enter opens selection, Esc closes the top overlay then cancels local input mode then goes Back, Alt+Up opens Parent, Ctrl+P opens the location picker. Audit and resolve collisions in the owning catalogs before committing these bindings. Tab/Shift+Tab moves between current page's focus regions; J/K/H/L keeps dashboard grid semantics. No global number or `t` cycling. Escape at Home is a no-op. Quit remains explicit. Mouse and keyboard invoke the same navigation operations.
6. Store selected resource IDs, query/filter/sort, scroll, focus and unsaved drafts independently of page visibility. Prefer existing stores rather than keeping hidden input handlers mounted. Deleted identities resolve to the nearest valid parent with a notification; drafts are not silently submitted or persisted. Modal identity remains in the existing authoritative modal host; a modal does not add a breadcrumb.
7. Services retain existing application/backend ownership and do not start/stop on route transitions. A foreground tool must continue asynchronous waiting and lease renewal. No API or outbox behavior changes.

## Risks / Trade-offs

- Removing several tab authorities can leave invisible handlers: remove old registrations and test inactive pages explicitly.
- Resource-level routes need identity translation from environment stores: retain canonical project ID and existing checkout semantics, not display-name keys.
- Category pages add one keystroke: the picker supplies direct jumps without permanent screen chrome.
- Default Home changes launch behavior intentionally; document it rather than restoring implicit last-feature selection.

## Migration Plan

Implement pure route tests, then chrome/category pages, then migrate each environment and observability destination. Reuse current views. Retain workflow launch/configuration entry only as a documented bridge until their replacement changes land. Do not announce the complete navigation redesign until the roadmap's release gate passes. Revert frontend composition if needed; no durable migration requires rollback.

## Open Questions

None blocking. Exact key collisions and any additional destination names are resolved through the existing command/feature inventory, without changing the approved hierarchy.

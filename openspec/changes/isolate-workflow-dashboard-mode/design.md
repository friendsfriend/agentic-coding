## Context

`src/tui/index.tsx` composes the full shell, and the shell uses the presence of a dashboard to select the workflow detail route. Hiding tab rows would leave global commands, feature mounts and navigation callbacks active. Existing dashboard content includes both workflow-operation dialogs and optional browsing popups; these must be classified rather than indiscriminately deleted.

## Goals / Non-Goals

Goals: `dash` is only the supplied workflow dashboard, no application navigation or unrelated detail browsing, no duplicated dashboard implementation. Non-goals: rebuilding dashboard panels, removing required workflow review/answer/action controls, deleting engine recovery/data, changing workspace-close semantics or adding replacement workflow lists.

## Decisions

1. Select an explicit application versus dashboard presentation mode at the CLI/TUI boundary. A minimal DashboardRoot renders the existing dashboard and its shared theme, notifications, modal host and contextual keymap. ApplicationRoot owns pages/breadcrumbs/picker. Reuse existing initialization functions; do not create an abstract root factory or mount the full shell invisibly.
2. DashboardRoot accepts the existing explicit workflow/repository target contract, including supported standalone target resolution. Missing or invalid identity reports a bounded error and exits with correct cleanup; it never falls back to Home or a workflow picker. Home/manager/default continue to select the full application's Home.
3. Register only dashboard operational commands, panel focus/scroll/selection, required reviews/questions/approvals/confirmations, help and explicit exit. No shell route registration, global destination numbers, `t` cycling, Parent, Back-to-Home, Settings, picker, trace navigation or standalone artifact browser callbacks. Remove their mouse entrances as well as keyboard handlers. Tab follows page-local focus rules; J/K/H/L retains dashboard grid movement. Escape closes the current operational dialog/local mode but never enters another page.
4. Inventory each existing dashboard popup/action and classify it as required workflow operation or unrelated browsing. Preserve review/comment/diff/verdict content needed to decide, question/credential requests, user actions and existing explicit revision-bound workflow preset adoption. Persistent model/preset CRUD belongs exclusively to Settings. OpenSpec proposal/design content can still render within a required plan review, but no generic artifact browsing drill-down is offered in standalone dash. Inline status and per-agent telemetry metrics remain; no telemetry detail destinations are mounted.
5. Keep the same typed API/subscriptions, revision/capability checks, modal identity, durable outbox semantics and server-owned coordinators. Presentation does not own workflow execution. Reuse existing lifecycle setup only for services the dashboard needs. Normal exit and startup failure dispose owned client resources once; attached clients never stop the server. Do not infer workflow cancellation or data deletion from closing a renderer.
6. Full-app launches now delegate workspace/dashboard access to Herdr. There is no second full-shell workflow-detail route to maintain as an alternative browser. Operational dialogs use shared components, not a reduced-fidelity dashboard fork.

## Risks / Trade-offs

The artifact-view spec currently describes a generic dashboard popup; narrow its applicability explicitly rather than accidentally retaining its navigation command. Required operational review content must not disappear alongside browsing links. Existing raw input handlers can bypass a hidden catalog; tests must exercise keyboard and mouse absence, not only screenshots.

## Migration Plan

After contextual launch replaces the workflow home route, introduce DashboardRoot and route all explicit dash/Herdr invocations through it. Classify and restrict commands before deleting old shell callbacks. Run managed and attached lifecycle tests and a real Herdr launch journey. No state migration or deletion. Rollback changes composition only, never execution records.

## Open Questions

None blocking. User explicitly requires no dashboard navigation options. Operational dialogs remain only where needed to operate the workflow, not as alternative browsing destinations.

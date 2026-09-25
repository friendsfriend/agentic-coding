# Design: Developer-action notifications

## Context

See `proposal.md` for motivation and `specs/workflow-developer-notifications/spec.md` for the behavior contract.

Current state that shapes the approach:

- The workflow engine already declares a `notification.show` effect kind and executes it in `effect-runner.ts` as `herdr notification show <title> --body <body>`, but no step enqueues it. Effects are gated by each step's `allowedEffects`, and `registry.ts` `stepDigest()` includes that list, so adding the kind to more steps would change pinned digests and strand in-flight workflows. Notification is therefore not a durable-outbox feature in this change.
- `workflow/sidebar.ts` already derives "developer input owed" from a `WorkflowView` plus live Herdr observations: committed `paused`/`attention-required`, available actions with `requiresInput`, pending developer questions, and fresh/retained `blocked` runtime state. `workflow/sidebar-observer.ts` is the application-scoped owner that reads views plus observations and coalesces refreshes.
- The home shell starts that owner via `server/operations/engine.ts` `startSidebarPresentation`; the per-workflow `agentic-coding dash` pane does not run it. `readSidebarObservations` in `workflow/sidebar-sync.ts` batches `agent list` / `pane list` / `tab list` / `workspace list`.
- Each repository workflow's workspace contains a tab whose base label is `dashboard`, running `agentic-coding dash --repo … --workflow-id …` (`effect-runner.ts` `ensureWorkspaceTabs`). `workflow/tab-status.ts` `findAgentTabByBase` matches that tab even when it carries a status glyph.
- Herdr 0.9.1 `notification.show` accepts only title/body/position/sound; it carries no pane/click target, and the Herdr client focuses a pane on toast click only when a `pane_id` is present. Herdr toast delivery is one global `ui.toast.delivery` switch with no per-kind or per-agent filter.

## Goals / Non-Goals

**Goals:**

- One Herdr notification per false → true transition into a developer obligation, naming the workflow and the phase.
- Focus the workflow's dashboard tab when that notification is raised.
- Reuse the sidebar's obligation semantics and observation reads instead of a second phase/role table.
- Stay presentation-only, opt-in, bounded, and free of store/definition changes.

**Non-Goals:**

- No durable notification for an obligation that arises while no Agentic Coding shell is alive (there is no background daemon).
- No click-to-focus, because Herdr 0.9.1 custom notifications carry no click target; focus happens when the notification is raised.
- No finished-only toast muting, because Herdr 0.9.1 has no per-kind toast filter; only documented Herdr configuration is offered.
- No editing of `~/.config/herdr/config.toml`, no new outbox effect kind, no step/definition digest change, no workflow store migration.

## Decisions

### Presentation observer, not a durable effect

A new application-scoped owner (`workflow/notification-observer.ts`) mirrors `SidebarPresentation`: it reads views plus a batched observation read on a bounded interval and on dashboard reconcile triggers, and it is disposed with the shell. This avoids the `allowedEffects`/`stepDigest` blast radius of the outbox route and keeps notification failures out of the engine transaction path. Alternative rejected: enqueue `notification.show` from reducers, which requires new step versions because `allowedEffects` is part of `stepDigest()`.

### Reuse the sidebar obligation projection

The trigger is a pure function over the same inputs the sidebar already uses. `workflow/notifications.ts` composes `workflowRequiresInput`, `runRequiresDeveloperInput`, `paneInputFacts`, `currentRunForPane`, `projectLabel`, and `phaseLabel` from `workflow/sidebar.ts`. This keeps "developer input owed" identical between the sidebar marker and the notification, and it means a change to the obligation rule changes both at once. Alternative rejected: a separate notification-specific predicate, which would drift from the sidebar.

### Transition-dedup with an initial baseline

The observer keeps `Map<workflowId, boolean>` of the last owed state. It notifies only on false → true. The first observation of a workflow records the baseline without notifying, so restarting the shell does not replay every outstanding obligation; the sidebar marker still shows them. Once a workflow clears, the next obligation notifies again. Alternative rejected: notify on every refresh while owed, which would spam.

### Custom notification plus programmatic focus

Because Herdr 0.9.1 cannot click-focus a custom notification, the observer raises `notification show` with `--sound request` and, in the same step, focuses the dashboard. Order is focus first, then notify. Custom notifications are not suppressed by the active tab (no `workspace_id`/`tab_id`/`pane_id`), so the toast still appears after focus. Alternative rejected: reporting the dashboard pane as a synthetic agent to obtain a native clickable needs-attention notification — it would make the dashboard appear as a managed agent and depends on Herdr's integration authority contract.

### Dashboard tab resolution by base label

Focus resolves the dashboard tab with `findAgentTabByBase(tabs, "dashboard")` in `view.workspace`, then `workspace focus` + `tab focus`. A missing tab or workspace is skipped and reported at most as a bounded diagnostic. Alternative rejected: persisting a dashboard tab id in workflow metadata, which would add a store field and a write path for a presentation-only concern.

### Opt-in trusted preference

`ui.herdr_notifications` is read through a new `herdrNotificationsEnabled()` in `workflow/effects.ts`, matching `herdrSidebarEnabled()`: trusted user config only, default `false`, first existing config file wins. Notifications and focus can be intrusive, so default-off with documentation is the conservative integration posture already used by `ui.herdr_sidebar`. The preference is independent of `ui.herdr_sidebar`; the notifier runs even when the sidebar is off.

### Owner starts in the home shell

The notifier is registered and started through `server/operations/engine.ts` from the home shell, reusing the existing governed repository provider set and reconcile triggers, so there is exactly one notifier process per session. The per-workflow dash pane is deliberately not a second owner to avoid double notifications. The accepted limitation is that the home shell must be running; this matches the existing sidebar's no-daemon lifetime rule and is documented.

## Risks / Trade-offs

- No shell running → no notification for obligations that arise while the developer is away. Mitigation: document the lifetime rule; the sidebar marker remains the durable on-screen indicator.
- A global Herdr toast setting governs both finished and developer-action toasts, so finished-only muting is impossible on 0.9.1. Mitigation: document the settings, record the upstream per-kind filter as a follow-up change, and keep the notifier working under any delivery setting that shows toasts.
- Focus steals focus when a notification is raised. Mitigation: opt-in preference; focus only on a new obligation, never on refresh while already owed.
- Notification delivery can be rate-limited or report `busy`/`disabled`/`no_foreground_client`. Mitigation: treat any delivery outcome as the obligation being raised, never retry in a loop, and surface one bounded diagnostic.
- Two owners would double-notify. Mitigation: a single owner created by the home shell; the dash pane does not start one.
- The observer reads views and agent state on a timer in addition to the sidebar owner. Mitigation: only while opted in, on the existing bounded interval, with the same coalescing; a first step can share the batched read if duplication is measured to matter.

## Migration Plan

1. Ship the preference default `false`; nothing runs or is written to Herdr until an operator opts in.
2. Opt in by setting `ui.herdr_notifications: true` in the trusted user config, alongside the documented Herdr notification settings.
3. Roll back by clearing the preference or restoring the previous config; no schema, migration, or durable state is involved. Agent processes, workflow stores, and Herdr topology are untouched.

## Open Questions

- Whether a future settings-surface toggle should expose `ui.herdr_notifications`, which is deferrable and does not change the spec or task shape.

# Proposal

## Why

When a workflow needs something from the developer — a plan/developer-review approval, an answer to a pending developer question, or a blocked agent prompt — nothing tells the developer outside the dashboard. The workflow's Herdr dashboard pane and the home shell only show the attention marker once the developer looks at them, and Herdr's own notifications are dominated by background agent-finished toasts that carry no workflow or phase information. The developer wants one Herdr notification naming the workflow and the phase whenever a workflow owes developer input, and to be taken to that workflow's dashboard when the notification is raised.

## What Changes

- Add a presentation-only developer-action notifier: on each bounded refresh it reads the governed workflow views plus live Herdr agent observations, and raises exactly one Herdr notification per false → true transition into "developer action required" for a workflow. The notification title is the workflow identity and the body is the current phase label.
- "Developer action required" reuses the existing sidebar semantics rather than a second table: a committed `paused` / `attention-required` status, an available action with `requiresInput: true`, or an associated run with an unexpired pending developer question or a fresh/retained `blocked` runtime observation.
- When a notification is raised, focus the workflow's dashboard tab (`workspace focus` + `tab focus` on the base label `dashboard`) as a bounded best-effort step. A missing workspace or dashboard tab never fails the notification and never changes workflow state.
- Add a trusted user preference `ui.herdr_notifications` (default `false`) so the integration is opt-in and project configuration cannot enable it for other workspaces. No daemon is started; notifications stop when the last Agentic Coding shell exits.
- Document the manual Herdr configuration recipe for silencing Herdr's default agent-finished notifications, and record that exact finished-only muting and click-to-focus require upstream Herdr capabilities (`notification.show` pane target, per-kind/per-agent toast filter). A separate follow-up change adopts those capabilities when available.
- The notifier is presentation-only and best-effort: notification delivery, focus, and observation failures are bounded diagnostics that never change revisions, available actions, capabilities, effects, or agent processes.

## Capabilities

### New Capabilities
- `workflow-developer-notifications`: the developer-action trigger semantics, the one-notification-per-transition rule, the notification content contract (workflow identity + phase), the dashboard-focus behavior, the `ui.herdr_notifications` trusted preference, and the manual Herdr configuration recipe/limitations.

### Modified Capabilities
<!-- None: the existing sidebar capability keeps its own contract unchanged; the notifier reuses its helper semantics at the code level without changing them. -->

## Impact

- `agentic-coding/src/workflow/notifications.ts` — new pure projection and transition helper.
- `agentic-coding/src/workflow/notification-sync.ts` — new bounded Herdr write/focus boundary (`notification show`, workspace/tab focus).
- `agentic-coding/src/workflow/notification-observer.ts` — new application-scoped notifier owner (start/reconcile/dispose, transition state, coalescing).
- `agentic-coding/src/workflow/effects.ts` — `herdrNotificationsEnabled()` reading `ui.herdr_notifications`.
- `agentic-coding/src/server/operations/engine.ts` — register/start/reconcile/release the notifier alongside the sidebar owner.
- `agentic-coding/src/tui/otel/app/App.tsx` (home shell) and `agentic-coding/src/tui/dash/App.tsx` — wire reconcile triggers; no new surface.
- `agentic-coding/README.md` / `agentic-coding/docs/herdr-sidebar.md` or a new doc — enablement and the manual Herdr notification recipe.
- Focused tests under `agentic-coding/test/` for the pure projection/transition and the observer boundary.
- No workflow store/schema migration, no change to step definitions or digests, no new durable outbox effect kind, no `~/.config/herdr/config.toml` write.

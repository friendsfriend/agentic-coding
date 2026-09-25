# Workflow developer-action notifications

Herdr notifications when a managed workflow needs a developer decision
(`workflow-developer-notifications`). The integration raises one Herdr
notification per new developer obligation and focuses the workflow's dashboard
tab when it raises it. It is presentation-only: it never owns workflow state,
agent processes, or Herdr topology.

- Pure projection + transition state: `src/workflow/notifications.ts`.
- Bounded Herdr write/focus boundary: `src/workflow/notification-sync.ts`.
- Lifecycle owner: `src/workflow/notification-observer.ts`, started by the TUI
  shell while home/dash is alive.

## What triggers a notification

A workflow **owes developer input** when any of these is true, reusing exactly
the sidebar's obligation semantics:

- its committed status is `paused` or `attention-required`;
- at least one available action declares `requiresInput: true` (a registered
  approval gate);
- an associated run has an unexpired pending developer question; or
- an associated agent has a fresh `blocked` runtime observation, or a previously
  `blocked` observation that could not be refreshed (retained).

The integration raises the notification only on a **false → true transition**:
the first observation of a workflow records a baseline without notifying (a
shell restart never replays every outstanding obligation), repeated refreshes
while still owed do not notify again, and a clear followed by a new obligation
notifies again.

The notification title carries the project and workflow id, and the body carries
the current phase label. It requests the needs-attention sound class
(`--sound request`).

## Enable it

The preference is trusted user configuration only — a project
`.pi/herdr-workflow.json` cannot turn the integration on or off for other
workspaces.

```json
// ~/.config/agentic-coding/config.json
{
  "ui": {
    "herdr_notifications": true
  }
}
```

Default is `false`. Nothing is observed or raised while it is off; the pref is
independent of `ui.herdr_sidebar`, so the notifier runs even when the native
sidebar integration is disabled.

## Lifetime

There is **no notification daemon**. Observation and notifications run only
while at least one Agentic Coding shell (home/dash) is alive, owned by the same
application-scoped lifetime as the sidebar presentation. When the last shell
exits, observation stops and no background process remains. A workflow that
owes input while no shell is running produces no notification — the on-screen
sidebar attention marker is the durable indicator in that case.

Notification state is per shell process. The design supports one notifier
owner (the dashboard pane never starts a second one), but two home shells
running at the same time each keep their own transition baseline and can each
raise the notification and steal focus for the same obligation. Run one home
shell when `ui.herdr_notifications` is enabled; the Herdr card writes tolerate
multiple publishers but `notification show` and focus are not idempotent.

## Dashboard focus

When the workflow owes input and the workflow has a valid live workspace, the
integration focuses that workspace and its `dashboard` tab **before** raising
the notification, so the toast is not dismissed by the tab that is about to
become active. A missing or invalid workspace, missing `dashboard` tab, or
missing tab id is a skipped focus: the notification is still raised and the
skip is reported at most once as a bounded diagnostic. Focus resolution
ignores the tab's status glyph.

Notification and focus failures never change a workflow revision, available
action, run status, capability, durable effect attempt, or agent process.

## Silence Herdr's default agent-finished notifications

Herdr's own notifications are dominated by background agent-finished toasts
that carry no workflow or phase information. On Herdr **0.9.1** the settings
below are the only supported suppression path. The installer never rewrites
`~/.config/herdr/config.toml`; edit it by hand and reload.

```toml
# ~/.config/herdr/config.toml
[ui.sound]
# Silence agent notification sounds.
enabled = false

[ui.toast]
# Mute all toasts.
delivery = "off"
```

Reload with `herdr server reload-config` (or restart Herdr).

Each setting's effect and limitation:

- `[ui.sound] enabled = false` silences **every** notification sound (both the
  finished `done` class and the needs-attention `request` class this notifier
  uses); the toasts still appear. This is the safe first step when the
  developer-action toast itself is wanted but its sound is not.
- `[ui.toast] delivery = "off"` mutes **all** toasts, including
  developer-action notifications. Herdr 0.9.1 has one global toast switch and
  no per-kind or per-agent filter, so exact **finished-only** muting (mute
  agent-finished toasts while keeping developer-action notifications) is not
  possible. The notifier keeps working under any delivery setting that shows
  toasts; under `delivery = "off"` the notification is still considered raised
  and the dashboard is still focused.

Two upstream Herdr capabilities would remove these limitations:

- a `notification.show` pane/click target, so clicking a developer-action
  notification can focus the workflow dashboard (Herdr 0.9.1 focuses a pane on
  toast click only when a `pane_id` is present, which a custom notification
  cannot supply); and
- a per-kind or per-agent toast filter, so agent-finished toasts can be muted
  while developer-action notifications remain enabled.

Those capabilities are recorded and adopted by the follow-up OpenSpec change
`adopt-herdr-notification-controls`
(`openspec/changes/adopt-herdr-notification-controls`), which is not implemented
until a pinned Herdr release provides them. Until then, focus happens at raise
time and only the global Herdr recipe above is available.

## Disable and roll back

1. Set `ui.herdr_notifications = false` (or remove the key).
2. Optionally restore the Herdr settings you changed and run
   `herdr server reload-config`.

Rollback never changes workflow stores, agent processes, native Herdr names, or
unrelated user settings, and it does not stop or relaunch agents.

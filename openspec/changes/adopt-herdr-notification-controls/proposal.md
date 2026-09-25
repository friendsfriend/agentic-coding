# Proposal

## Why

The primary `workflow-developer-notifications` change can only raise a custom Herdr notification and focus the dashboard when it is raised. Herdr 0.9.1 custom notifications carry no click target, so a click cannot focus the workflow dashboard, and Herdr toast delivery is a single global switch, so an operator cannot mute agent-finished toasts while keeping developer-action toasts. Those are upstream Herdr capabilities, not Agentic Coding behaviors.

## What Changes

- When Herdr exposes a pane/click target on `notification.show`, Agentic Coding sends the workflow dashboard pane as that target so clicking the notification focuses the dashboard, and stops the raise-time focus workaround.
- When Herdr exposes a per-kind or per-agent toast filter, Agentic Coding documents and uses finished-only muting so default agent-finished notifications can be disabled without muting developer-action notifications.
- The integration detects the supported Herdr capability at runtime and falls back to raise-time focus plus the documented global-toggle recipe when the capability is absent.

## Capabilities

### New Capabilities
- `herdr-notification-controls`: how Agentic Coding detects and adopts the optional upstream Herdr notification click target and per-kind/per-agent toast filter, and how it degrades when either is absent.

### Modified Capabilities
<!-- None: this change adds a new adapter capability rather than changing an existing spec. -->

## Impact

- `agentic-coding/src/workflow/notification-sync.ts` — send a click/pane target when the installed Herdr schema accepts it.
- `agentic-coding/src/workflow/notification-observer.ts` — stop focusing at raise time once click targeting is supported.
- `agentic-coding/src/workflow/herdr-schema.ts` — decode the optional target/filter fields.
- Documentation for the finished-only Herdr configuration.
- Blocked on an upstream Herdr release that adds a `notification.show` click target and/or a per-kind or per-agent toast filter; this change is not implemented until that release is pinned.

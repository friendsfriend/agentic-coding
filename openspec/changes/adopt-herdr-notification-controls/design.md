# Design: Adopt Herdr notification controls

## Context

See `proposal.md` for motivation and `specs/herdr-notification-controls/spec.md` for the behavior contract.

The primary `workflow-developer-notifications` change raises `herdr notification show <title> --body <body> --sound request` and focuses the workflow dashboard at raise time, because Herdr 0.9.1 `NotificationShowParams` has only `title`, `body`, `position`, and `sound`, and toast delivery is one global enum. This change is held until Herdr ships either control.

## Goals / Non-Goals

**Goals:**

- Use a notification click target when Herdr exposes one.
- Use a finished-only toast filter when Herdr exposes one.
- Keep notification delivery working on older Herdr by feature detection and legacy request shapes.

**Non-Goals:**

- No Agentic Coding implementation of the missing Herdr capabilities.
- No change to the developer-action trigger semantics or the trusted preference.

## Decisions

### Detect controls from the Herdr schema/version

The Herdr boundary already decodes optional result fields tolerantly in `workflow/herdr-schema.ts`. Capability detection follows the same pattern: read the installed schema (or a pinned minimum version) before choosing the request shape, and treat an absent field as unsupported. Alternative rejected: sending the field optimistically, which makes arena-older Herdr reject the whole request.

### Target the dashboard pane directly

For click-to-focus, the target is the workflow's dashboard pane resolved from the `dashboard` tab base label. Once the target is accepted, the raise-time focus call is removed to avoid stealing focus twice. Alternative rejected: keeping raise-time focus and the target, which focuses once when raised and again when clicked.

### Filter configuration stays documented, not managed

Agentic Coding documents the finished-only filter and never rewrites `~/.config/herdr/config.toml`, consistent with the primary change and the existing sidebar integration.

## Risks / Trade-offs

- Upstream field names and semantics are not under this project's control. Mitigation: detect and degrade; keep the legacy shape as the default.
- A future Herdr could accept a target but ignore it. Mitigation: keep a runtime check that the capability version is pinned in the documentation and tests.
- A finished-only filter may change default user-visible behavior. Mitigation: document it as opt-in and never enable it from Agentic Coding.

## Migration Plan

1. Wait for a pinned Herdr release that exposes the control.
2. Add detection and the new request shape behind the existing opt-in preference.
3. Roll back by reverting to the legacy request shape; the notification remains delivered without click-to-focus or finished-only filtering.

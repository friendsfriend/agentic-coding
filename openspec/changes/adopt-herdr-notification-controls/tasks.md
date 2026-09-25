# Tasks: Adopt Herdr notification controls

## 1. Capability detection

- [ ] 1.1 Pin the minimum Herdr release that exposes each control in the documentation and constants; verify the constants and doc agree.
- [ ] 1.2 Extend `agentic-coding/src/workflow/herdr-schema.ts` (or the Herdr version probe) to expose whether the installed Herdr accepts a notification target and a per-kind/per-agent toast filter; verify with a focused test over the supported, unsupported, and detection-failure cases.

## 2. Click target adoption

- [ ] 2.1 Extend `showDeveloperNotification` in `agentic-coding/src/workflow/notification-sync.ts` to include the workflow dashboard pane as the notification target when supported; verify the request shape with a fake port for supported and unsupported Herdr.
- [ ] 2.2 Stop the raise-time focus call in `agentic-coding/src/workflow/notification-observer.ts` when the target is supported, and keep it when not; verify both branches in `agentic-coding/test/workflow-notification-observer.test.ts`.
- [ ] 2.3 Verify in `agentic-coding/test/workflow-notification-sync.test.ts` that an older Herdr that rejects the target still receives the legacy request.

## 3. Finished-only suppression

- [ ] 3.1 Document the supported finished-only Herdr configuration and update the notification doc to replace the global-toggle limitation with the exact recipe; verify the doc states the capability version and the fallback.
- [ ] 3.2 If Agentic Coding must send the filter with the request, extend `showDeveloperNotification` and verify the field is only sent when supported.

## 4. Focused validation

- [ ] 4.1 Run the focused notification suites from `agentic-coding/` and confirm they pass.
- [ ] 4.2 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and confirm zero diagnostics.

# Tasks: Developer-action notifications

## 1. Preference and pure projection

- [x] 1.1 Add `herdrNotificationsEnabled(home?, root?)` to `agentic-coding/src/workflow/effects.ts`, reading the trusted user config key `ui.herdr_notifications` exactly like `herdrSidebarEnabled` (first existing user config file wins, default `false`, project config ignored), and add `herdr_notifications?: boolean` to the parsed config shape; verify with focused cases covering absent key, `false`, `true`, and a project-config value that must not enable it.
- [x] 1.2 Create `agentic-coding/src/workflow/notifications.ts` with a pure `developerActionNotification(view, agentRequiresInput): { workflowId, title, body } | undefined` that composes `workflowRequiresInput`, `projectLabel`, and `phaseLabel` from `workflow/sidebar.ts`, returning `view.workflowId` as the title and `phaseLabel(view)` as the body only when the workflow owes developer input; verify in `agentic-coding/test/workflow-notifications.test.ts` for paused status, `requiresInput` action, question-only, blocked-only, and not-owed views.
- [x] 1.3 Add a pure transition helper (for example `nextOwedState(previous, owed): { notify: boolean; state: boolean }`) that notifies only on false → true and records the first observation without notifying; verify the baseline, notify-once, and re-arm-after-clear cases in `agentic-coding/test/workflow-notifications.test.ts`.

## 2. Herdr write and focus boundary

- [x] 2.1 Create `agentic-coding/src/workflow/notification-sync.ts` with `showDeveloperNotification(herdr, { title, body }, signal?)` issuing `notification show <title> --body <body> --sound request` through the shared `HerdrPort` and returning the bounded delivery outcome; verify with a fake port that the argv is correct and that a rejected port call throws a bounded error without partial side effects.
- [x] 2.2 Add `focusWorkflowDashboard(herdr, workspace, signal?)` to the same module: `tab list --workspace`, resolve the tab with `findAgentTabByBase(tabs, "dashboard")` from `workflow/tab-status.ts`, then `workspace focus` and `tab focus`; treat a missing workspace, missing tab, or missing tab id as a skipped focus and never throw out of the notifier; verify with a fake port for the found, missing-tab, and missing-workspace cases.
- [x] 2.3 Verify in `agentic-coding/test/workflow-notification-sync.test.ts` that the focus calls are issued before the notification (the design's focus-first order), that a skipped focus still reports the notification as raised, and that `disabled`/`rate_limited`/`busy`/`no_foreground_client` outcomes are accepted as raised rather than retried.

## 3. Observer lifecycle and wiring

- [x] 3.1 Create `agentic-coding/src/workflow/notification-observer.ts` exporting a `WorkflowNotifications` owner that reads `options.views()` plus a batched agent observation read, computes per-workflow owed state, keeps the transition map, raises the notification and focus for each new obligation, coalesces overlapping refreshes, and exposes `start`/`reconcile`/`dispose` like `SidebarPresentation`; verify coalescing and re-arm behavior with a fake port in `agentic-coding/test/workflow-notification-observer.test.ts`.
- [x] 3.2 Reuse the existing batched read (`readSidebarObservations` from `workflow/sidebar-sync.ts`) or add a focused `agent list`-only read inside the observer, and confirm the observation statuses map `blocked`/non-blocked correctly; verify a retained stale blocked observation keeps the obligation and a fresh non-blocked observation clears it.
- [x] 3.3 Register the owner in `agentic-coding/src/server/operations/engine.ts` (`startWorkflowNotifications`/`reconcileWorkflowNotifications`, one owner per session, gated on `herdrNotificationsEnabled()`), wire the start into the home shell `agentic-coding/src/tui/otel/app/App.tsx`, and call reconcile from the existing dashboard mutation/event paths (`agentic-coding/src/tui/dash/App.tsx`, `reconcileSidebarPresentation` call sites); verify the owner is not created or reconciled while the preference is false.
- [x] 3.4 Verify presentation-only non-interference in `agentic-coding/test/workflow-notification-observer.test.ts`: a throwing or unavailable Herdr port leaves the input view, revision, available actions, and effect attempts unchanged and emits one bounded diagnostic per distinct message.

## 4. Documentation

- [x] 4.1 Document enabling `ui.herdr_notifications` and the notification/focus behavior, including the no-daemon lifetime rule, in the appropriate Agentic Coding doc (a new `agentic-coding/docs/workflow-notifications.md` linked from the README, or a section in `agentic-coding/docs/herdr-sidebar.md`); verify the doc names the preferred config key, its default, and the required Agentic Coding shell.
- [x] 4.2 Document the manual Herdr configuration recipe: `[ui.sound] enabled = false` silences agent sounds, `[ui.toast] delivery = "off"` mutes all toasts including developer-action notifications, and finished-only muting plus notification click-to-focus require the upstream Herdr capabilities recorded in the follow-up change; verify the doc states each setting's effect and the limitation explicitly.

## 5. Focused integration validation

- [x] 5.1 Run the focused suites `bun test test/workflow-notifications.test.ts test/workflow-notification-sync.test.ts test/workflow-notification-observer.test.ts` from `agentic-coding/` and confirm they pass.
- [x] 5.2 Run `bun run lint` and `bun run type-check` from `agentic-coding/` and confirm zero diagnostics.
- [x] 5.3 Verify by inspection that no step definition, `allowedEffects` list, registry digest, workflow store schema, or `~/.config/herdr/config.toml` write was introduced by the change.

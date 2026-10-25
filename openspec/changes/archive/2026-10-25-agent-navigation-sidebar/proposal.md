# Proposal

## Why

The unified TUI exposes durable workflows through its workspace sidebar, but agent sessions are not independently navigable across pages. Developers need a persistent, live view of agent runs that can take focus and open the exact session without losing their current shell context.

## What Changes

- Add a right-hand agent navigation panel to the unified TUI shell, with Active and All filters, compact and expanded presentation, and preserved selection across refreshes and filter changes.
- Support globally toggling focus to and from the agent panel, keyboard and mouse selection, scrolling, and navigation to the selected agent's precise session in its workflow.
- Reuse workspace sidebar patterns and expose truthful agent status and available identity, workflow, role, runtime/model, and timing/activity information; handle empty, loading/disconnected, and narrow-terminal states.
- Keep the agent panel distinct from the configurable workspace sidebar and update focused TUI coverage and keybind help/footer catalogs.
- Approved verifier follow-ups explicitly define initial-connecting versus post-frame stale session recovery, paused controls and draft preservation (`approve-bounded-session-connection-contract`), and bound reused session projection, metadata and markdown hot paths without changing the host protocol or session command semantics (`approve-bounded-session-hot-path-hardening`).

## Capabilities

### New Capabilities

- `agent-navigation-sidebar`: Persistent agent navigation, filtering, selection, focus, and session-opening behavior in the unified TUI.

### Modified Capabilities

- None. The new persistent panel and its explicitly approved connection-safety and presentation-efficiency follow-ups are specified as one cohesive capability. Existing session command semantics, shell navigation, command-catalog and shared pointer requirements remain compatible.

## Impact

The unified workflows observation already carries workflow target, current run identity/status/runtime/model, and optional session host/conversation handles; the sidebar can reuse this authoritative data and existing gateway polling. No new backend API is required. Impact is concentrated in the unified TUI shell/layout, pure agent-list projection, exact-run workflow/session routing, keybind catalogs, and focused TUI tests. The workflow test-verifier owns the complete configured repository suite; implementation tasks require focused checks plus lint and whole-project type-check.

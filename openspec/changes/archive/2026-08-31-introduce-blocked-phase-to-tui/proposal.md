## Why

A workflow whose agent handoff is blocked remains on its current phase while the engine marks it `attention-required`, but the dashboard currently renders only the phase label. Users therefore cannot tell from the phase area that progress is blocked and needs attention.

## What Changes

- Add a distinct blocked indicator beside the current phase in the dashboard Change panel when the workflow requires attention because a run is blocked.
- Preserve the existing current phase label and workflow-driven status badge behavior for active and terminal workflows.
- Add focused dashboard coverage for blocked and non-blocked phase rendering.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `dashboard-phase-status`: The Change panel phase area visibly distinguishes a blocked workflow from a normally active workflow while retaining the current phase label.

## Impact

- Dashboard phase/status rendering in `agentic-coding/src/tui/dash/App.tsx` and its focused TUI tests.
- No workflow engine, persistence, or external API contract changes; the UI consumes the existing workflow status/attention and run state.

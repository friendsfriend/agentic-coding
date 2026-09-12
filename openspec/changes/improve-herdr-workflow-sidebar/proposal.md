## Why

Herdr's native sidebar shows terminal topology and runtime names, but does not expose Agentic Coding's project, workflow, phase, and role context or reliably prioritize work awaiting developer input. Publishing this existing workflow knowledge into Herdr makes the sidebar useful without migrating to tmux or building another terminal UI.

## What Changes

- Add opt-in native Herdr sidebar cards for managed workflows and agents, backed by display-only workspace and pane metadata.
- Show canonical repository basename, workflow name, workflow type, and current phase on workflow cards; show project, workflow, lifecycle role, and live runtime status on agent cards.
- Place `◆` (developer input owed) or `◇` (no known developer input owed) immediately before the project name in the same fixed-width slot. Use `├─`, `│`, and `└─` to clarify each card's structure.
- Sort managed agent cards with confirmed input requirements first, then a stable workspace/tab/pane order; keep glyph rendering separate from machine-readable sorting metadata.
- Distinguish agent-specific questions and runtime approval prompts from workflow-wide approval/recovery gates. Keep runtime activity separate from committed workflow state.
- Reconcile presentation after workflow changes and while the existing application observes Herdr; restore the transient custom agent view on reconnect/startup and handle stale observations without falsely reporting certainty.
- Provide a documented, reversible user configuration recipe. Preserve native navigation, unrelated configuration, and workflow execution guarantees.
- Repeat project names per workflow card. True shared project headers, arbitrary grouping, Herdr forks, replacement sidebars, and tmux/workmux migration are explicitly excluded.

## Capabilities

### New Capabilities

- `herdr-workflow-sidebar`: Metadata-backed native workflow/agent cards, fixed-position input glyphs, stable input-first agent ordering, and best-effort presentation lifecycle.

### Modified Capabilities

None. Existing workflow authorization, question handling, dashboard action availability, and agent lifecycle requirements remain unchanged.

## Impact

- Workflow presentation synchronization and application composition: `agentic-coding/src/workflow/tab-sync.ts`, `operations.ts`, and existing CLI/dashboard mutation and observation boundaries.
- Shared Herdr transport: `agentic-coding/src/herdr-client.ts` and workflow boundary schemas/adapters for metadata commands and the socket-only `agent.view.set` / `agent.view.clear` API.
- Typed workflow views and registered step action metadata where a read-only required-input hint is needed; no new phase or role tables in the publisher.
- User-facing sidebar configuration documentation, targeted Bun tests, and live Herdr visual verification.
- Requires the reviewed Herdr 0.9.0 metadata and agent-view capabilities. No new package dependency, canonical database migration, workflow definition repin, or automatic rewrite of `~/.config/herdr/config.toml` is intended.

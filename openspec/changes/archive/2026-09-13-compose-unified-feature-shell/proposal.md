## Why

Running both current root applications together would duplicate renderers, key handlers, modal ownership and service lifetimes. One devenv-led shell must expose all features while retaining feature-local interaction and backend semantics.

## What Changes

- Compose Environments, Workflows, Observability and Wiki feature tabs under one renderer, keymap, modal host, footer and notification layer.
- Preserve environment and signal-specific sub-tabs and all existing detail, review, provider, CI and agent utilities.
- Derive dispatch, footer and help from one command catalog with standard/compact metadata.
- Preserve view history, drafts, panel focus and workflow directional navigation; route only the top modal's input.
- Move long-lived workflow coordinators and telemetry ownership out of feature mount lifetimes, without moving them across a process boundary yet.

## Capabilities

### New Capabilities

- `unified-feature-shell`: Shared feature navigation, modal/input ownership and feature-preserving composition.

### Modified Capabilities

None; existing workflow panel geometry and review payload contracts remain unchanged.

## Impact

Depends on `unify-terminal-ui-primitives`. Replaces competing composition in `src/tui/index.tsx`, `otel/app/App.tsx` and imported `app-opentui.tsx`; adapts devenv stacks/keymap metadata and dashboard application ownership. Full lifecycle/packaging is a later change; no Go rewrite here.

## Why

Nested shell, observability and environment tab bars compete for keyboard input and obscure location. Replace these with a hierarchy that makes applications and libraries first-class destinations while preserving existing environment and observability operations.

## What Changes

- **BREAKING** Replace navigation tab bars, global numeric destination shortcuts and `t` cycling with category pages, a breadcrumb row and one searchable location picker.
- Default full-application launch opens Home; Environments and Observability have selectable child destination pages.
- Separate structural Parent from chronological Back, retaining selection, scroll, filters and drafts on return.
- Reserve Tab/Shift+Tab for page-local focus, with overlay and text-input precedence.
- Preserve environment actions, providers/issues/change requests/CI, agent utilities, wiki reviews and telemetry detail capabilities through explicit routes.
- Keep the existing workflow entry temporarily reachable until contextual launch and Settings land; this is not the final Home structure.

## Capabilities

### New Capabilities
- `hierarchical-tui-navigation`: Category pages, hierarchy, history, location picker and route-local state.

### Modified Capabilities
- `unified-feature-shell`: Page-based shell and focus semantics replace tab navigation without changing service ownership.
- `dashboard-panel-navigation`: Tab traverses local focus rather than switching shell tabs; directional navigation remains.
- `home-wiki-view`: Wiki is a Home destination rather than a peer tab.

## Impact

Touches `src/tui/shared/routes.ts`, `src/tui/app/`, `src/tui/otel/app/App.tsx`, local observability navigation, keybind catalogs, and imported environment app/store/content-router/keymap integration under `packages/devenv/cli/src/tui/`. Paths are relative to `agentic-coding/`. No backend rewrite, new router dependency or storage migration.

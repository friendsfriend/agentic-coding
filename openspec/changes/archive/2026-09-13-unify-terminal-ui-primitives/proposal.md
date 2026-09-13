## Why

The repositories duplicate theme engines and 33 identical theme assets, modal framing, scrolling, selection and viewer components. Shared primitives must be migrated individually, preserving the stronger behavior from either implementation rather than adopting either UI wholesale.

## What Changes

- Consolidate theme registry, semantic colors, custom themes, preferences and picker; use the renderer palette API with bounded capture.
- Provide common modal framing, panel framing, search/filter headers, lists, badges, notifications, selection-copy and markdown/diff/log primitives.
- Preserve specialized review, questionnaire, progress, summary and animation content through composition.
- Migrate callers family by family with renderer parity tests and remove each duplicate after its final caller moves.

## Capabilities

### New Capabilities

- `unified-ui-preferences`: One local UI preference source and deterministic legacy theme import.

### Modified Capabilities

- `tui-shared-primitives`: Extend canonical primitive ownership across environment, workflow, wiki and observability consumers.
- `system-terminal-theme`: Capture through the renderer API rather than requiring pre-renderer manual input handling.

## Impact

Depends on `import-devenv-into-agentic-coding`. Touches imported devenv UI and theme-settings, `agentic-coding/src/tui/shared`, `dash/devenv-ui`, `dash/ui`, `otel/components` and theme assets. Global modal-stack/keymap ownership belongs to the subsequent shell change. No backend or domain-state redesign.

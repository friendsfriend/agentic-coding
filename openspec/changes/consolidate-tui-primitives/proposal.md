## Why

Dashboard, copied devenv UI, and observability UI maintain separate modal, scrolling, color, and selection primitives. Shared fixes can diverge across surfaces even though feature-level variants legitimately differ.

## What Changes

- Inventory live callers and compare semantics before selecting shared primitives.
- Consolidate only equivalent modal-shell, scrolling, theme-access, and selection behavior into existing shared TUI ownership or a small shared directory.
- Preserve feature-specific wrappers and intentional differences in animation, layout, key handling, and content.
- Remove replaced implementations only after migrating every caller and verifying renderer behavior.

## Capabilities

### New Capabilities

- `tui-shared-primitives`: Shared implementation ownership with cross-surface renderer parity; an architectural contract, not a new user-facing feature.

### Modified Capabilities

None. Existing terminal behavior requirements remain unchanged.

## Impact

- Priority: low; architecture cleanup finding 1. No prerequisite changes.
- Code: `agentic-coding/src/tui/dash/ui/`, `dash/devenv-ui/`, `otel/components/`, and theme/selection consumers.
- Existing modal, keyboard, clipboard, scrolling, theme, and lifecycle specifications remain the acceptance contracts.
- Coordinate imports with `split-dashboard-responsibilities`; the changes own different concerns and can land separately.

## Non-goals

No new design-system package, universal modal schema, visual redesign, keybinding change, OpenTUI upgrade, or forced unification of non-equivalent variants.

## Context

Three live component families exist under dashboard ui, dashboard devenv-ui, and observability components. They overlap in modal shells, scroll wrappers, color access, and selection handling but are not interchangeable: animation, portal use, footer structure, and scrollbar options differ.

## Goals / Non-Goals

**Goals:** one implementation per genuinely shared primitive and no regression in existing terminal interactions.

**Non-goals:** making every component identical, a new package, a generic component schema, or changing visuals/shortcuts.

## Decisions

### Compare callers before extracting

Inventory imported implementations and actual prop/behavior differences. Start with equivalent color/selection/scroll behavior, then share modal framing only where lifecycle, z-order, and input ownership agree. Retain feature-specific wrappers for real differences instead of creating a large options matrix. Delete unused copies only after a whole-source import search confirms they are dead.

Use a small shared TUI module location with no dependency back into dashboard or observability features. Shared primitives receive existing theme values/state through the established theme boundary; they do not introduce another theme store. Thin old-path re-exports may ease migration, but avoid leaving duplicate implementations behind them.

### Renderer behavior is the acceptance oracle

Use existing OpenTUI/Solid test-renderer patterns. Compare representative dashboard, markdown/devenv, and observability consumers for narrow/wide terminals, focus restoration, Escape/Enter handling, modal stacking, scrolling, selection copy, and theme updates. Preserve animation lifecycle cleanup where an animated variant is involved. A shared implementation is not acceptable if it changes these contracts merely to reduce code.

The new architectural spec records shared ownership and cross-surface parity; existing dashboard modal, clipboard, theme, input, and lifecycle requirements remain binding. The installed OpenSpec CLI does not honor the archived skip_specs convention, so the refactor's actual architectural contract is explicit instead. Structural deletion is measured by duplicate implementations removed, not a line-count quota.

## Risks / Trade-offs

- Similar names hide different behavior → inventory and characterization precede consolidation.
- Shared modal state can leak across instances → keep state instance-local and test nested/stacked use.
- Refactoring all families at once increases review risk → migrate one primitive and its callers per green test run; leave non-equivalent variants explicit.

## Migration Plan

No persisted state or definition changes. Capture representative renderer behavior, move one equivalent primitive, retarget callers, then delete its duplicates. Revert the individual move if parity fails. Coordinate import edits with `split-dashboard-responsibilities` without combining its feature-state extraction into this change.

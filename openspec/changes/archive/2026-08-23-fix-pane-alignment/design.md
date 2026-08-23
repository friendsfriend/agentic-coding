## Context

The workflow dashboard detail view lives in `agentic-coding/src/tui/dash/App.tsx`. Its content box is a column with `gap: 1` containing:

1. A top row (`flexDirection: "row", gap: 1`) whose children are a left column box (`width: "50%"`, `flexShrink: 0`) holding the `Change` and `OpenSpec` panels, and the right `Agents` panel (`width: "50%"`, `height: "100%"`, `flexShrink: 0`).
2. A fixed-height bottom block with two rows (`Current task`/`Verification`, `Git status`/`Traces`). Both rows use `gap: 1` and size their panels with `flexGrow: 1, flexBasis: 0, minWidth: 0`.

The top row's two fixed 50% children plus the 1-column gap request one column more than the container provides; because both children opt out of shrinking (`flexShrink: 0`), the row overflows and its gutter sits one column to the right of the bottom rows' gutters — the misalignment reported in this change.

## Goals / Non-Goals

**Goals:**
- Make all three panel rows split width identically so every middle gutter lines up in the same terminal column.
- Keep the change confined to layout style props; no content, focus, or keybinding changes.

**Non-Goals:**
- Reworking `Panel.tsx`, `Layout.tsx`, or any other tab's layouts (Home, otel tabs).
- Touching the outer `paddingRight: 1` / `gap: 1` chrome of the detail view.

## Decisions

- **Use flexible sizing for the top-row columns, matching the bottom rows.** Replace the left column's `{ width: "50%", height: "100%", flexShrink: 0 }` and the `Agents` panel's `{ width: "50%", height: "100%", flexShrink: 0 }` with `{ flexGrow: 1, flexBasis: 0, minWidth: 0, height: "100%" }`. This is exactly the pattern already proven by the two bottom rows, so all three rows resolve widths through the same code path and their gutters coincide by construction. Alternative considered: keep 50% widths and drop the gap — rejected because it changes the visible spacing everywhere instead of just fixing overflow, and it diverges from the existing flexible-sizing convention.

## Risks / Trade-offs

- [Left-column inner panels rely on parent width behavior] → The left column keeps `height: "100%"`; `OpenSpec` already pins its own height and `Change` grows, both sized against a parent that still fills half the row, so no measurable change is expected. Verified visually at narrow and wide terminal sizes.
- [Yoga/OpenTUI percentage-vs-basis quirks] → `flexBasis: 0` + `flexGrow: 1` is already exercised by four other panels in the same view, so behavior is known-good.

## Migration Plan

Single-file visual change; ship as-is, revert by restoring the previous style props if needed.

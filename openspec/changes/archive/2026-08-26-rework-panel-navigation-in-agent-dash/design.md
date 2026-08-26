## Context

The dashboard detail view (`agentic-coding/src/tui/dash/App.tsx`) renders four interactive panels: Change (`id 0`, top-left), OpenSpec (`id 6`, below Change, wrapped in `<Show when={artifacts().length > 0}>`), Agents (`id 1`, right column, full height of the left stack), and Current task (`id 2`, full-width bottom row). See `proposal.md – Why` for motivation.

Today, `handleKey` switches panels one-dimensionally: `(name === "j" && key.shift) || (name === "k" && key.shift) || name === "tab"` cycles a fixed order `[0, 6, 1, 2]` (reversed for shift+k / shift+tab). The detail keymap layer binds `"J"`, `"K"`, `"tab"`, `"shift+tab"`; `keymap-setup.ts` normalizes shift+letter input to an uppercase resolved key for binding match, while the command still receives the original event — so `handleKey` sees `name === "j"` with `key.shift === true`. Shift+H and Shift+L are currently unbound.

Developer decision during implementation: `Tab` / `Shift+Tab` are no longer bound to panel switching at all — the shell (`src/tui/otel/app/App.tsx`) owns them for its tab bar (its `isTab` handling fires while the dashboard has no modal open), so the detail layer's `"tab"` / `"shift+tab"` bindings and the 1D cycle are removed.

Constraints: the panel layout itself is covered by `dashboard-pane-grid` / `dashboard-layout-spacing` and must not change; the home/workspace view has a single panel and is unaffected; `j`/`k`/`↑`/`↓` scrolling inside a focused panel must keep working.

## Goals / Non-Goals

**Goals:**
- A declarative 2D grid model over the rendered panels with vim-style moves (Shift+J/K/H/L) and wrap at every edge.
- Navigation resolves against the currently rendered grid, so OpenSpec is skipped when no artifacts are listed.
- Pure, unit-testable navigation logic separated from the OpenTUI key wiring.
- Help text documents the new bindings.

**Non-Goals:**
- Changing the visual panel layout, spacing, or grid alignment (`dashboard-pane-grid`, `dashboard-layout-spacing` untouched).
- Changing how `j`/`k`/`↑`/`↓` scroll within a focused panel.
- Binding `Tab` / `Shift+Tab` to panel navigation (both stay reserved for the shell's tab bar).
- Binding unshifted `h`/`l` (the user asked for shift as the modifier).
- Adding a user-configurable keybinding system.

## Decisions

### 1. Grid model: 3 rows × 2 columns with spans, scan-with-wrap

Panels occupy cells, and a panel may span more than one cell:

```
        col 0         col 1
row 0   Change (0)    Agents (1)
row 1   OpenSpec (6)  Agents (1)   (span: rows 0–1)
row 2   Current (2)   Current (2)  (span: both columns)
```

When artifacts are absent, the OpenSpec cell `(1, 0)` is empty. Navigation from the active panel moves one cell in the pressed direction from its anchor cell, skipping cells owned by the same panel's span, wrapping at grid edges, and landing on the first distinct panel found. If the whole row/column contains no distinct panel, focus stays (no-op).

Resulting transition table (OpenSpec visible):

| From | Shift+J (down) | Shift+K (up) | Shift+H (left) | Shift+L (right) |
|------|----------------|--------------|----------------|-----------------|
| Change (0)     | OpenSpec (6)     | Current (2) (wrap) | Agents (1) (wrap) | Agents (1) |
| OpenSpec (6)   | Current (2)      | Change (0)         | Agents (1) (wrap) | Agents (1) |
| Agents (1)     | Current (2)      | Current (2) (wrap) | Change (0)         | Change (0) (wrap) |
| Current (2)    | Change (0) (wrap) | OpenSpec (6)     | Current (2) (no-op) | Current (2) (no-op) |

OpenSpec hidden:

| From | Shift+J | Shift+K | Shift+H | Shift+L |
|------|---------|---------|---------|---------|
| Change (0)  | Current (2) | Current (2) (wrap) | Agents (1) (wrap) | Agents (1) |
| Agents (1)  | Current (2) | Current (2) (wrap) | Change (0) | Change (0) (wrap) |
| Current (2) | Change (0) (wrap) | Change (0) | Current (2) (no-op) | Current (2) (no-op) |

Rationale: a scan-with-wrap over an occupancy grid is small, declarative, and derives the hidden-OpenSpec behavior automatically instead of special-casing it. The full-width Current task row genuinely has no horizontal neighbor, so Shift+H/L there is a documented no-op rather than an arbitrary jump (this is pinned by the spec).

Alternatives considered:
- *Hand-written adjacency map per panel* — equally small, but duplicates the grid geometry and must be kept in sync when panels appear/disappear; the occupancy scan is the single source of truth.
- *Keep the 1D ring, just relabel keys* — rejected: the user explicitly wants positional moves.
- *"Nearest panel in direction" freeform geometry* — more code, ambiguous for the spanning Agents column; a fixed occupancy grid matches the rendered layout.

### 2. Navigation logic lives in a new pure module

New module `agentic-coding/src/tui/dash/panel-grid.ts` exporting a `movePanel(active, direction, opts)` function plus the grid/geometry constants. It takes no rendering or keymap dependencies, so every transition in the tables above is directly unit-testable with both `opts.artifactsVisible` states.

Alternative: inline the logic in `App.tsx` — fewer files, but the grid semantics (spans, wrap, hidden cell) deserve isolated tests that don't need an OpenTUI renderer.

### 3. Key wiring in App.tsx

In `handleKey`, replace the panel-switch block with:

- `name === "j" && key.shift` → `movePanel("down")`
- `name === "k" && key.shift` → `movePanel("up")`
- `name === "h" && key.shift` → `movePanel("left")`
- `name === "l" && key.shift` → `movePanel("right")`
- `name === "tab"` / `name === "tab" && key.shift` → unbound: the 1D `[0, 6, 1, 2]` cycle is removed so the shell's tab bar keeps Tab / Shift+Tab

Add `"H"` and `"L"` to the detail layer's binding list so the shift-normalizing resolver matches them (alongside the existing `"J"`/`"K"`); drop `"tab"` / `"shift+tab"` from that list; the unshifted `"h"`/`"l"` keys stay unbound. `movePanel` never returns a hidden panel, which also fixes the latent stale-focus case where a panel disappears while focused.

### 4. Help text update

Add `Shift+J/K/H/L → Move between panels` to the Navigation section of `helpSections` in `App.tsx` and drop the former `Tab / Shift+Tab → Switch panel` entry, keeping the existing `j/k or ↑/↓ → Scroll focused panel` entry. Minor `KeymapEvent`/binding changes require no new dependencies.

## Risks / Trade-offs

- [Shift+H/L on the full-width Current task row is a no-op] → Documented in the spec; the vertical shifts remain as escape hatches, and the geometry genuinely has no horizontal neighbor there.
- [Agents spans two rows, so Shift+J and Shift+K both land on Current task] → Matches the visual stack (Agents is a single tall panel above the bottom row); the tab table in section 1 pins this behavior for tests.
- [A panel can disappear (artifacts refresh) while focused] → `movePanel` only ever returns rendered panels; exiting this state is a one-keypress consequence of the wrap rules. No further reconciliation is added in this change.
- [Running panels' `j`/`k` scroll handling must not collide with the new shift handling] → Shift+J/K/H/L are distinct key events (uppercase-resolved bindings) from unshifted `j`/`k`; the existing `name === "down" || name === "j"` branches are untouched.

## Migration Plan

1. Add `panel-grid.ts` + unit tests; run `bun run type-check` and the new tests.
2. Wire `H`/`L` bindings and the new `handleKey` branches in `App.tsx`; update help text.
3. Add integration tests under `test/dash/` that press shift keys and assert focus movement.
4. Full verification: `bun run lint`, `bun run type-check`, `bun test`.
5. Manual smoke via `bun run dev:ui-dash`: drill every direction and wrap edge in the detail view with artifacts present, and confirm `Tab` is no longer consumed by the panels.
6. Rollback: revert the single `App.tsx` wiring commit and drop the new module; no data or dependency changes exist.

## Open Questions

None. The bottom-row no-op, the Agents span handling, and the removal of the `Tab` panel cycle are all resolved decisions covered by the spec and the transition tables above.
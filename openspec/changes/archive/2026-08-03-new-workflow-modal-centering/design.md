## Context

See proposal.md — Why. Layout facts that drive the design (all verified against the current tree):

- `DashHome` and `DashApp` render inside the tab-content box in `src/tui/otel/app/App.tsx`, offset by header + tab bar + status bar (~5 rows in home mode).
- `dash/ui/GenericModal.tsx` (and the duplicated `devenv-ui/components/GenericModal.tsx`) renders its overlay as `<box position="absolute" top={0} left={0} width={terminalW} height={terminalH} justifyContent="center" alignItems="center">`. Yoga anchors absolute children to the nearest parent container, so the overlay anchors to the tab-content box while claiming terminal dimensions.
- `@opentui/solid` ships a `Portal` component: "Render children into a different mount node, useful for overlays and tooltips. If no mount point is given, the portal is inserted on the root renderable." It wraps children in a plain box added to `renderer.root`.

Empirical check (core-level render test, 80×24, 8-row dialog): nested overlay puts the dialog title on row 13 (terminal center would be row 8); the same overlay mounted at `renderer.root` lands exactly on row 8.

## Goals / Non-Goals

**Goals:**
- One root-cause fix at the shared overlay component so every dash modal centers correctly.
- Preserve existing modal sizing, stacking, focus, and mouse behavior.

**Non-Goals:**
- Restyling modals, changing sizes/percentages, or unifying the two `GenericModal` copies.
- Touching otel-tab modals (already anchored at the full-terminal OtelApp root box).

## Decisions

**D1: Mount the overlay via `Portal` (no mount prop → `renderer.root`), with the portal container made absolute.**
The overlay box in `dash/ui/GenericModal.tsx` gets wrapped in `<Portal>`. The portal container is appended to the renderer root as a sibling of the app column, so the absolute overlay anchors to the terminal origin and `useTerminalDimensions()`-sized overlay covers the whole screen.

Empirical correction from implementation: a bare `Portal` container is a *flow* child of the root column, so it lands below the full-screen app column (root is `flexDirection: column`) and the overlay renders off-screen — the modal becomes invisible. Fix: `<Portal ref={el => el.position = 'absolute'}>` takes the container out of flow at the origin; the overlay then anchors to it and covers the terminal. Verified live (`dev:ui` home mode: new-workflow wizard steps, help, theme picker all centered at `(H - dialogH) / 2`, backdrop over header/tab/status bars, Esc close and typing/focus intact) and by the core-level regression test (test/dash/modalCentering.test.ts).
- Alternative A (portal only `NewWorkflowModal`): fixes the reported modal but leaves help/error/filter/sort/theme/verdict/etc. equally mis-centered. Rejected — symptom fix, not root cause.
- Alternative B (size the overlay to the tab-content box instead of terminal dims): no Portal needed, but the dialog would still sit a few rows below true terminal center and the backdrop would not dim the header/status bars. Rejected — "centered" should mean centered on the terminal.
- Alternative C (portal in each modal component): touches ~15 files. Rejected — the overlay is shared; one change covers all.

**D2: Apply the same change to the `devenv-ui` GenericModal copy.**
Identical overlay pattern, used by the diff-view modal, same mis-centering. Two lines total instead of leaving a second broken copy.

**D3: Leave `otel/components/GenericModal.tsx` untouched.**
Its modals render as siblings of the app column inside the OtelApp root box, which spans the terminal — already correctly anchored. Changing it would be churn with no behavioral difference.

## Risks / Trade-offs

- [Portal container is a sibling of the app column; z-order] → Containers are appended after the app, so portal content paints on top; `ErrorDialog`'s `zIndex={1}` is preserved inside the container. Modal-vs-modal stacking order follows render order, unchanged.
- [Keyboard focus on modal inputs (e.g. new-workflow text fields) breaks when the subtree moves] → Focus is tracked by the renderer context (`focusRenderable`), not by tree position; the `<input focused>` elements keep working.
- [Backdrop mouse handling (`onBackdropClick`) breaks] → Hit-grid registration happens at render time from final screen coordinates; portal rendering registers the same bounds. Behavior unchanged.
- [Portal adds a render-root child per modal; nested modals (e.g. error dialog over the new-workflow modal) each portal] → Each mounts its own container; insertion order matches JSX order, so stacked modals keep correct layering.

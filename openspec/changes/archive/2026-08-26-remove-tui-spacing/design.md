## Context

The dashboard UI is hosted inside the shared shell in `src/tui/otel/app/App.tsx`. That shell currently applies one cell of padding on every side, which creates the blank rows and columns around both dashboard modes. The per-workflow view additionally applies a one-cell right inset in `src/tui/dash/App.tsx`; the home view does not have an equivalent content inset.

See `proposal.md` for the motivation and `specs/dashboard-layout-spacing/spec.md` for the observable contract.

## Goals / Non-Goals

**Goals:**

- Make home and per-workflow dashboard shells occupy the complete terminal rectangle.
- Remove only shell-level edge spacing and the per-workflow content wrapper's outer right inset.
- Preserve intentional padding inside dashboard components and avoid changing non-dashboard observability views.
- Keep existing vertical layout, panel gaps, content, and key handling intact.

**Non-Goals:**

- Do not remove padding from panel headers, list rows, tab labels, status text, or modal content.
- Do not alter `Layout`'s header/footer heights or the spacing between detail-dashboard panels.
- Do not change trace, metrics, logs, or topology tab layout when they run without a dashboard surface.

## Decisions

1. **Scope the shared-shell change to dashboard mode.** Use the existing `dashboard` prop as the mode boundary: dashboard mode uses zero outer shell padding, while trace-only mode retains its current shell padding. This avoids making an unrelated visual change to observability-only surfaces. The alternative—removing `padding: 1` unconditionally—is shorter but changes every non-dashboard tab as a side effect.
2. **Remove the per-workflow right inset at its content wrapper.** The detail dashboard's content box will no longer reserve `paddingRight: 1`; its row and panels already use flexible widths and explicit inter-panel gaps. The alternative—compensating with a negative margin or changing panel widths—would introduce layout math and risk clipping.
3. **Keep component-level interior padding.** Header, tab, status, panel, and list components retain their own padding so text remains readable even when their containing shell reaches the terminal edges. Removing all nested padding would conflate edge-to-edge placement with content formatting.
4. **Verify through terminal-frame rendering.** Add focused OpenTUI render coverage for home and per-workflow dashboard shells at a known width and height, asserting that shell surfaces reach the first/last columns and rows and that representative header/content/footer text remains present. Existing dashboard behavior tests remain the regression suite for interactions and data.

## Risks / Trade-offs

- [Risk] Removing the shell inset gives text-bearing surfaces less visual breathing room at terminal edges. → Mitigation: retain component-level horizontal padding and only remove the outer shell spacing requested by the change.
- [Risk] The per-workflow content may request more width after losing its right inset. → Mitigation: preserve `minWidth: 0`, flexible column sizing, and the existing inter-panel gap; validate at the test renderer's fixed terminal dimensions.
- [Risk] A conditional shell style could accidentally omit padding for a non-dashboard surface. → Mitigation: base the condition solely on the already-defined `props.dashboard` presence and include a regression check that non-dashboard shell padding remains unchanged if relevant coverage exists.

## Migration Plan

- Update the shared shell and per-workflow content wrapper.
- Add or update focused render assertions, then run the package type-check, lint, and test commands.
- Rollback is limited to restoring the two layout style changes; no persisted data, API, or migration is involved.

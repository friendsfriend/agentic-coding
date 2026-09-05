## 1. Inventory and characterize

- [ ] 1.1 Inventory live modal, scrolling, theme-access, selection, and badge implementations across all three component families and record caller/behavior differences.
- [ ] 1.2 Identify equivalent primitives to share and intentional variants to retain; choose a shared owner without importing feature modules.
- [ ] 1.3 Add representative renderer characterizations for each affected family covering focus, keyboard ownership, stacking, narrow layouts, scroll, selection copy, and theme updates.

## 2. Consolidate equivalent behavior

- [ ] 2.1 Move equivalent theme/selection access and scroll behavior to shared ownership, reusing existing stores and preserving per-consumer defaults.
- [ ] 2.2 Share equivalent modal framing while retaining feature-specific content, footer, animation, and key-handling wrappers; avoid a universal options matrix.
- [ ] 2.3 Retarget all live consumers one primitive at a time and remove replaced implementations after whole-source import checks.
- [ ] 2.4 Verify multiple mounted instances, nested modal disposal, and animated variant cleanup do not leak shared state or listeners.

## 3. Validate and document

- [ ] 3.1 Run affected dashboard/observability modal, lifecycle, clipboard, markdown, theme, and navigation renderer tests using installed OpenTUI/Solid patterns.
- [ ] 3.2 Document the shared primitive owners and retained differences; remove stale re-exports if no callers need them.
- [ ] 3.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build.
- [ ] 3.4 Run openspec validate consolidate-tui-primitives --strict and confirm no existing visual or input contract changed solely to reduce duplication.

## 1. Dashboard rendering

- [x] 1.1 Replace the muted `no upstream` fallback text in `agentic-coding/src/tui/dash/App.tsx` with the literal `` glyph, preserving the existing no-upstream condition, muted color, non-wrapping behavior, file-count segments, and branch display.
- [x] 1.2 Add or update focused dashboard TUI coverage in `agentic-coding/test/dash/userActions.test.tsx` (and its test fixture only if needed) to render a no-usable-upstream status, assert that `` is shown, and assert that the textual `no upstream` label is absent; retain coverage for the usable-upstream arrow segments and bounded line behavior.

## 2. Verification

- [x] 2.1 Run the focused dashboard tests, then `bun run type-check` and `bun run lint` from `agentic-coding/`; resolve any diagnostics without changing Git-status semantics.

## 1. Dashboard finding-count model

- [x] 1.1 Add a typed optional `findingCounts` value (`critical`, `warning`, `info`) to the dashboard agent data shape.
- [x] 1.2 Add a small data-layer aggregation helper that counts validated verifier findings by severity, and populate `findingCounts` from the current-round `committedVerifierOutput` while leaving unavailable results undefined.
- [x] 1.3 Extend the test dashboard fixture with representative verifier counts, including non-zero values for each severity, a zero severity, and at least one verifier without an available count summary.

## 2. Agents-panel rendering

- [x] 2.1 Add a compact Agents-panel finding summary renderer with stable critical/warning/info ordering and separate theme-backed error, warning, and info colors.
- [x] 2.2 Integrate the summary into verifier agent rows without adding it to non-verifier rows, preserving existing role/status, model/verdict, metric, selection, and `v`-action behavior.
- [x] 2.3 Keep the summary within the existing row and panel bounds, using the current overflow/scroll behavior so narrow panels and long agent or metric text do not alter the dashboard grid.

## 3. Verification and regression coverage

- [x] 3.1 Add data tests for per-severity aggregation, empty committed results producing explicit zero counts, and unavailable results remaining omitted.
- [x] 3.2 Extend Agents-panel rendering tests to assert severity labels/counts, zero-count display, omission for unavailable/non-verifier rows, and preservation of existing metric text.
- [x] 3.3 Verify the summary uses semantic theme colors and that existing verifier-result popup interaction remains covered by the focused dashboard tests.
- [x] 3.4 Run focused dashboard tests, `bun run type-check`, `bun run lint`, and `openspec validate extend-agent-panel-by-findings --strict`.

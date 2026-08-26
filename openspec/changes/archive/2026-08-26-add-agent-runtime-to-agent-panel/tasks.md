## 1. Dashboard Agent Projection

- [x] 1.1 Extend the dashboard agent data shape with an optional runtime and populate it from the latest role-associated workflow run, preserving existing model, status, metrics, and fallback behavior.
- [x] 1.2 Update the demo dashboard fixture with representative runtime/model metadata so the Agents panel can exercise runtime display without changing workflow routing data.

## 2. Agents Panel Rendering

- [x] 2.1 Add a presentation-only runtime label normalization/composition helper that maps internal `opencode-v2` to `opencode2` and combines runtime and selected model on one line.
- [x] 2.2 Render the composed runtime/model value in the existing Agents panel model row, retaining current role-specific fallbacks and overflow/row-height constraints.

## 3. Focused Verification

- [x] 3.1 Add dashboard data tests proving runtime propagation from workflow runs and absence of fabricated runtime values when metadata is unavailable.
- [x] 3.2 Add Agents panel rendering tests for `pi`, `opencode`, and `opencode-v2`/`opencode2`, including the same-line runtime/model output and bounded row behavior.
- [x] 3.3 Run the focused dashboard tests, Biome lint/format checks, and type-check; resolve any diagnostics without changing runtime contracts.

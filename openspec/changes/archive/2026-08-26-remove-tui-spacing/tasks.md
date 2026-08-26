## 1. Remove dashboard shell edge spacing

- [x] 1.1 Update the shared shell in `agentic-coding/src/tui/otel/app/App.tsx` so dashboard mode uses zero outer padding while non-dashboard observability mode retains its existing inset; verify home and per-workflow dashboard surfaces start at the terminal origin without changing trace-only layout.
- [x] 1.2 Remove the per-workflow dashboard content wrapper's outer right inset in `agentic-coding/src/tui/dash/App.tsx` while preserving its panel gaps and flexible column sizing; verify the detail dashboard reaches the terminal's right edge without horizontal overflow.

## 2. Verify dashboard layout behavior

- [x] 2.1 Add focused OpenTUI render coverage for home and per-workflow dashboard modes at fixed terminal dimensions, asserting header/content/footer placement at the first and last rows and full-width shell placement while representative dashboard text and interactions remain present; verify with the focused dashboard layout test.
- [x] 2.2 Run the complete dashboard regression and package checks (`cd agentic-coding && bun run test`, `bun run type-check`, and `bun run lint`) and verify they pass with no diagnostics.

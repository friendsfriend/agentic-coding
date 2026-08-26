## 1. Preserve complete Pi cache usage telemetry

- [x] 1.1 Update `agent-definitions/bridges/pi-telemetry.ts` to emit `cacheWriteTokens` whenever Pi supplies a numeric cache-write value, including zero, while continuing to omit unavailable fields.
- [x] 1.2 Update the Pi bridge regression test for explicit zero cache writes and regenerate `agentic-coding/src/workflow/embedded.generated.ts` with the normal build command without hand-editing the generated file.

## 2. Aggregate cache components in dashboard data

- [x] 2.1 Extend `AgentUsageMetrics` and the per-role accumulator in `agentic-coding/src/tui/dash/data.ts` with validated, summed `cacheWriteTokens`.
- [x] 2.2 Update dashboard demo telemetry and data tests to provide explicit zero or positive cache-write values, verify totals across multiple usage events, and verify omission for missing, negative, non-finite, or zero-denominator cache inputs.

## 3. Render the accurate cache hit rate

- [x] 3.1 Update `agentic-coding/src/tui/dash/App.tsx` to calculate cache hits as `cacheRead / (input + cacheRead + cacheWrite)`, require complete valid inputs, enforce the 0–100% bound, and render one decimal place without rounding incomplete high rates to 100%.
- [x] 3.2 Extend `agentic-coding/test/dash/agentMetricsPanel.test.tsx` and related dashboard tests with a positive cache-write case, a high-but-incomplete rate, exact full-hit behavior, and populated demo rendering assertions.

## 4. Validate the change

- [x] 4.1 Run the focused dashboard and telemetry tests, `bun run type-check`, `bun run lint`, and `openspec validate fix-cache-hit-rate-calculation --strict`; resolve any failures without changing unrelated workflow behavior.

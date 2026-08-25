## 1. Telemetry bridge

- [x] 1.1 Extend `agent-definitions/bridges/pi-telemetry.ts` `message_end` handler to emit `cacheReadTokens` (and cache-write when exposed) plus per-message duration and derived tokens/s on the existing `runtime.usage` envelope; omit fields the runtime did not provide. Verify with a unit test or manual run asserting the JSONL envelope fields.
- [x] 1.2 Regenerate `src/workflow/embedded.generated.ts` with `bun run build` and confirm via `git diff` that only the pi bridge entry changed.

## 2. Dashboard data layer

- [x] 2.1 In `agentic-coding/src/tui/dash/data.ts`, make `costSummary()`/`costMessages()` accept both `runtime.usage` and legacy `model_usage` event names; update demo fixtures in `testDashboard` to use `runtime.usage`. Verify with `bun test`.
- [x] 2.2 Add per-role metric aggregation (summed cost, input/output tokens, cache-read tokens, run start/end from lifecycle+usage events, output tokens per second with summed-generation-time preference) and expose it on `DashboardData.agents`. Verify with `bun test` covering multi-event roles, missing-field events, and no-event agents.

## 3. Agents panel UI

- [x] 3.1 Render one bounded muted metric line per agent in the Agents panel (`App.tsx`): tokens in→out, cache hit %, duration, tok/s; keep cost display; hide line entirely when no metrics exist; ensure truncation stays inside panel bounds. Verify by running the dash against demo data (`bun run dev:ui-dash`) and visually checking populated, partial, and empty agents.
- [x] 3.2 Add demo-dataset coverage so every metric field renders non-empty in `testDashboard` mode; verify via `bun test`.

## 4. Verification

- [x] 4.1 Run `bun run lint`, `bun run type-check`, and `bun test` in `agentic-coding/`; all must pass with zero diagnostics.
- [x] 4.2 End-to-end check: point a workflow at an OTLP endpoint, run one agent turn, and confirm the usage envelope reaching the endpoint contains input/output/cache tokens, cost, duration, and tok/s while the panel shows matching values from the same events.

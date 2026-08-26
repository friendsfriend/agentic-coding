## Context

The dashboard already reads per-message `runtime.usage` events and aggregates input, output, cache-read, cost, and timing data by role. Its cache-rate renderer currently divides `cacheReadTokens` by `inputTokens + cacheReadTokens`, while pi defines prompt volume as `input + cacheRead + cacheWrite`; it also rounds the displayed result to an integer. Pi's normalized usage separates uncached input, cached reads, and cache writes, so positive cache writes are currently omitted from the dashboard's aggregate and the displayed rate can be overstated or rounded to 100%.

The existing telemetry path is the source of truth: the Pi bridge writes usage events to the workflow telemetry file, `data.ts` aggregates them, and `App.tsx` renders the Agents panel. The change must preserve optional-field behavior for runtimes that do not expose cache data and must not alter workflow state or external APIs.

## Goals / Non-Goals

**Goals:**

- Match pi's cache-hit calculation for each role and across multiple usage events.
- Preserve cache-write counts when Pi exposes them, including an explicitly reported zero.
- Keep invalid or incomplete cache data from producing a misleading percentage.
- Display one decimal place so a high-but-not-complete rate such as 99.6% does not become 100% through integer rounding.
- Cover the runtime bridge, aggregation, and Agents-panel rendering with focused regression tests.

**Non-Goals:**

- Changing the workflow engine, telemetry storage format version, cost calculation, or lifecycle timing.
- Adding a second telemetry channel or recalculating cache rates from cost data.
- Changing pi itself or supporting provider-specific cache semantics beyond the normalized usage fields it exposes.

## Decisions

### Use pi's normalized prompt-token components

The bridge and dashboard will use the normalized usage semantics already used by pi: `inputTokens` is uncached input, `cacheReadTokens` is cached input, and `cacheWriteTokens` is input written to cache. The rate is:

`cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens) * 100`

All three components must be finite and non-negative, and the denominator must be positive. A missing component means the rate is omitted rather than inferred. This is preferred over retaining the current two-component formula because it matches pi's own prompt total and counts cache writes as uncached prompt traffic.

### Retain cache-write data in the existing metric model

Add `cacheWriteTokens` to the existing per-role metric accumulator and `AgentUsageMetrics`; sum it with the other usage fields using the same validation rules. The UI will derive the display rate from the aggregated components, ensuring multiple messages are totaled before calculation. No new abstraction or telemetry store is needed.

### Emit explicitly reported zero cache writes

The Pi bridge will include `cacheWriteTokens` whenever `usage.cacheWrite` is numeric, including zero. It will continue omitting the field when the runtime does not expose it. This distinguishes a known zero from unavailable cache telemetry and allows the dashboard to omit rates only when the required data is genuinely unavailable.

### Match pi's visible precision

Render the valid percentage with one decimal place and clamp only after validating that the mathematical result is within 0–100%. This prevents 99.x% from being rendered as 100% while still presenting exact full-hit rates as 100.0%. Existing demo and panel assertions will be updated to the new representation.

## Risks / Trade-offs

- [Older telemetry files lack cache-write fields] → They will not produce a cache rate under the strict complete-data rule; cost, token, duration, and tokens/s remain available. New Pi events provide an explicit zero when appropriate.
- [Some providers report inconsistent token components] → Validate every component and omit values outside the finite, non-negative range; never clamp malformed raw inputs into a plausible rate.
- [Generated embedded agent definitions can drift from the bridge source] → Regenerate with the repository's normal build and verify the generated bundle through the existing bridge tests; do not hand-edit the generated file.

## Migration Plan

No data migration is required. Deploy the bridge and dashboard changes together; existing telemetry remains readable, with cache rates omitted for historical events that lack cache-write metadata. If a rollback is needed, revert the bridge and dashboard code; workflow state and telemetry files remain backward-compatible.

## Open Questions

None. The normalized Pi usage fields and the existing dashboard telemetry pipeline provide the required contract.

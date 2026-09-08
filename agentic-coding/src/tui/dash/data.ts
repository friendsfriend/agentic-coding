// Compatibility barrel for the split dashboard: the observation/execution
// layer lives in `observations.ts`, deterministic projections in
// `projections.ts`, the demo fixture in `demo.ts`, and shared shapes in
// `types.ts`. This module re-exports the former public surface so existing
// callers (CLI observation bridge, tests, and any external dashboard import)
// keep working unchanged — narrow re-exports only, nothing re-implemented.

export * from "./demo";
export { listPresetNames } from "./engine";
export * from "./observations";
export * from "./projections";
export type * from "./types";

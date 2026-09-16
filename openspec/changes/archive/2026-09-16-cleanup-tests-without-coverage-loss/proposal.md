## Why

The repository's test audit found duplicated compatibility data and assertions that pass when their claimed production behavior is broken. Start with a no-loss cleanup: reduce maintenance burden and false confidence while preserving existing behavioral, security, persistence, and compatibility guarantees.

## What Changes

- Classify cleanup candidates by the defect or contract they protect, naming the surviving detector before removing overlapping coverage.
- Deduplicate the historical definition and step digest expectations in `workflow-steps.test.ts` without regenerating expected values from the implementation under test or dropping supported identities.
- Replace manufactured navigation outcomes and the copied modal implementation with focused assertions against production interaction paths and components, reusing existing suites.
- Repair the environment ownership import guard using the existing source-graph tooling and positive/negative fixtures; preserve distinct parent-barrel and layer constraints when consolidating checks.
- Correct misleading cycle, payload-boundary, and opt-in runtime smoke claims. Unexecuted runtime checks must report skipped rather than passed; executed preservation checks must assert the actual invariant.
- Remove only demonstrated redundancy or test-local scaffolding checks with no unique product guarantee. Preserve required instruction/asset contracts, real boundary tests, and supported API guarantees.
- Record focused fault-probe and before/after verification evidence in the change artifacts. Defer broad cosmetic pruning and the final repository-wide `AGENTS.md` testing policy until the cleanup results are reviewed.

## Capabilities

### New Capabilities

- `repository-test-quality`: Coverage-preserving test cleanup, production-backed assertions, independent compatibility expectations, and truthful runtime smoke reporting.

### Modified Capabilities

None. Existing workflow testability, source-layer, persistence, and runtime safety requirements remain in force; this change repairs or consolidates their checks rather than relaxing them.

## Impact

- Primarily `agentic-coding/test/`, its fixtures, and selected tests under `agentic-coding/packages/devenv/`.
- Existing architecture helpers under `agentic-coding/scripts/` and test reporting may receive minimal changes where required for correct guards or skip accounting.
- Test documentation and change-local verification evidence will reflect actual scope and commands. No production feature, public API, persisted format, workflow pin, new dependency, test framework, or automatic external-runtime provisioning is introduced.
- Existing concurrent telemetry/navigation work must remain untouched. Baseline counts and audit observations are a starting point, not a frozen inventory or a quota for deletion.

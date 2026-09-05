## Why

Existing import guards scan workflow .ts files and prevent cycles, but do not cover .tsx or enforce architecture direction. They cannot prevent dashboard code importing CLI orchestration or pure step behavior acquiring filesystem dependencies.

## What Changes

- Extend the existing TypeScript-based import graph helper to cover source .ts and .tsx modules and relevant static import forms.
- Enforce a small documented layer policy for core workflow logic, application orchestration, CLI, adapters, and TUI.
- Check purity-sensitive dependencies separately from runtime import cycles, including type-only architectural coupling where forbidden.
- Add negative fixtures proving forbidden edges fail with source/target diagnostics.
- Keep exceptional existing dependencies explicit and bounded rather than suppressing all historical violations.

## Capabilities

### New Capabilities

- `source-layer-boundaries`: Runnable source dependency and pure-domain boundary checks.

### Modified Capabilities

None.

## Impact

- Priority: low; architecture cleanup finding 3.
- Depends on `unify-workflow-startup-context`, `separate-workflow-observation-execution`, and `centralize-step-completion-behavior` for removal of the known ownership violations.
- Code: `agentic-coding/scripts/workflow-module-graph.ts`, architecture tests and fixtures, and `docs/workflow-architecture.md`.
- Uses the installed TypeScript compiler API and Bun test runner. No dependency-analysis package or runtime code generation.

## Non-goals

No whole-program purity proof, arbitrary file-size lint rule, new linter, package-per-layer reorganization, or mass import rewrite to satisfy cosmetic rules.

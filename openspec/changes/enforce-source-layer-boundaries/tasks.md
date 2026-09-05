## 1. Establish policy and source graph coverage

- [ ] 1.1 Confirm shared startup, observation/evidence separation, and step completion ownership prerequisites are implemented; inventory remaining source dependencies.
- [ ] 1.2 Extend the existing TypeScript graph helper to scan .ts/.tsx with correct ScriptKind and resolve extensionless, explicit-extension, and index targets.
- [ ] 1.3 Collect static imports/re-exports, literal import()/require() edges, external/builtin targets, and unresolved-relative diagnostics; retain separate runtime and type-aware architecture edges.
- [ ] 1.4 Add minimal fixtures for TSX cycles, type-only cycles, dynamic/literal requires, index resolution, and missing runtime targets.

## 2. Enforce documented ownership

- [ ] 2.1 Define a small explicit layer policy covering domain, runtime persistence, application operations, CLI, adapters, TUI features, and shared primitives.
- [ ] 2.2 Enforce TUI-to-application rather than TUI-to-CLI, no backend-to-presentation coupling including forbidden type imports, and no shared-primitive-to-feature imports.
- [ ] 2.3 Enforce direct/transitive pure-domain dependency rules and targeted direct I/O/clock-global diagnostics; reject computed module loading in guarded pure modules.
- [ ] 2.4 Preserve existing parent-barrel/runtime-cycle/export-surface checks and add exact-edge exceptions only with rationale/removal condition; reject unused exceptions.

## 3. Prove checks detect regressions

- [ ] 3.1 Add negative fixtures for each forbidden edge/global and assert diagnostics include source, target/location, and dependency path where applicable.
- [ ] 3.2 Add positive fixtures for explicit evidence/time inputs, allowed application calls, legitimate type contracts, and feature wrappers using shared primitives.
- [ ] 3.3 Run the checks against all src modules and resolve real violations through intended ownership rather than wildcard exemptions.

## 4. Validate and document

- [ ] 4.1 Run architecture helper/fixture, module-cycle, and export-surface tests through the normal Bun test runner.
- [ ] 4.2 Update workflow architecture docs with the enforced layer matrix, exception policy, covered import forms, and bounded static-analysis limitations.
- [ ] 4.3 From agentic-coding/, run bun run type-check and bun run lint with zero diagnostics; do not add another linter or analysis dependency.
- [ ] 4.4 Run openspec validate enforce-source-layer-boundaries --strict and confirm every new rule has a failing-before/failing-fixture runnable check.

## 1. Compatibility and baseline

- [ ] 1.1 Select a supported Effect release; verify Bun/TypeScript/compiled-binary compatibility, lock the dependency, and record version-matched official documentation links.
- [ ] 1.2 Inventory workflow modules, transitive callers, native I/O boundaries, and temporary bridges in `docs/workflow-effect-migration.md`, assigning every group to one roadmap phase.
- [ ] 1.3 Record baseline results for the two agent tasks in the roadmap on disposable worktrees, including prompts/model/instructions, checks, human corrections, and failures; do not merge evaluation changes.
- [ ] 1.4 Characterize command/snapshot/question/step contract acceptance, normalization, historical identities/digests, and current diagnostic codes with focused existing fixtures plus missing edge cases.

## 2. Schema and failures

- [ ] 2.1 Define concrete tagged domain failures and the bounded, redacted external diagnostic mapping; verify stale revision, stale ownership, validation, and unexpected defect distinctions.
- [ ] 2.2 Migrate command and developer-dialogue contracts to Effect Schema; update their direct callers and focused tests without changing external accepted forms.
- [ ] 2.3 Migrate snapshot/profile/settings data decoding to Schema, preserving legacy defaults, cross-field invariants, paths, and serialized shapes.
- [ ] 2.4 Migrate built-in step input/output contracts to Schema while retaining contract IDs/versions and registry/assignment digest inputs.
- [ ] 2.5 Remove replaced parser implementations; list any temporary caller facade with exact symbol and phase-4 removal owner, and verify every retained parse facade delegates to Schema.

## 3. Agent conventions and validation

- [ ] 3.1 Write `docs/workflow-effect.md` with one version-matched idiom per operation/error/schema/service/scope/test boundary; add checked production-backed examples rather than a new abstraction library.
- [ ] 3.2 Link the playbook and migration inventory from root `AGENTS.md` and `src/workflow/README.md`; document pure-domain and durable-outbox exceptions explicitly.
- [ ] 3.3 Run focused contract, registry, step, question, and snapshot compatibility checks; include malformed/legacy data and stable historical digests.
- [ ] 3.4 Run `bun run type-check`, `bun run lint` with zero diagnostics, and `bun run build` from `agentic-coding/`; smoke-test the compiled workflow command and record results. Regenerate embedded assets only through the build.

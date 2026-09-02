## 1. Implement wiki gating for archive-free no-openspec

- [x] 1.1 In `agentic-coding/src/workflow/definitions.ts`, update `workflowEdges(archive, maxVerificationRounds, wikiGate, wikiBeforeArchive)` so that when `archive === false` and `wikiGate === true` it sets `approved` to `core.wiki` and emits the archive-free wiki edge block (`core.wiki --complete--> core.wiki-approval`; `core.wiki --blocked/failed--> core.wiki` bounded; `core.wiki-approval --approve--> core.delivery` with the `wiki.verify` effect; `core.wiki-approval --comments--> core.wiki` bounded loop), while leaving `archive === false && wikiGate === false` behavior unchanged (approved → `core.delivery`, no wiki edges). Verify by inspecting the generated edges for `no-openspec` at a policy version in a unit test.
- [x] 1.2 In the `no-openspec` manifest entry, insert `core.wiki` and `core.wiki-approval` into the `steps` array immediately before `core.delivery` when `wikiGate` is true (leave legacy `wikiGate === false` step list unchanged), and change its `edges` to `workflowEdges(false, rounds, wikiGate)`. Verify the policy-version `no-openspec` step list is `[...common, "core.wiki", "core.wiki-approval", "core.delivery", "core.completed", "core.closed"]` and the legacy version omits the two wiki steps.

## 2. Update and extend tests

- [x] 2.1 Update `agentic-coding/test/workflow-wiki-gate.test.ts`: keep the legacy (`version 1`) `no-openspec` assertion that it contains no wiki steps, and add an assertion that the policy version (`definitionVersionForPolicy(6)`) of `no-openspec` contains `core.wiki` and `core.wiki-approval` between `core.developer-review` and `core.delivery`, with `core.wiki-approval --approve--> core.delivery` carrying a `wiki.verify` effect and `--comments--> core.wiki`. Verify by running `bun test test/workflow-wiki-gate.test.ts`.
- [x] 2.2 Update `agentic-coding/test/workflow-e2e.test.ts` so the `no-openspec` drive path exercises the wiki + wiki-approval steps when running the policy version (and confirm the default/legacy path still reaches terminal without wiki). Verify by running `bun test test/workflow-e2e.test.ts`.
- [x] 2.3 Run `bun test test/workflow-registry.test.ts test/workflow-migration.test.ts` and confirm any `no-openspec` step/graph expectations still pass; adjust only expectations that legitimately change for the policy version while keeping legacy-version expectations intact.

## 3. Validation

- [x] 3.1 Run `bun run type-check` and `bun run lint` from `agentic-coding/` and confirm both pass with zero diagnostics.
- [x] 3.2 Run `openspec validate unify-workflows --strict` and confirm it passes.

## Why

Every code-changing workflow should promote its knowledge changes through the wiki documentation and wiki review gate, but the `no-openspec` workflow currently skips wiki entirely: because it has no OpenSpec archive step, the wiki-gate machinery excludes it, so a code change made through `no-openspec` never records or reviews knowledge. The OpenSpec-based code-changing workflows (`openspec-full`, `openspec-apply`, `openspec-fusion-full`) already run wiki + wiki review before archive/delivery; `no-openspec` is the lone code-changing gap.

## What Changes

- Add the `core.wiki` documentation step and `core.wiki-approval` review gate to the `no-openspec` workflow (policy/wiki-gated definition versions) so it runs `core.developer-review → core.wiki → core.wiki-approval → core.delivery`.
- Generalize the wiki-gate composition so an archive-free **code-changing** workflow (currently `no-openspec`) receives the wiki documentation and approval steps, while the archive-free documentation-only `wiki-only` workflow keeps advancing to `core.completed`. Wiki approval `approve` advances to `core.delivery` (enqueueing the engine-owned `wiki.verify` effect when concepts were touched); `comments` returns to `core.wiki` under a bounded loop.
- Preserve existing behavior for the legacy, non-gated definition versions (`wikiGate = false`) of `no-openspec` so migration/backward-compatibility stays intact.
- Leave proposal-only workflows (`openspec-propose`, `openspec-fusion-propose`) and the `research` workflow unchanged: they do not change code (research stays as-is per the task).

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `knowledge-wiki`: The "Wiki approval gate precedes delivery" requirement changes so that an archive-free code-changing workflow (`no-openspec`) includes the wiki documentation and approval steps before delivery, instead of the current rule that only `wiki-only` may carry those steps without an archive.
- `no-openspec-workflow`: The lifecycle and skip-archive requirements change so that an approved developer review proceeds through `core.wiki` and `core.wiki-approval` before `core.delivery`, rather than directly to delivery.

## Impact

- `agentic-coding/src/workflow/definitions.ts`: `no-openspec` manifest step list and its `workflowEdges(...)` call (thread `wikiGate` through the archive-free branch so wiki steps/edges are emitted between developer review and delivery).
- Tests: `agentic-coding/test/workflow-wiki-gate.test.ts` (the assertion that `no-openspec` contains no wiki steps), `agentic-coding/test/workflow-e2e.test.ts` (the `no-openspec` drive path), and any registry/migration expectations that assume `no-openspec` has no wiki steps.
- No change to runtime effect kinds, contracts, or the `wiki.verify` effect itself.

## Context

See proposal.md — Why. The workflow catalog is defined in `agentic-coding/src/workflow/definitions.ts`. Manifests are produced by the `manifests(rounds, version, wikiGate, wikiBeforeArchive)` factory, and per-step edges are produced by `workflowEdges(archive, maxVerificationRounds, wikiGate, wikiBeforeArchive)`.

Key current behavior:
- `registerBuiltins` registers, for each `rounds` in 1..20, both a legacy definition set (`wikiGate = false`) and a policy definition set (`wikiGate = true`, version = `rounds + 100`). The running app selects the policy version via `definitionVersionForPolicy(config.workflow.max_verification_rounds)` (see `tui/dash/engine.ts` and `cli.ts`), so the wiki-gated versions are the ones users actually run.
- `no-openspec` is built with `edges: workflowEdges(false, rounds)` — it passes neither `wikiGate` nor `wikiBeforeArchive`, and its `steps` list is `[...common, "core.delivery", "core.completed", "core.closed"]` with no wiki steps.
- Inside `workflowEdges`, when `archive === false` the `approved` target is `core.delivery` and no wiki edges are emitted, regardless of `wikiGate`. So `no-openspec` never gets wiki, even at policy versions.
- The OpenSpec code-changing workflows (`openspec-full`, `openspec-apply`, `openspec-fusion-full`) already include `core.wiki` + `core.wiki-approval` before archive when `wikiGate` is true.

## Goals / Non-Goals

**Goals:**
- `no-openspec` policy (wiki-gated) definitions run `core.developer-review → core.wiki → core.wiki-approval → core.delivery`.
- Reuse the existing wiki step definitions, `wiki.verify` effect wiring, and bounded comment loop already used by the other workflows.
- Keep legacy (`wikiGate = false`) `no-openspec` definitions byte-for-byte behavior-compatible for migration/back-compat.

**Non-Goals:**
- No change to `research` (explicitly out of scope per task), proposal-only workflows, or the `wiki-only`/`wiki-comments` workflows.
- No new effect kinds, contracts, or step definitions.
- No change to the archive step or archive-bearing ordering.

## Decisions

**Decision: Thread `wikiGate` into the archive-free branch of `workflowEdges` and the `no-openspec` manifest, rather than adding a bespoke code path.**
- In the `no-openspec` manifest, gate the step list on `wikiGate` (insert `core.wiki`, `core.wiki-approval` before `core.delivery` when `wikiGate` is true) and call `workflowEdges(false, rounds, wikiGate)`.
- In `workflowEdges`, when `archive === false`:
  - Set `approved` to `core.wiki` when `wikiGate` is true, else `core.delivery` (current behavior).
  - When `wikiGate` is true, emit the archive-free wiki edge block: `core.wiki --complete--> core.wiki-approval`, `core.wiki --blocked/failed--> core.wiki` (bounded), `core.wiki-approval --approve--> core.delivery` with the `wiki.verify` effect, and `core.wiki-approval --comments--> core.wiki` (bounded loop).
- Rationale: This mirrors the archive-before-approval edge block already present for `wikiGate && wikiBeforeArchive`, but targets `core.delivery` instead of `core.archive`. It keeps a single source of truth for wiki wiring and avoids duplicating the manifest.
- Alternative considered: a dedicated `no-openspec`-specific manifest with hand-written wiki edges. Rejected — it duplicates the wiki gate logic and diverges from the shared `workflowEdges` helper, increasing drift risk.

**Decision: Only the wiki-gated (policy) versions gain wiki; legacy versions stay unchanged.**
- The registration loop already builds legacy (`wikiGate = false`) and policy (`wikiGate = true`) sets. Gating purely on the existing `wikiGate` flag automatically preserves legacy definitions.
- Rationale: Legacy versions back migration of pre-existing runs; changing them would alter historical definition graphs.

## Risks / Trade-offs

- [Existing tests assert `no-openspec` has no wiki steps] → Update `workflow-wiki-gate.test.ts` (the `no-openspec` version-1/legacy assertion stays valid; add coverage for the policy version now containing wiki) and the `workflow-e2e.test.ts` `no-openspec` drive path (which currently walks straight to delivery under the policy version). Confirm registry/migration tests that enumerate `no-openspec` steps still hold for legacy versions.
- [Divergence between legacy and policy graphs] → Intentional and consistent with how the other code-changing workflows already differ by `wikiGate`; covered by keeping the change scoped to the `wikiGate === true` branch.
- [wiki-approval prompt copy mentions "before archival"] → The developer-review/wiki-approval user action text is generic enough to reuse; no copy change is required for correctness, and altering shared copy is out of scope.

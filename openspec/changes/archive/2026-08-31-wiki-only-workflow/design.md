## Context

The repository already has a centralized OKF wiki, a `core.wiki` agent step, a `core.wiki-approval` developer gate, and engine-owned `wiki.verify` promotion. Those pieces are currently reachable only as part of archive-bearing workflows, whose surrounding planning, implementation, verification, archive, and delivery stages are inappropriate for documentation-only requests. The CLI and dashboard also assume that every selectable workflow is a code-oriented or proposal workflow.

The developer decision for this change is **repository-required**: a source repository remains mandatory so the documentation agent can inspect repository evidence. That repository is context, not the output target. The centralized wiki is the only user-owned content that the workflow may change; workflow bookkeeping under `.herdr-workflow` remains engine-owned state.

## Goals / Non-Goals

**Goals:**

- Add a versioned, registry-validated `wiki-only` workflow with a small lifecycle: wiki documentation, wiki approval, completed, and explicit close.
- Require a source repository and use its existing checkout without creating or switching branches or worktrees.
- Allow a dirty source checkout because the workflow does not claim source changes, while detecting/rejecting source-content changes attributable to the documentation run before accepting completion.
- Reuse the existing wiki writer, snapshot review, approval action, and engine-owned human verification effect.
- Expose the workflow consistently in the CLI, dashboard start flow, routing, assignments, help text, and focused tests.
- Keep OpenSpec, implementation, verification, archive, delivery, and pull-request effects unreachable.

**Non-Goals:**

- A repository-free wiki workflow; the source repository is intentionally required.
- Changes to repository code, tests, Git branches, or source documentation as part of a managed wiki-only run.
- A new wiki storage format, CLI operation, review modal, approval mechanism, or verification actor.
- Replacing or changing the lifecycle of existing `standard`, `direct-apply`, `no-openspec`, `plan-fusion`, or proposal workflows.

## Decisions

1. **Compose a new workflow from existing wiki and terminal steps.** Register `wiki-only` with `core.wiki`, `core.wiki-approval`, `core.completed`, and `core.closed`. Route `core.wiki` completion to approval, approval to completion with the existing `wiki.verify` effect, comments back to `core.wiki` with the existing bounded review loop, and close to `core.closed`. This preserves established review and provenance behavior without adding a parallel wiki implementation. Reusing `standard` was rejected because it necessarily reaches code-changing stages; adding a second documentation agent step was rejected because it would duplicate the existing authenticated wiki-write contract.

2. **Use checkout-mode, same-checkout startup.** The CLI and engine will require a real source repository, checkout mode, and a named current branch, then pass `sameCheckout: true` to workspace setup. Startup will not require an OpenSpec project, a clean tree, or remote inspection for this definition; the current checkout/HEAD supplies evidence metadata. Worktree mode, branch creation/switching, and worktree creation are rejected for `wiki-only`. This keeps repository context available while preventing Git setup from claiming a code-change workspace.

3. **Enforce source isolation at the workflow boundary.** The wiki assignment will explicitly permit repository reads and centralized wiki CLI writes only. The engine will capture a deterministic source-content fingerprint at startup and compare it before accepting the wiki agent's successful handoff; the fingerprint preserves the pre-existing dirty state and includes tracked/index changes and untracked file content. A mismatch blocks completion and records an attention diagnostic rather than silently accepting source edits. Engine state and run artifacts remain outside the source-content comparison. A profile read-only policy alone is insufficient because current adapter policy is not a complete filesystem sandbox.

4. **Keep approval as the trust boundary.** Wiki writes remain unverified drafts. `core.wiki-approval` reuses the existing snapshot-backed review and enqueues `wiki.verify` only for approval; comments never promote concepts. Approval then moves directly to `core.completed`, not archive or delivery. The knowledge-wiki contract will explicitly allow this archive-free exception while retaining the existing ordering rules for archive-bearing definitions.

5. **Add explicit UI/CLI metadata rather than infer behavior from the label.** Add the definition to the CLI's accepted workflow IDs/help and to dashboard workflow choices and labels, specifically including `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx` so developers can select `wiki-only` through the new-workflow modal. Start argument conversion will select checkout/same-checkout semantics for `wiki-only`, and shared routing will derive the single `wiki` role from the registered step. The modal and dashboard will explain that the selected repository is evidence-only and will not offer code-oriented inputs or actions specific to implementation/delivery.

6. **Pin the definition through the existing registry/version policy.** The new manifest will be emitted for the supported policy versions through the same digest and validation path as built-ins. Existing definition IDs and pins remain untouched; new starts pin `wiki-only` exactly like every other workflow.

## Risks / Trade-offs

- **[Risk]** A trusted agent can make transient source edits that are restored before handoff and therefore escape a final fingerprint check. → Use explicit assignment restrictions and a read-only-capable route where available; treat the fingerprint as protection against persisted source changes, not a hostile-process sandbox.
- **[Risk]** A concurrent workflow may legitimately change the same checkout while `wiki-only` is running. → Preserve the initial dirty baseline and fail closed on an unexpected final fingerprint, directing the operator to retry from a stable checkout.
- **[Risk]** Existing consumers may assume every workflow requires OpenSpec artifacts or a remote. → Keep the exception narrowly keyed to `wiki-only` and add start-guard tests proving all other definitions retain their current checks.
- **[Risk]** Human approval may be postponed indefinitely, leaving a workspace alive. → Retain the existing explicit close path and do not schedule cleanup before close.

## Migration Plan

No data migration is required. Register the new definition alongside existing built-ins and include it in the current configured-policy version generation. Existing workflow snapshots continue to resolve against their original definition pins. Deploy the CLI/dashboard and engine together, then validate a new workflow through documentation, approval, explicit close, and cleanup. Rollback consists of disabling new `wiki-only` starts while preserving already-pinned definitions; do not reinterpret or mutate existing workflow snapshots.

## Open Questions

None remaining after the repository-required decision. The implementation should use the existing centralized wiki root and approval identity configuration; no new repository or wiki flags are needed.

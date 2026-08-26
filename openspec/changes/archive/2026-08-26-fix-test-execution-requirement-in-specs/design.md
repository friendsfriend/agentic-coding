## Context

The standard planner receives `planning.md`, while fusion planners and the consolidator receive separate planning assets. Workers already receive a focused-test-only policy, and the verification reducer creates the test-verifier run after the selected verifier runs finish. The defect is therefore an instruction mismatch: planning assets can put ownership of the complete suite into OpenSpec implementation tasks even though the runtime owns that run later.

## Goals / Non-Goals

**Goals:**

- Make every planning path state the same validation ownership boundary.
- Keep worker tasks actionable by requiring focused checks for changed behavior.
- Preserve the existing automatic test-verifier scheduling and worker execution contract.
- Prove the embedded assignment prompts contain the boundary and remain synchronized with source assets.

**Non-Goals:**

- Do not change workflow transitions, verifier selection, test-verifier scheduling, or task completion semantics.
- Do not make the worker run the complete suite or add a new verifier role.
- Do not prescribe a repository-wide test command in planning assets; the test-verifier retains responsibility for the repository's configured suite.

## Decisions

1. **Put the rule in all planning instruction assets.** Add a concise validation-ownership section to `planning.md`, `planning-fusion.md`, and `fusion-consolidation.md`. Each asset will direct the planner to describe focused, change-relevant checks in implementation tasks and explicitly prohibit a complete-suite worker task. The wording in the consolidation asset will protect the normal artifacts from full-suite requirements introduced while reconciling drafts.

   Alternative rejected: changing only `implementation.md`, because that instruction already limits workers and cannot prevent an incompatible requirement from being written into the OpenSpec task checklist.

2. **Treat the test-verifier as the sole complete-suite owner.** The planning guidance will refer to the workflow-owned test-verifier and its existing post-verification scheduling, without adding commands or attempting to coordinate the run from a planner. This keeps the prompt contract aligned with the reducer's current behavior and avoids duplicate or premature suite execution.

   Alternative rejected: removing all test-validation guidance from plans, because workers still need focused acceptance checks to complete individual tasks.

3. **Regenerate rather than hand-edit bundled assets.** After source instruction edits, run the repository's existing embedded-asset generation/build flow so `agentic-coding/src/workflow/embedded.generated.ts` reflects the pinned assets. Do not hand-edit the generated file.

4. **Add prompt-level regression assertions.** Extend the assignment/prompt tests to render standard planning and fusion planning/consolidation assignments and assert that they contain focused-validation guidance, prohibit a complete-suite worker requirement, and identify test-verifier ownership. Retain the existing source-versus-embedded hash checks so stale bundles fail independently.

## Risks / Trade-offs

- [Risk] A planner may still phrase a full-suite task differently. → Use explicit ownership and prohibition language in every planning asset, and test for the key boundary phrases rather than one incidental wording.
- [Risk] Generated asset pins can become stale after source edits. → Regenerate the embedded bundle and run the existing pin/hash and prompt rendering tests.
- [Risk] Prompts become repetitive across planning paths. → Keep the ownership rule short and identical in intent; the duplication is intentional because each step receives its own pinned asset.

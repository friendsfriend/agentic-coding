## Context

The current `stage-test` family has one tester agent, an evidence-backed report, a developer review action that routes to `core.wiki`, and a later `stage-wiki` writer. The report already supports `new`, `confirmed`, `contradicted` and `missing` observations, but the tester brief does not make complete business-process understanding an explicit report goal. The review action currently hides wiki write-back when all observations are confirmations. Existing process pages emphasize stage mechanics and do not require process purpose, business inputs/outputs, decision rules, or implementing block links.

The workflow graph already routes `approve-and-update-wiki` to `core.wiki` and its current authored-block tier promotes claimed blocks on both report-approval outcomes. The key gate is the stage review action availability; retain ordinary `approve` and preserve the block-promotion behavior. Wiki concepts already support process types and ordinary Markdown links. The store remains schema version 6.

## Goals / Non-Goals

**Goals:**

- Make concise, evidence-backed business understanding part of the tester's report while keeping testing with reviewed or newly authored blocks as its only goal.
- Have the tester read the matching process page first and report only the useful delta: learned, confirmed, contradicted or unresolved business facts.
- Allow wiki review for any non-empty observation list and document the business process, including links to blocks that implement its steps.
- Prevent stale concurrent process-page writes from overwriting newer knowledge; treat observations as untrusted evidence and keep report Markdown structurally safe.
- Keep prompts within their measured budgets and retain existing store and report schemas.

**Non-Goals:**

- Change test execution authority, stage access, block execution or block promotion policy.
- Store UI, selector, timing or other interaction-tool quirks as process knowledge; they remain findings.
- Add migrations, compatibility shims, report fields, or a new workflow graph route.
- Change the generic wiki concept format or wiki storage schema.

## Decisions

1. **Use the existing observation contract.** Keep `core.stage-report@1` and the journal observation shape unchanged. The tester associates each learned process fact with its process concept and records its kind and concise statement/observation supported by the journal. When a block implements a step, include its ID in that step's existing observation/journal wording when the association is supported; stage-wiki links only explicit associations. When there is no process page, every process step learned gets at least one `new` observation; `missing` captures important unresolved business information, not a substitute for documenting learned steps. Read existing process knowledge first and avoid repeating confirmed facts at length. UI and selector/timing problems stay in findings.

   Alternative considered: add report fields or a structured process model. Rejected because the current observation contract is sufficient and the task forbids schema changes.

2. **Use the stage-review action as the wiki gate.** Make `approve-and-update-wiki` available exactly when the report has one or more observations, including a confirmed-only list. Keep `approve-review` available, preserve the action's promoted-block count, and keep the existing graph edge/effect so the selected wiki path promotes claimed blocks just as ordinary approval does. Add focused tests for confirmed-only availability and the approval paths' promotion behavior. Because this changes no graph shape, keep it in the current stage-test definition tier and do not introduce a new graph tier; preserve older pinned graph contracts.

   Alternative considered: route every report through `core.wiki` or add a new conditional graph edge. Rejected because the existing review action is the explicit developer choice and already has the correct route and promotion effect.

3. **Write a business process concept using existing wiki primitives.** Extend the stage-wiki brief to create or update `projects/<system>/processes/<process>` with purpose, actors, ordered steps, decisions/rules, inputs, outputs and open questions derived from missing or contradicted observations. Link each documented step to the block IDs that implement it when the report identifies them. Continue using the existing process index and `stage://<stage>/<workflow-id>` provenance. Do not put UI quirks on process pages. Preserve the existing policy for product-change contradictions, disputed regression/unknown contradictions, and confirmations; a confirmation alone does not cause a write.

   Alternative considered: change the generic wiki schema or add typed links. Rejected because OKF concepts already permit ordinary Markdown links and no storage change is needed.

4. **Keep the role briefs concise and measured.** Add direct, short instructions to the tester and stage-wiki assets, regenerate `embedded.generated.ts` with the repository generator, and rely on the prompt-budget test to catch growth. Adjust a budget only if a measured, intentional change requires it; do not expand the static ceiling merely to mask unnecessary prompt text.

5. **Guard concurrent wiki writes with a per-path lock and content digest.** Serialize the concept read-modify-write sequence across processes, expose the current `contentDigest` from `wiki show`, and require stage-wiki writes to compare the digest (or `absent`) under the lock. Reject a stale write rather than replacing a page based on an old read; the role then rereads the latest page, merges the approved observations and retries. `wiki show` derives parsed content and `contentDigest` from one byte snapshot, so a replacement cannot mix revisions. Verification compares the approval digest while holding the same lock. Abandoned locks fail closed with bounded acquisition timeout; automatic stale-directory reaping is deliberately excluded because it can delete a replacement lock generation. An operator must confirm that no writer is active before manually removing an abandoned lock. This keeps the storage format/schema unchanged.

   Alternative considered: attempt a generic Markdown merge at write time. Rejected because the writer's intended changes cannot be inferred reliably from a full replacement body.

6. **Keep observations untrusted and report rendering inert.** Bound and normalize the observation fields before supplying them to the tool-capable wiki role in a distinct untrusted evidence payload. Escape every dynamic value in the engine-rendered report Markdown and flatten line breaks so report content cannot create headings, links or other structure. Label confirmed-only wiki review as no changes expected while retaining promoted-block counts.

   Alternative considered: trust the model to ignore instruction-like report text or escape only the knowledge section. Rejected because the role can write wiki drafts and every report section can contain dynamic text.

## Risks / Trade-offs

- [Observation kind ambiguity] A fact can be new to the wiki while confirmed by an existing journal or other source → define `new` as newly documented process understanding and use `missing` for unresolved or absent business details; scenarios distinguish a fully undocumented process from an unknown rule.
- [Wiki overstatement] A single run may not prove every business rule or a block-to-step association → require citations to report/journal evidence, link only explicitly supported block mappings, preserve uncertainty as open questions or disputed callouts, and exclude UI/tooling friction.
- [Prompt injection residual risk] Normalization and untrusted-evidence labels are defense in depth, not technical enforcement of claim fidelity. Natural-language instructions can survive into a tool-capable writer's context. Retain server-enforced pinned-system/source scope, draft-only writes and independent final developer review. A claim broker or extraction/write split is outside this change's selected scope.
- [Prompt growth] New direction could exceed the stage-wiki or stage-tester budget → keep both additions concise, regenerate embedded assets, and run the prompt-budget test.
- [Pinned versions] A change to shared step behavior could affect previously registered definitions → keep the graph unchanged, test current registration and pinned definitions, and follow the current definition-tier registration pattern without changing stored schema or old graph digests.

## Migration Plan

No migration or compatibility shim. Update the current instruction assets and stage review/gating behavior, regenerate the embedded instruction asset, and retain store schema version 6 and the existing report contract.

## Open Questions

The general `knowledge-wiki` specification is updated only for cross-process write serialization and expected-digest conflict refusal; concept format and persisted schema remain unchanged.

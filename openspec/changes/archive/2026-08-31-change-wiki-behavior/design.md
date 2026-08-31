## Context

The centralized wiki is an OKF v0.2 bundle, and the dedicated `wiki` role is the only managed role allowed to author drafts. The role already has access to `wiki search`, `wiki show`, and a path-based `wiki write`; `writeConcept` merges input with the existing document at the selected path, preserves unknown frontmatter fields, snapshots the pre-change content, and refreshes `generated.at`. The current instruction and specification mention avoiding active near-duplicates, but do not give the agent a sufficiently explicit selection sequence or require a rationale when it creates a new concept.

OKF v0.2 treats the corpus as continuously maintained knowledge. Stable concept identifiers, provenance, lifecycle status, and generated timestamps therefore need to survive ordinary updates rather than being bypassed by creating a second document.

## Goals / Non-Goals

**Goals:**

- Make update-in-place the default behavior for the dedicated wiki role.
- Require search and inspection of likely existing concepts before authoring.
- Make creation an intentional fallback for a genuinely new or materially distinct subject, with run evidence explaining the distinction.
- Preserve the existing OKF and workflow guarantees while updating content.
- Provide focused regression coverage for the agent guidance and embedded definition.

**Non-Goals:**

- Automatically merging or deleting already-duplicated concepts.
- Changing the `wiki write` CLI, concept-path format, OKF v0.2 format, approval gate, or verification lifecycle.
- Adding an automated semantic similarity or duplicate-detection service.
- Updating existing wiki content during planning; planning remains read-only with respect to the wiki.

## Decisions

1. **Put the decision procedure in the dedicated wiki instructions.** Add an explicit sequence: search broadly using subject, title, tags, and related terms; show/read the best candidates; select the canonical existing concept when its subject matches; update that identifier in place; create only when no candidate is the intended subject or the requested knowledge is materially distinct. Require the run evidence to identify the updated concept, or to state why a new concept was necessary. This is preferred over relying on the existing short “avoid near-duplicates” wording because the agent needs an operational rule before it chooses a write path.

2. **Strengthen the existing `knowledge-wiki` requirement rather than introduce a new capability.** The behavior belongs to the already-defined dedicated wiki role. The delta will retain the complete existing OKF draft, source, status, review, and no-op requirements while making update-first selection and the distinct-new-concept exception normative and testable.

3. **Keep path-based writes unchanged.** Once the agent selects the canonical identifier, the current implementation already updates that file and merges unknown frontmatter. A CLI-level fuzzy matcher would be unable to reliably distinguish a new concept from a legitimate sibling and could block valid authoring; the agent's evidence-backed search and inspection is the appropriate decision point.

4. **Test the source instruction and embedded copy, not only prose in isolation.** Extend the focused wiki-scope test to assert the update-first sequence, the creation exception, and the required rationale. Regenerate `src/workflow/embedded.generated.ts` with the existing build process so runtime instructions match `agent-definitions/instructions/wiki.md`; do not hand-edit the generated file.

## Risks / Trade-offs

- **[Risk] A relevant existing concept may be missed by search terminology.** → Require multiple related search terms and inspection of candidate titles, tags, descriptions, and bodies; retain the explicit “no suitable candidate” rationale for new concepts.
- **[Risk] An agent may update a broad concept when a separate concept is warranted.** → Define “materially distinct subject” as the permitted creation case and require evidence to explain the distinction; keep human review as the final gate.
- **[Risk] Existing duplicates remain after this change.** → Do not perform an unrequested merge or deletion migration; apply the rule to future authoring and let separate documentation work reconcile old duplicates safely.
- **[Risk] Generated instructions become stale.** → Make regeneration a required implementation and focused validation step, with the source instruction as the editable authority.

## Migration Plan

No data migration is required. After the instruction and spec/test changes are deployed, new wiki runs will search and inspect existing concepts before writing. Existing concepts and any historical duplicates remain untouched. If the behavior causes an unacceptable result, revert the instruction and generated embedding changes; no persisted schema or CLI compatibility change is involved.

## Open Questions

None. The requested behavior is sufficiently defined as an update-first authoring rule with a documented exception for genuinely new concepts.

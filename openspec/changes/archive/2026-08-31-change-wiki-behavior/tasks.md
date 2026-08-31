## 1. Dedicated wiki guidance

- [x] 1.1 Update `agent-definitions/instructions/wiki.md` to require an update-first authoring sequence: search with multiple related terms, inspect likely candidates with `wiki show`, select the canonical existing concept when applicable, and write to that identifier in place.
- [x] 1.2 Document the only creation exception in the wiki instructions: create a new project-scoped concept only when no candidate is the intended subject or the knowledge is materially distinct, and require run evidence to explain why an update would be incorrect.
- [x] 1.3 Ensure the updated guidance explicitly preserves existing concept identity, unrelated content, unknown frontmatter, and applicable provenance/lifecycle metadata when updating, while retaining the existing OKF, project-scoping, draft, and source-citation rules.

## 2. Regression coverage and generated runtime definition

- [x] 2.1 Extend `agentic-coding/test/workflow-wiki-scope.test.ts` with focused assertions for the update-first search/read/select/update sequence, the distinct-new-concept exception, and the required creation rationale; keep assertions for the embedded definition synchronized with the source instruction.
- [x] 2.2 Run `bun run build` from `agentic-coding/` to regenerate `agentic-coding/src/workflow/embedded.generated.ts` from the updated instruction source; do not hand-edit the generated file.
- [x] 2.3 Run the focused wiki guidance regression test (`bun test test/workflow-wiki-scope.test.ts` from `agentic-coding/`) and confirm it passes with the regenerated embedded definition.

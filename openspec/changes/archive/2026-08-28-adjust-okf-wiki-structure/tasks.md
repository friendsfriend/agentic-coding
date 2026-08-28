## 1. Specify the scope contract

- [x] 1.1 Update the `knowledge-wiki` delta at `openspec/changes/adjust-okf-wiki-structure/specs/knowledge-wiki/spec.md` with the full modified centralized-bundle, planning-role, and archive-role requirements plus the namespace and legacy-migration requirements; verify every requirement has complete `####` scenarios and `openspec validate adjust-okf-wiki-structure --strict` accepts the delta structure.

- [x] 1.2 Re-read the completed proposal, design, and delta spec from disk and reconcile any wording mismatch before implementation; verify the final contract preserves the existing root precedence, CLI operations, draft/unverified lifecycle, and no-federation/no-new-frontmatter-field decisions.

## 2. Update user and agent guidance

- [x] 2.1 Update `agent-definitions/instructions/planning.md`, `planning-fusion.md`, `fusion-consolidation.md`, and `archive.md` with consistent guidance to identify the project context, use `projects/<project-id>/...` for project facts, reserve `shared/...` for cross-project evidence, qualify repository-relative paths, update concepts in place, and avoid active duplicates; verify fusion planning remains wiki-write-free and sequential/archive role boundaries remain intact.

- [x] 2.2 Update the Knowledge wiki section of `README.md` with the centralized-bundle namespace convention, project-relative source interpretation, shared-evidence rule, and legacy update/migration policy without changing the documented CLI operations or root-resolution precedence; verify the README contains both namespace forms and no positive single-repository-bundle claim.

- [x] 2.3 Add focused scope validation at `agentic-coding/test/workflow-wiki-scope.test.ts` that reads the four instruction assets, README, and the knowledge-wiki delta and asserts the namespace/source-context/shared-evidence/update-in-place guidance, absence of contradictory single-repository claims, and preservation of the parallel-planner write prohibition; verify it passes with `cd agentic-coding && bun test test/workflow-wiki-scope.test.ts`.

## 3. Regenerate pinned assets

- [x] 3.1 Regenerate `agentic-coding/src/workflow/embedded.generated.ts` from the changed instruction assets using `cd agentic-coding && bun run build` (never hand-edit the generated file); verify the build completes and the generated instruction contents match the four on-disk files.

- [x] 3.2 Run the focused asset and CLI/wiki regression checks with `cd agentic-coding && bun test test/workflow-assets.test.ts test/workflow-cli.test.ts test/workflow-wiki.test.ts test/workflow-wiki-scope.test.ts`; verify existing wiki root resolution, nested concept-path handling, role gates, and CLI operation behavior remain unchanged.

## 4. Migrate the existing draft concepts

- [x] 4.1 Against the resolved centralized wiki root, capture byte-preserving backups and inspect all eight legacy IDs plus their eight `projects/agentic-coding/<suffix>` destinations before mutation; verify the migration manifest records each source, destination, destination-collision state, `status`, `verified` presence, sources, and repository citations.

- [x] 4.2 Apply a guarded same-bundle move for each absent destination from `repository/<suffix>` to `projects/agentic-coding/<suffix>`; on a collision or unsafe reference, preserve the destination, create/update only the project-scoped active concept, and mark the legacy record `status: deprecated` rather than leaving two active concepts; verify no document is lost and no migrated concept gains a `verified` event.

- [x] 4.3 Read back every project-scoped result with `agentic-coding workflow wiki show <id> --json` and every retained legacy record, validating required frontmatter, all original `sources`, body repository citations, draft status, absent verification for moved concepts, deprecated status for retained legacy records, and one active concept per suffix; verify the migration manifest and archive evidence list all touched IDs and any fallback reason.

## 5. Final focused evidence

- [x] 5.1 Run `cd agentic-coding && bun run lint` and `openspec validate adjust-okf-wiki-structure --strict`; verify zero Biome diagnostics and strict OpenSpec validation, with evidence naming the modified spec, four instruction files, README, generated asset, focused test, and migrated concept IDs.

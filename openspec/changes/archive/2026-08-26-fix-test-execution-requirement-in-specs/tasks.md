## 1. Align planning instruction assets

- [x] 1.1 Update `agent-definitions/instructions/planning.md`, `planning-fusion.md`, and `fusion-consolidation.md` with explicit guidance to require focused, change-relevant worker validation, prohibit complete-suite worker tasks, and reserve the complete configured suite for the workflow-owned test-verifier; verify all three assets state the same ownership boundary
- [x] 1.2 Regenerate `agentic-coding/src/workflow/embedded.generated.ts` from the updated instruction assets using the existing generator; verify the generated bundle contains the updated planning guidance and its asset digests match the on-disk files

## 2. Add regression coverage

- [x] 2.1 Extend assignment and fusion prompt tests to render standard planning, fusion planning, and fusion consolidation assignments and verify each prompt requires focused validation, forbids a complete-suite worker requirement, and identifies test-verifier ownership
- [x] 2.2 Run the focused workflow prompt and asset tests (`bun test test/workflow-adapters.test.ts test/workflow-plan-fusion.test.ts test/workflow-assets.test.ts`) and verify they pass, including source-versus-embedded asset pin checks
- [x] 2.3 Run repository type-check and lint/format validation for the changed instruction and test surfaces (`bun run type-check` and `bun run lint`); verify both commands exit successfully without modifying unrelated files

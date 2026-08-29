## 1. Agent instruction assets

- [x] 1.1 Add `agent-definitions/instructions/wiki.md` with the dedicated wiki role's OKF v0.2 authoring workflow: inspect repository evidence, search/show existing concepts, select project or shared namespaces, preserve metadata, write meaningful draft content with sources and citations, report touched IDs/no-op results, and never self-verify or archive; verify the prompt explicitly covers both initial documentation and review-comment revision.
- [x] 1.2 Update `agent-definitions/instructions/planning.md`, `planning-fusion.md`, and `fusion-consolidation.md` to retain wiki reads while removing wiki writes, and reduce `agent-definitions/instructions/archive.md` to OpenSpec archival duties without documentation or wiki-review revision duties; verify the scope test distinguishes read-only planning guidance, the wiki authoring prompt, and wiki-free archive guidance.
- [x] 1.3 Regenerate `agentic-coding/src/workflow/embedded.generated.ts` through the existing build generator after instruction changes; verify embedded instruction content and digests match the on-disk assets without hand-editing the generated file.

## 2. Workflow graph and role routing

- [x] 2.1 Register `core.wiki` as a shell-capable agent step with the `wiki` role and generic JSON handoff, and update current archive-bearing built-in definitions so change approval routes through `core.wiki`, `core.wiki-approval`, `core.archive`, and `core.delivery` in order; preserve legacy no-gate definition variants and no-OpenSpec/proposal paths as specified, and verify registration tests assert reachability, bounded wiki/comment loops, and the approval `wiki.verify` effect before archive.
- [x] 2.2 Update definition-level and runtime role resolution to create exactly one `wiki` run for `core.wiki`, propagate bounded review comments into the next wiki step context, and keep archive entry validation attached only to `core.archive`; verify an integration test completes the wiki run, returns comments to wiki with context, then approves and reaches archive.
- [x] 2.3 Narrow managed `wiki write` authorization to the dedicated `wiki` role while retaining the unmanaged administrative path and preventing stable/verified self-promotion; expose `core.wiki` in the dashboard preset/model configuration step list so custom presets can route it, and verify dedicated-role success plus planner/archive/worker rejection and preset coverage behavior.

## 3. Existing review surface integration

- [x] 3.1 Reuse the existing `core.wiki-approval` dashboard review modal without adding a second UI: update its focused tests and any phase/fixture expectations needed for the new pre-archive location, and verify touched-concept listing, snapshot diff display, anchored comments, postpone, approve, and request-changes actions still dispatch correctly.
- [x] 3.2 Update `agentic-coding/test/workflow-wiki-scope.test.ts` to validate the new `wiki.md` OKF authoring guidance, planning read-only boundary, archive prompt boundary, namespace/source rules, and absence of wiki guidance from implementation/triage/verification assets; verify it passes against both disk assets and regenerated embedded assets.

## 4. Focused regression validation

- [x] 4.1 Update `workflow-wiki-gate.test.ts`, `workflow-registry.test.ts`, and the relevant routing/model-config tests for the new step, role, graph ordering, legacy behavior, and profile coverage; verify the selected tests pass.
- [x] 4.2 Extend wiki CLI tests to cover `HERDR_ROLE=wiki` draft writes, rejection and bundle immutability for planner/consolidator/archive and other managed roles, and rejection of attempted verification metadata; verify the existing OKF parsing, snapshot, and human-promotion behavior remains covered.
- [x] 4.3 Extend the focused workflow integration/e2e coverage to prove documentation occurs before archive, approval promotes touched concepts before archive, comments return to wiki rather than archive, and delivery remains reachable only after archive; verify with the selected workflow test files rather than the complete repository suite.
- [x] 4.4 Run the change-relevant checks from `agentic-coding/`—the wiki, scope, gate, registry, model-config, and workflow integration tests plus `bun run build`—and record the validated files, graph behavior, prompt pins, role isolation, and review evidence in the run-bound implementation evidence; do not add or require a repository-wide test command.

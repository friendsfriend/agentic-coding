## 1. Document business understanding in the stage role briefs

- [x] 1.1 Update `agent-definitions/instructions/stage-test-execute.md` concisely: read the matching process page first; keep testing with reviewed or authored blocks as the only goal; record evidence-backed business observations by kind; add a `new` observation per learned step when no page exists; keep UI/selector/timing issues in findings; avoid repeating confirmed facts; note relied-on trust tier and `stale_after`; and include supported block IDs with their steps.
- [x] 1.2 Update `agent-definitions/instructions/wiki-stage-test.md` to write the business process under `projects/<system>/processes/<process>` with purpose, actors, ordered steps, decisions/rules, inputs, outputs and open questions; associate supported block IDs with steps, exclude UI quirks, and preserve existing source, dispute and verification rules; re-read and merge on a stale digest conflict.
- [x] 1.3 Regenerate the embedded instruction asset with `cd agentic-coding && bun run scripts/generate-embedded.ts` and verify it reflects both brief changes.

## 2. Align wiki review gating and preserve approval effects

- [x] 2.1 Update the current stage-test review/gating behavior so `approve-and-update-wiki` is offered exactly when any knowledge observation exists, including confirmed-only observations; retain `approve`, its promoted-block count label, and the same claimed-block promotion behavior for both approval routes.
- [x] 2.2 Add focused workflow tests for empty, confirmed-only and other observation lists, action labels, routing to `core.wiki`, and block promotion on `approve-and-update-wiki`; preserve older pinned graph contracts and do not add a graph tier unless the existing registration pattern requires it.
- [x] 2.3 Keep the report contract and store unchanged (`STORE_SCHEMA_VERSION` remains 6); add no migration or compatibility shim.

## 3. Verify prompt content and focused behavior

- [x] 3.1 Add or update focused prompt and wiki tests for business observation guidance, process-page content, open questions, supported block-ID associations, UI-quirk exclusion, stale/trust guidance, untrusted-observation boundaries, safe report rendering, and the stage-wiki prompt's existing budget.
- [x] 3.2 Run the focused stage workflow, prompt, and wiki tests with a temporary `HOME` (including `test/stage-test-workflow.test.ts`, `test/workflow-prompt-sections.test.ts`, `test/workflow-prompt-budget.test.ts`, and `test/workflow-wiki.test.ts`, `test/wiki-observation-boundary.test.ts`, and `test/stage-report-markdown.test.ts`); do not add a repository-wide test command as a worker task.
- [x] 3.3 From `agentic-coding/`, run `bun run type-check`, `bun run lint`, `bun run build`, `bun run stage-blocks:check`, and `bun run stage-flows:check`; from the repository root, run `openspec validate --all --strict`. The workflow-owned `test-verifier` runs the complete configured repository test suite.

## 4. Guard concurrent writes and untrusted content

- [x] 4.1 Serialize wiki writes by normalized concept path, expose a digest in `wiki show`, and require stage-wiki writes to compare the digest (or `absent`) before replacing a process page; refuse stale writes for reread-and-merge.
- [x] 4.2 Bound and normalize observations before passing them to the tool-capable wiki role as untrusted evidence; escape all dynamic report Markdown values and make confirmed-only action labels say no wiki changes are expected while retaining promoted-block counts.
- [x] 4.3 Add focused regression tests for stale write refusal, observation-boundary sanitization, report Markdown escaping, and confirmed-only action labels.

## 5. Resolve follow-up verifier findings

- [x] 5.1 Require trust tier, `stale_after` value and stale reliance in existing report-observation wording; pin the rendered instruction without increasing prompt budgets.
- [x] 5.2 Align the process-body guard and role guidance on business sections rather than legacy test-mechanics headings; validate a business-section-only page through the authenticated write test.
- [x] 5.3 Scope process-index enumeration to the pinned system's process subtree and assert unrelated trees are not enumerated.
- [x] 5.4 Serialize verification with concept writes and compare the approval digest inside the lock; assert verification cannot replace a newer process revision.
- [x] 5.5 Add a coordinated two-process stale-base write test and independently hostile observation statement/observed Markdown cases.

## 6. Close snapshot-token and abandoned-lock races

- [x] 6.1 Return `wiki show` content and `contentDigest` from one byte snapshot; deterministically replace the file immediately after that read and prove the response retains the matching old digest and cannot overwrite the newer page.
- [x] 6.2 Follow the developer-selected fail-closed policy: remove automatic stale-lock reaping, retain bounded acquisition timeout, document operator cleanup only after confirming no active writer, and test that waiting writes and verification preserve the abandoned lock generation and concept bytes.
- [x] 6.3 Retain current server-side namespace/source restrictions, draft-only writes and final developer review; explicitly document the developer-selected residual prompt-injection risk rather than claiming prompt labels enforce evidence fidelity.
- [x] 6.4 Re-run focused wiki tests with temporary HOME, type-check, lint, build, stage-blocks/flows checks and strict OpenSpec validation; leave the full suite to test-verifier.

## Context

See `proposal.md` for the motivation. The current built-in archive workflows route developer approval directly to `core.archive`, then present `core.wiki-approval` before delivery. The existing wiki modal already reads the change snapshot, displays concept diffs, persists anchored comments, and dispatches `approve-wiki` or `review-comments`; the workflow engine already owns the `wiki.verify` effect. The missing pieces are a managed documentation step, role routing, and moving the existing gate to the correct position.

The wiki CLI currently snapshots concepts on write and applies role checks in `src/workflow/cli.ts`. Workflow assignments are pinned from `agent-definitions/instructions`, and the compiled executable consumes `embedded.generated.ts`, so instruction changes must be regenerated rather than hand-edited.

## Goals / Non-Goals

**Goals:**

- Add one sequential `wiki` agent step to archive-bearing built-in workflows.
- Make the wiki agent the sole managed workflow author of draft concepts, with a prompt that produces useful OKF v0.2 content and handles review revisions.
- Route the existing review modal before archive, retain bounded comments, and let approval enqueue engine-owned human verification before archive.
- Keep workflow routing and preset configuration able to select a profile for the new step.
- Preserve the existing centralized bundle, snapshot mechanism, CLI operations, review UI, and no-OpenSpec/proposal behavior unless the specifications require otherwise.

**Non-Goals:**

- No new wiki storage format, project flag, frontmatter field, or review component.
- No wiki access in implementation, triage, verifier, or archive prompts.
- No wiki authoring by parallel planners or plan consolidators.
- No changes to delivery, workspace cleanup, or the complete repository test ownership.

## Decisions

### 1. Use `core.wiki` with the `wiki` role

Register a new agent step named `core.wiki`, backed by `wiki.md`, with the existing generic JSON output envelope. Map it to one `wiki` role in both definition-level and runtime role resolution. Give it the shell capability needed to invoke the existing wiki CLI; writes continue through `wiki write`, so path safety, provenance, snapshots, and OKF validation remain centralized.

A new output contract is unnecessary: the review UI derives the authoritative touched-concept list from the wiki snapshot, while the prompt requires the generic run evidence to report concept IDs or an explicit no-knowledge result. This keeps the change compatible with existing assignment and handoff machinery.

### 2. Put documentation and review before archive

For current archive-bearing definitions, change the path after developer change approval to `core.wiki -> core.wiki-approval -> core.archive -> core.delivery`. The wiki step's complete outcome opens the existing developer gate. Approval enqueues the existing `wiki.verify` effect and proceeds to archive; comments return to `core.wiki` with a bounded loop. The legacy definition variants that intentionally omit the existing wiki gate remain available for pinned historical workflows, while the current policy definitions gain both new steps.

The runtime's review-context propagation will recognize a comments transition into `core.wiki`, just as it currently recognizes review-fix destinations. No new comment persistence format is needed: the dashboard's existing `wiki-review.json` and bounded engine command payload remain the source of review context.

### 3. Put all authoring guidance in `wiki.md`

The new prompt will require the agent to search and read existing concepts before writing, distinguish `projects/<project-id>/` from `shared/`, qualify repository-relative sources with project context, preserve unknown frontmatter, update exact existing concepts, and write draft concepts with meaningful body claims and source resources. It will explicitly forbid stable or verified metadata, archival commands, and human-actor impersonation. On a comments retry it will read the step context, apply each anchored comment, state invalid/already-satisfied comments explicitly, and report resolved concept IDs.

Planning prompts retain wiki reads but lose write permission/guidance. The archive prompt is reduced to OpenSpec archive behavior and no longer performs documentation, verification, migration, or wiki logging. The CLI's managed write gate is narrowed to `wiki` (plus the existing unmanaged interactive path); `wiki.verify` remains an administrative/engine surface, while managed human promotion remains the approval effect.

### 4. Reuse the existing dashboard gate and expose only profile configuration

`core.wiki-approval` already has direct-open behavior in `App.tsx`, diff loading, line comments, and approve/comments dispatch. Moving the step ID in the graph requires no new modal. Add `core.wiki` to the preset step editor so configured profiles can cover the new route; the dashboard's runtime agent list already renders arbitrary run roles. Update existing gate and scope tests to verify the new ordering, role, prompt boundary, and comment path rather than duplicating UI code.

### 5. Treat embedded instructions as generated output

After adding or editing instruction assets, run the existing build generator so `src/workflow/embedded.generated.ts` contains matching content and digests. The generated file is not hand-edited. Focused tests will compare the new asset's embedded copy and exercise workflow registration/routing, CLI role isolation, review transitions, and comment context.

## Risks / Trade-offs

- [Risk] Existing workflows pinned to the pre-documentation graph may fail to match the current definition digest → retain legacy no-gate registrations and test current policy definitions separately; do not rewrite historical state.
- [Risk] A wiki write can fail before archive while the shared bundle is external to the repository → keep the existing snapshot and bounded handoff behavior, report the exact failure in the wiki run evidence, and do not claim verification.
- [Risk] The new prompt may produce shallow or duplicate concepts → require search/show before writes, project-scoped IDs, source-backed body claims, and focused prompt/scope assertions.
- [Risk] Review comments could be lost when returning to a newly launched wiki run → store the bounded command payload in step context for `core.wiki`, preserve the dashboard's review file, and test anchored comments on the return transition.
- [Risk] Adding a required agent step can make incomplete custom presets fail preflight → include `core.wiki` in preset editing and coverage tests so missing profile configuration is reported before launch.

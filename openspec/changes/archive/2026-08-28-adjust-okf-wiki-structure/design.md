## Context

See `proposal.md` for the motivation and scope. The existing `knowledge-wiki` contract already resolves one centralized bundle from `HERDR_WIKI_DIR`, `[wiki] root`, or `~/.config/agentic-coding/wiki`; `wiki.ts` accepts nested bundle-relative paths, preserves unknown frontmatter on upsert, and replaces an existing concept in place. The CLI already supports `list`, `search`, `show`, `write`, `verify`, and `log` without a project argument.

The live resolved bundle contains the eight requested `repository/*` concepts. CLI reads show that they all have OKF frontmatter, repository-relative `sources`, `status: draft`, no `verified` field, and bodies that already describe Agentic Coding scope, but their IDs remain ambiguous. No application behavior is needed to represent the desired scope: the existing path, source, tag, and Markdown surfaces are sufficient.

## Goals / Non-Goals

**Goals:**

- Make the centralized bundle's scope explicit without changing root resolution or CLI operations.
- Make all four relevant pinned instructions teach the same project/shared namespace and source-context rules.
- Make README guidance match the instructions.
- Migrate the eight current Agentic Coding drafts without promoting or duplicating them.
- Keep the implementation plan limited to requirements, documentation, instruction assets, pins, and a one-time data migration/validation.

**Non-Goals:**

- No `project` frontmatter field, `--project` CLI flag, automatic root federation, namespace enforcement in `wiki.ts`, or workflow/runtime/adapter change.
- No changes to the existing CLI help text: it does not currently claim that a bundle belongs to one repository.
- No verification events, status promotion, or rewriting of the current drafts' factual content beyond scope labeling needed for migration.
- No edits to archived OpenSpec changes or the unrelated `repository-knowledge-seed` archived capability.

## Decisions

### Use path namespaces as the scope marker

Use `projects/<project-id>/<concept>` for facts owned by one project and `shared/<concept>` only for claims supported by every project they cover. `agentic-coding` is the project ID for the current eight concepts. This is the smallest compatible choice because `conceptPath`, list/search/show, snapshots, and atomic upserts already treat nested IDs as ordinary relative paths.

A producer's source resource remains the evidence pointer. Instructions must state that `agentic-coding/src/...` or another repository-relative path is meaningful only with the project named by the concept, not a universal filesystem or workflow rule. Shared concepts must name their covered projects and include evidence from each; a single repository's evidence stays project-scoped.

**Rejected:** a new frontmatter `project` field or CLI flag. The requested semantics are already expressible in IDs and Markdown, and adding either would change the producer schema/CLI without improving current reads or writes.

**Rejected:** one wiki bundle per repository or automatic multi-root federation. The existing resolver intentionally gives all repositories the same bundle by default, and the requirement explicitly calls for retaining that model.

### Modify only the necessary requirements

The delta modifies the existing centralized-bundle, planning-role, and archive-role requirements in full, preserving their unchanged scenarios, and adds focused namespace and legacy-migration requirements. It does not alter the existing OKF format, trust, snapshot, CLI, or workflow-gate requirements. This keeps the contract precise while making namespace selection and migration observable.

### Repeat guidance in the four pinned instruction assets

Add a short, consistent scope paragraph to `planning.md`, `planning-fusion.md`, `fusion-consolidation.md`, and `archive.md`:

- identify the current project before using repository-relative paths;
- use `projects/<project-id>/...` for project facts;
- use `shared/...` only for cross-project facts with evidence from all covered projects;
- search/read before writing, update an existing concept in place, and do not create active near-duplicates;
- preserve draft/unverified status during planning and migration.

Each file must retain its current role boundary: fusion planners remain read-only, sequential planners/consolidators may only draft, and archive verifies only after successful archive. The scope paragraph must be placed where the existing wiki exception already overrides the surrounding exploration restriction.

### Keep README as the user-facing convention

Extend the existing Knowledge wiki section with the two namespaces, source-context rule, shared-evidence rule, and migration/update-in-place rule. Keep the existing centralized root and operation list unchanged. No CLI help change is needed because its current text describes operations and role permissions, not repository ownership.

### Migrate by guarded move, with deprecated fallback

Perform the one-time migration against the resolved bundle after inspecting all eight source and destination IDs:

1. For each `repository/<suffix>`, choose `projects/agentic-coding/<suffix>`.
2. If the destination is absent, move the Markdown file within the same bundle, preserving bytes and therefore frontmatter, sources, body citations, `status: draft`, and absence of `verified`.
3. If the destination already exists, do not overwrite it blindly. Compare/read both documents; update the intended project-scoped concept in place only after preserving the destination's unrelated frontmatter, then mark the legacy source `status: deprecated` if it must remain for compatibility. Never leave two active copies.
4. If a safe move is blocked by an existing reference or filesystem problem, retain the legacy document as an explicit deprecated record and create/update the project-scoped replacement with the original draft provenance. Record the reason in archive evidence.
5. Read every resulting project-scoped concept through `wiki show` and inspect the legacy path when retained. Do not invoke `wiki verify` and do not add `verified` entries.

This is a data migration, not a new runtime migration framework. The current CLI has no move operation, so a guarded same-root filesystem rename is appropriate for preserving exact documents; the archive instruction documents the fallback policy for future legacy cases.

### Regenerate instruction pins

After editing the four instruction files, run the repository's existing build/pin generation path so `agentic-coding/src/workflow/embedded.generated.ts` reflects their hashes. Do not hand-edit the generated file. Validate the changed instruction digests against their source files and ensure no wiki text is added to worker, triage, or verifier-only assets.

## Risks / Trade-offs

- **Legacy consumers may link to old IDs** → Prefer a guarded move only when no supported reference would break; otherwise retain a `status: deprecated` legacy record and make the project-scoped record the sole active source. The archive evidence must name the retained legacy IDs and reason.
- **Destination concepts may already exist** → Inspect before moving, preserve unrelated destination frontmatter, update in place, and validate there is no pair of active documents.
- **Repository-relative sources can still be misunderstood by external OKF readers** → Put project context in the concept body and source descriptions where available; instructions explicitly prohibit universal interpretation. This remains a convention because OKF does not supply a required project field.
- **Shared concepts could overclaim** → Require explicit covered-project evidence and reject single-project claims from the `shared/` namespace in focused review.
- **Instruction pin drift breaks launches** → Regenerate `embedded.generated.ts` through the existing build command and run the focused asset/hash check.
- **Migration can alter user data if run carelessly** → Use a temporary backup or byte-for-byte preimage capture, fail closed on unexpected destination collisions, and read back all eight results. Rollback is the inverse guarded rename for moved files; for deprecated fallbacks, restore the captured legacy and destination documents from the pre-migration copies.
- **The current external bundle is runtime state, not repository source** → The repository plan can specify and validate the migration procedure, but it cannot assume another project's legacy references are discoverable from this repository. Any unresolved reference concern remains an explicit migration decision for the archive/operator.

## Migration Plan

1. Before changes, resolve the same wiki root with `agentic-coding workflow wiki list` and `show`; capture the eight legacy documents and record which destination IDs already exist.
2. Apply the guarded mapping to `projects/agentic-coding/<suffix>` as described above, preserving all document content and draft/unverified lifecycle state.
3. Validate each destination's required frontmatter, sources, body repository citations, `status: draft`, and missing `verified`; validate retained legacy records are `status: deprecated` and that no legacy/destination pair is simultaneously active.
4. If the migration must be rolled back, restore moved files to their original paths only when the destination still matches the captured migrated bytes; restore collision/fallback records from their pre-migration copies. Do not run verification during rollback.
5. Land the requirements, instruction, README, generated-pin, and focused-test changes independently of the external data move; archive evidence records the exact migrated and retained IDs.

## Open Questions

- Whether an external consumer currently depends on any `repository/*` ID cannot be established from this repository or the wiki CLI output. The plan therefore uses a guarded move where safe and the specified deprecated fallback otherwise; this does not change the namespace convention.
- Whether future projects should use a canonical identifier registry is deferred. It is not needed to express or validate the current `projects/agentic-coding` and `shared` convention.

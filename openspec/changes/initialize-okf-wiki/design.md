## Context

See `proposal.md` for motivation. The repository already provides a centralized OKF v0.2 bundle and CLI in `agentic-coding/src/workflow/wiki.ts` and `agentic-coding/src/workflow/cli.ts`; this change only seeds durable content through that existing surface. The wiki root resolves as `HERDR_WIKI_DIR`, then `[wiki] root`, then `~/.config/agentic-coding/wiki`. Wiki reads are unrestricted, while writes are role-gated: planners and consolidators may write drafts, archive may write and verify, and workers/verifiers may not write.

The current workflow facts to capture are distributed across `README.md`, `AGENTS.md`, `agentic-coding/package.json`, `agentic-coding/tsconfig.json`, `agentic-coding/biome.json`, `agentic-coding/src/cli.ts`, `agentic-coding/src/workflow/{contracts,definitions,runtime,effects,paths,profiles,adapters,effect-runner,observability,wiki,cli}.ts`, `agentic-coding/src/tui/dash/{App,data}.tsx`, `agent-definitions/instructions/{workflow-agent-protocol,planning,implementation,triage,verification,archive}.md`, `agent-definitions/bridges/{pi-telemetry,opencode-telemetry,opencode-v2-telemetry}.*`, `scripts/{install,stow,test-herdr-workflow,test-workflow}.sh`, and `pi/herdr-workflow.toml`.

## Goals / Non-Goals

**Goals:**

- Seed eight concise concepts, updating an existing concept at the exact ID if the preflight wiki search finds one: `repository/architecture`, `repository/workflow-lifecycle`, `repository/agent-roles`, `repository/testing-and-validation`, `repository/configuration`, `repository/dashboard`, `repository/runtime-adapters`, and `repository/telemetry`.
- Record concrete, current constraints with repository-relative citations in each Markdown body and at least one `sources` item whose `resource` identifies the consulted repository paths.
- Write every seeded concept with `status: draft`, required `type`/`title`/`description`, useful domain tags, and no `verified` field. Preserve unrelated existing frontmatter when updating.
- Make uncertainty explicit in the body for facts that are inferred or likely to vary by installed Herdr/runtime/version; do not turn such claims into asserted guarantees.
- Read back every concept using `wiki show`, check frontmatter/provenance/status and claim-to-source alignment, and finish with strict OpenSpec validation.

**Non-Goals:**

- No application source, test, workflow definition, configuration template, existing OpenSpec requirement, Git history, or existing wiki behavior changes. The new `repository-knowledge-seed` spec only describes this documentation output.
- No `wiki verify`, human review event, `stable` promotion, or speculative design guidance.
- No secrets, credentials, personal identity, transient workflow/run identifiers, generated digests, or whole-repository test-suite execution.

## Decisions

### 1. Use the existing wiki CLI and IDs rather than adding a new storage path

The archive/implementation work must call `agentic-coding workflow wiki search` before choosing targets, then use `wiki write --path ...` (or the existing equivalent) for each concept described by the `repository-knowledge-seed` spec. This preserves bundle resolution, atomic writes, provenance injection, and role enforcement already implemented in `wiki.ts`. A missing concept is created; a matching concept is updated in place. Do not create aliases or near-duplicate IDs.

**Alternative rejected:** writing files directly under `~/.config/agentic-coding/wiki` would bypass path safety, frontmatter validation, change snapshots, and the CLI's role policy.

### 2. Keep the seed set small and separate by planning concern

Use one concept per durable planning concern. `repository/architecture` explains the CLI/engine/dashboard relationship; `repository/workflow-lifecycle` covers pinned definitions, transitions, effects, recovery, and approval boundaries; `repository/agent-roles` covers actors, role assignments, permissions, and handoff constraints; `repository/testing-and-validation` covers Bun/Biome/OpenSpec/smoke commands and ownership boundaries; `repository/configuration` covers config locations, precedence, templates, and profile/preset routing; `repository/dashboard` covers the TUI's observation/action boundary; `repository/runtime-adapters` covers Herdr lifecycle, Pi/OpenCode launch, environment injection, and preflight; `repository/telemetry` covers normalized events, W3C trace context, local/OTLP best-effort behavior, bridges, redaction, and content capture.

Each body should cite only the most relevant paths for that concept, using inline repository-relative paths such as `README.md` and `agentic-coding/src/workflow/runtime.ts`, while the frontmatter `sources` list carries the same repository paths as `resource` values. The concepts should link to one another only when a relationship materially helps planning.

**Alternative rejected:** one large repository handbook would be harder to search, update, and review, while more than eight concepts would add maintenance overhead without durable value.

### 3. Treat provenance and lifecycle as first-class review data

Use `type: repository-knowledge`, domain tags, a clear description, and `status: draft` on every seed. Do not pass `--verified` or call `wiki verify`; the existing CLI allows the planner/consolidator/archive writer to create drafts, but the workflow's human wiki-approval effect is the promotion boundary. Readback must confirm each concept has a non-empty `generated` mapping, source resources, and no verification event.

### 4. Validate claims by focused readback, not by mutating the application

After writes, run `wiki show` for all eight IDs and inspect the returned frontmatter/body. Confirm each source resource names a repository-relative evidence path, each status is `draft`, required fields exist, and uncertain/version-sensitive statements are labeled. Run `openspec validate "$HERDR_CHANGE_ID" --strict` for the planning artifacts. If an existing concept is updated, compare its retained unrelated frontmatter and ensure the body still reflects current source evidence.

**Alternative rejected:** a repository-wide test/build run would not exercise the documentation output and is owned by the workflow's test-verifier; it would add cost without focused evidence. The focused checks are wiki readback plus strict OpenSpec validation of the seed contract.

## Risks / Trade-offs

- [Risk] The centralized wiki may contain a related concept not found by an incomplete search or may change while the seed is being prepared → search broad terms first, inspect every hit with `wiki show`, and update exact matches rather than creating aliases.
- [Risk] Source facts can become stale as runtimes, Herdr, or configuration evolve → label inferred/version-sensitive claims, keep `stale_after` unset unless a defensible date is known, and leave all concepts as drafts for later human/archive promotion.
- [Risk] A CLI write accepts one `--source` value per invocation → use a resource string that identifies the relevant repository path(s), or use the existing API's `sources` list without bypassing validation; do not omit provenance.
- [Risk] Updating a pre-existing concept could erase producer-specific metadata → rely on the wiki writer's read/merge behavior and inspect the complete `wiki show` result after every update.
- [Risk] Shared wiki writes are external to the repository checkout and are not represented by Git delivery → report exact concept IDs and readback evidence in the run artifact; do not claim repository files were changed or concepts were verified.

## Migration Plan

1. Search the resolved shared bundle for architecture/workflow/configuration/runtime/dashboard/testing/telemetry concepts.
2. Read all related hits, select exact IDs to update, and map each concept to current repository source paths.
3. Write or update the eight draft concepts through the CLI, retaining useful existing metadata and avoiding verification.
4. Show every selected concept, inspect conformance/provenance/status and claims, then run strict OpenSpec validation.
5. Rollback, if needed, is limited to restoring the pre-write concept contents from the wiki's per-change snapshot; do not delete or alter unrelated concepts. A later archive/human approval process may promote or deprecate concepts.

## Open Questions

- The exact pre-existing concept set is unknown until the implementation run performs the required live search; this affects whether each target is created or updated, not the intended IDs or content boundaries.
- The installed runtime version and Herdr behavior may differ from the repository's documented assumptions; any such claim must remain explicitly marked as version-sensitive in the concept body.

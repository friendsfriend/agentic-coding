## 1. Preflight and evidence mapping

- [x] 1.1 Search the resolved shared wiki for `repository`, architecture, workflow, configuration, dashboard, runtime, testing, and telemetry terms, then `wiki show` every related hit; verify the search/readback results are recorded and exact existing IDs are selected for update instead of creating near-duplicates.
- [x] 1.2 Re-read the repository evidence listed in `design.md` and map each selected concept to concrete repository-relative source paths; verify every planned claim has a cited source and every inferred or version-sensitive claim is explicitly labeled.

## 2. Draft concept content

- [x] 2.1 Prepare concise `repository/architecture`, `repository/workflow-lifecycle`, and `repository/agent-roles` documents covering the CLI/engine/dashboard relationship, pinned workflow transitions/effects/recovery/approval boundaries, actor roles, permissions, and handoff constraints; verify each draft has concrete behavior, required producer fields, domain tags, `status: draft`, and no `verified` field.
- [x] 2.2 Prepare concise `repository/testing-and-validation` and `repository/configuration` documents covering supported Bun/Biome/OpenSpec/smoke commands, validation ownership, configuration locations and precedence, shipped defaults, and profile/preset routing; verify each claim cites the corresponding scripts/configuration/source path and uncertain details are labeled.
- [x] 2.3 Prepare concise `repository/dashboard`, `repository/runtime-adapters`, and `repository/telemetry` documents covering dashboard observation/action boundaries, Herdr-managed launch lifecycle and runtime preflight, and normalized telemetry/trace/redaction/best-effort boundaries; verify each claim cites the corresponding dashboard, adapter, effect-runner, observability, bridge, or configuration path.

## 3. Write and review the shared bundle

- [x] 3.1 At the permitted sequential writer stage, write or update the eight selected concepts through `agentic-coding workflow wiki write`, using the exact concept IDs, `type: repository-knowledge`, useful tags, one or more `sources` resources naming consulted repository-relative paths, and `status: draft`; verify the command succeeds, updates existing IDs in place, preserves unrelated frontmatter, and does not add verification events.
- [x] 3.2 Run `agentic-coding workflow wiki show` for every created or updated concept and inspect the complete returned document; verify YAML/frontmatter is conformant, `type`/`title`/`description`/`generated` exist, sources have non-empty `resource` values, status is `draft`, claims match the cited files, and no secrets, personal data, transient run state, generated digests, or speculation appear.
- [x] 3.3 Run `openspec validate "$HERDR_CHANGE_ID" --strict`; verify the `repository-knowledge-seed` contract and documentation-only change validate, and that the final evidence names all eight concept IDs, repository evidence files, unresolved uncertainty, and any concepts that may later need deprecation or revision.

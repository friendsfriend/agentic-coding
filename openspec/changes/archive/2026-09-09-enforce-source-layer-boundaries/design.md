## Context

The existing graph helper uses the installed TypeScript AST and scans workflow .ts modules. It ignores .tsx, literal dynamic imports, and require calls, and its guards check cycles/parent barrels rather than semantic layer ownership. A cycle-free graph can still have the wrong dependency direction.

## Goals / Non-Goals

**Goals:** cheap runnable architecture checks, actionable diagnostics, and coverage of actual Bun/TypeScript source import forms.

**Non-goals:** sandboxing, whole-program purity analysis, resolving arbitrary computed imports, a new linter, or imposing package boundaries.

## Decisions

### Extend the existing helper

Scan .ts and .tsx under src with correct TypeScript ScriptKind. Resolve relative explicit extensions, extensionless files, and index.ts/index.tsx using existing project conventions. Collect static imports/re-exports, literal import() calls, and literal require() calls. Flag unresolved relative runtime targets; distinguish external/builtin modules rather than dropping them.

Maintain two views: value/runtime edges for cycles, and all dependency edges for architecture ownership, including type-only edges when a rule forbids coupling. Type-only imports must not create false runtime cycles. Restrict computed module loading in guarded pure modules rather than claiming the graph can resolve it.

### Small explicit policy

- Workflow/backend code cannot import CLI or TUI presentation modules; CLI composition and application modules have their own declared edges.
- TUI can consume application operations and typed engine views, not workflow CLI command modules/barrels.
- Pure definitions, contracts, and step behavior cannot depend directly or transitively on persistence, effects, filesystem/process/network I/O, or presentation. Runtime SQL reducers are not classified as pure domain hooks.
- Runtime/definition/CLI submodules cannot import their own parent barrels; retain existing cycle checks.
- Shared TUI primitives cannot import dashboard/observability feature implementations.

Document allowed foundational pure utilities and required type contracts rather than allowing a broad whole-directory exception. Add targeted AST diagnostics for obvious direct I/O/clock globals in pure modules, such as Bun.spawn*, fetch, process I/O, and Date.now/new Date; passing a timestamp as data remains valid. Describe this as a guardrail, not proof against aliases or arbitrary JavaScript behavior.

### Exceptions are narrow and tested

Known violations are removed by prerequisite changes. If a remaining legitimate exception is discovered, record the exact edge, rationale, and removal condition in a reviewed allowlist; fail on unused entries so exceptions do not become permanent wildcard bypasses. Do not weaken rules automatically to obtain a green baseline.

## Risks / Trade-offs

- Type edges differ from runtime edges → separate graphs and fixtures for both.
- Transitive purity checks can overreach → classify domain and runtime modules explicitly and report the dependency path.
- Computed imports escape static resolution → reject them in guarded pure modules and document limits elsewhere.

## Migration Plan

Land shared application/evidence/completion boundaries first. Extend parsing with isolated positive/negative fixtures, inventory current edges, then enable rules in normal Bun tests. Preserve existing export-surface checks. Update architecture docs with the enforced map; do not change production imports solely to satisfy an undocumented aesthetic preference.

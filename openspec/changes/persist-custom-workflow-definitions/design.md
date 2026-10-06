# Design

## Context

`WorkflowRegistry.registerWorkflow` already performs full structural validation
(reachability, terminal paths, bounded loops, outcome coverage, undeclared
cycles, step-ref compatibility) but also inserts into its map and throws on a
duplicate key. Stores are per target, versioned via `PRAGMA user_version`
(currently 4), and `initializeStore()` is the only schema writer.

## Goals / Non-Goals

**Goals:**

- A custom workflow survives restarts and resolves exactly what it was started
  with, or fails closed with a diagnostic.
- No change for built-in definitions and their pins.

**Non-Goals:**

- Authoring custom definitions from requirements (blueprint compiler change).
- Garbage collection of unreferenced definitions (retained forever for now).
- Custom wiki/research/wiki-comments definitions.

## Decisions

- **Per-target storage.** A definition is stored in the same store as the
  workflows that pin it, so backup, delete and target addressing need no new
  rules. The same manifest started in two targets is stored twice.
- **Content addressing.** `id = "custom." + digest[0..12]`, `version = 1`,
  `label` carries the human name. Identical manifests share an identity; an id
  collision with a different digest fails closed.
- **Validate without registering.** Split `registerWorkflow` into a pure
  `compileWorkflow(manifest)` (all checks, returns the compiled definition) and
  the registering wrapper. The resolver compiles stored manifests through it and
  caches by digest.
- **Newest-tier invariants are enforced at store time**, not trusted from the
  author: exact `stepRefs`, policy + traits, routing coverage (the same rule
  `withPerStepRouting` establishes), gate placement. Human-review rules are *not*
  enforced here; they belong to the blueprint path, which is the only one the
  orchestrator can use.
- **Origin recorded.** `origin_json` stores who stored it (`operator` CLI or a
  later `blueprint`) for the dashboard and audits.
- **Reads stay observational.** A status/list of a v4 store reports
  migration-required as today; only mutating entry points migrate to v5.

Schema:

```sql
CREATE TABLE IF NOT EXISTS workflow_definitions(
  digest TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL CHECK(version = 1),
  manifest_json TEXT NOT NULL,
  origin_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## Risks / Trade-offs

- [Older binaries cannot open a v5 store] → Existing rule: unsupported newer
  versions fail closed; documented in the upgrade notes.
- [A removed step version strands custom workflows] → Same contract as built-in
  pins: retain step versions while any snapshot references them; the diagnostic
  names the missing step.

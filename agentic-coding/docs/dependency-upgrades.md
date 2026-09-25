# Dependency upgrades

This note records the "upgrade every dependency to its latest version" pass and
the code migrations it required. It is the human-readable companion to the
per-run upgrade evidence; update it whenever the direct dependency set moves.

## Direct dependency changelog

Resolved versions before → after, with the declaring workspace. "No migration"
means the upgrade was source-compatible.

### Root `agentic-coding`

| Package | Before | After | Kind | Migration |
| --- | --- | --- | --- | --- |
| `@grpc/grpc-js` | 1.14.4 | 1.14.5 | patch | None |
| `@grpc/proto-loader` | 0.8.1 | 0.8.1 (latest) | — | None |
| `@opentui/core` | 0.4.2 | 0.5.12 | minor (0.x) | None; see "OpenTUI 0.5" below |
| `@opentui/keymap` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `@opentui/solid` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `effect` | 3.22.2 | 3.22.2 (latest) | — | None; stays locked per `docs/workflow-effect.md` |
| `marked` | 17.0.1 | 18.0.14 | major | None; see "marked 18" below |
| `solid-js` | 1.9.15 resolved (range `^1.9.12`) | 1.9.15 (range `^1.9.15`) | range floor | None |

### Root devDependencies

| Package | Before | After | Kind | Migration |
| --- | --- | --- | --- | --- |
| `@babel/parser` | — (transitive) | 7.29.9 | new direct dev dep | Introduced for the TypeScript 7 migration |
| `@babel/types` | — (transitive) | 7.29.8 | new direct dev dep | AST types for the two guard scripts |
| `@biomejs/biome` | 2.5.10 | 2.5.14 | patch | `biome.json` `$schema` bumped; import ordering changed |
| `@types/bun` | 1.4.0 | 1.4.2 | minor | None (types only) |
| `typescript` | 6.0.3 | 7.0.2 | major | Removed compiler API; see "TypeScript 7" below |

### `packages/devenv/cli`

| Package | Before | After | Kind | Migration |
| --- | --- | --- | --- | --- |
| `@opentui/core` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `@opentui/solid` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `commander` | 14.0.3 | 15.0.0 | major | None; the package is declared but never imported |
| `solid-js` | 1.9.15 resolved (range `^1.9.12`) | 1.9.15 (range `^1.9.15`) | range floor | None |
| `@types/node` | 25.9.6 | 26.6.2 | major | None (types only) |

### `packages/ui`

| Package | Before | After | Kind | Migration |
| --- | --- | --- | --- | --- |
| `@opentui/core` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `@opentui/keymap` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `@opentui/solid` | 0.4.2 | 0.5.12 | minor (0.x) | None |
| `solid-js` | 1.9.15 resolved (range `^1.9.12`) | 1.9.15 (range `^1.9.15`) | range floor | None |

### Not changed

- **`effect` 3.22.2** is already the latest release and is intentionally
  locked (`docs/workflow-effect.md`, `docs/workflow-effect-migration.md`).
- **`@grpc/proto-loader` 0.8.1** is already the latest release.
- **`packageManager: bun@1.4.0`** is a runtime pin, not an npm dependency, and
  is left alone.
- Workspace links (`@ui`, `@devenv/*`) track local sources.

## Migrations applied

### TypeScript 7: replace the removed compiler API

`typescript@7.0.2` is the native compiler: its package `exports` map points the
bare `typescript` specifier at `lib/version.cjs`, and the synchronous compiler
API the structural guards relied on (`ts.createSourceFile`, `ts.SyntaxKind`,
`ts.is*`, `ts.forEachChild`) no longer exists. TS 7 only exposes
`typescript/unstable/ast` (no parser entry point) and `typescript/unstable/sync`
(an LSP-backed client), neither of which fits synchronous per-file syntactic
checks.

Changes:

- **New `scripts/source-ast.ts`** — parses a module with `@babel/parser`
  (`typescript` plugin; `jsx` enabled only for `.tsx`, mirroring the old
  `ScriptKind` choice), and owns the shared helpers: `parseSource` /
  `parseSourceFile`, `positionOf` (1-based line/column), `textOf`,
  `collectBindingNames`, `exportedName`, `importBindsValue`, `exportBindsValue`.
- **`scripts/workflow-module-graph.ts`** — `listExportedNames` and
  `analyzeModule` now read the Babel syntax tree; the recursive dynamic
  `import()` / `require()` scan uses `@babel/types`' `traverseFast`.
- **`scripts/workflow-architecture.ts`** — `pureGlobalViolations`,
  `runtimeExecutionCalls`, and `checkObsoleteShims` walk the same tree with
  `traverseFast` and Babel node guards.

The guard semantics are unchanged for the covered forms: `import type` /
`export type` stay type-only, `export *` re-exports values, JSX is only
enabled for `.tsx`, and the exported-name baseline is byte-identical
(`test/workflow-module-exports.test.ts`). Two Babel-shape differences are
explicitly handled so the migration is not narrower than the old TypeScript
`CallExpression`/modifier scan:

- **Optional-chained calls** — Babel parses `Effect?.runSync(p)`,
  `Date?.now()`, `process?.cwd()`, `fetch?.()`, and `require?.('./x')` as
  `OptionalCallExpression` / `OptionalMemberExpression`, not
  `CallExpression` / `MemberExpression`. `pureGlobalViolations`,
  `runtimeExecutionCalls`, and `analyzeModule` match both node kinds.
- **Default-exported declarations** — `export default function drain() {}` is
  an `ExportDefaultDeclaration`, not an `ExportNamedDeclaration`, so
  `checkObsoleteShims` inspects both before matching declaration names.

The `listExportedNames` convention for `export default function foo() {}` /
`export default class Foo {}` is the one intentional surface change: it now
records `default` rather than the local binding name (`foo` / `Foo`),
matching `export default <expression>`. No current barrel has a default
export, so the committed oracle is unaffected.

### Biome 2.5.14: import ordering and schema

- `biome.json` `$schema` bumped from `2.5.10` to `2.5.14`.
- Biome 2.5.14's `assist/source/organizeImports` orders parent-relative
  (`../../`) imports before sibling (`./`) imports. `src/server/actions/routes.ts`
  was re-sorted by `biome check --write`. No behavioural change.

### OpenTUI 0.4.2 → 0.5.12: no source migration

The 0.5.x line kept the renderer, keymap, and Solid binding surfaces used by
the dashboard, observability views, settings, and the `devenv` TUI. Type-check,
build, and the focused TUI suites pass without changes. `build.ts` still
resolves `@opentui/solid/scripts/solid-plugin.js`; its optional
`solid-transform.js` ESM/CJS interop patch is skipped when the file is absent.

### marked 18: no source migration

The only consumer is `packages/ui/src/components/markdownBlocks.ts`, which uses
`Lexer.lex(content, { gfm: true })` and `token.raw`/`token.type`. Both are still
present in marked 18; markdown-rendering tests pass unchanged.

### commander 15 and `@types/node` 26: no source migration

`commander` is declared in `packages/devenv/cli` but never imported, and the
`@types/node` bump only affects types in the same workspace. `bun run type-check`
covers both.

## Unrelated fixes carried with this pass

- **Deterministic embedded assets.** `scripts/generate-embedded.ts` now sorts
  its entries before hashing and emitting, so `src/workflow/embedded.generated.ts`
  no longer churns its `AGENT_DEFINITIONS` key order per host filesystem
  (`readdirSync` order). The regenerated file is otherwise byte-identical.
- **Path-length-independent launch-journey assertion.**
  `test/app/contextualLaunchJourney.test.tsx` asserted the full
  `process.cwd()` appeared contiguously in a 140-column frame, which wraps for
  long checkout paths (e.g. this worktree). The test now renders that one
  journey at 240 columns so the absolute path is visible; the assertion itself
  is unchanged. Confirmed pre-existing: it fails identically on
  `@opentui/*` 0.4.2, so it is not an OpenTUI 0.5 regression.

## Known peer warnings

`bun install` reports two non-fatal peer warnings introduced by taking the
latest versions:

- `@opentui/solid@0.5.12` and `@opentui/keymap@0.5.12` peer-pin
  `solid-js@1.9.12` exactly; the project resolves `solid-js@1.9.15`. The 1.9
  patch line is compatible and the test suites pass.
- `bun-ffi-structs@0.3.1` (a transitive OpenTUI dependency) peer-pins
  `typescript@^5`; the project now runs `typescript@7.0.2`. The peer is a
  type-only constraint and the package is not part of the build API.

Both are accepted rather than pinned backwards so the direct dependencies stay
on their latest releases.

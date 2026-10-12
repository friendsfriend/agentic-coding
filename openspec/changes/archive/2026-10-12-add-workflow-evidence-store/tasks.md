# Tasks

## 1. Store

- [x] 1.1 Add `src/server/evidence/store.ts` (layout, ULID ids, atomic manifest, kind/magic validation, caps); verify in `test/evidence-store.test.ts` including quota refusal and manifest atomicity.
- [x] 1.2 Enforce path safety (realpath inside allowed roots, no outside symlinks); verify traversal and symlink cases.
- [x] 1.3 Delete evidence in `workspace.cleanup`; verify.

## 2. API and observation

- [x] 2.1 Add attach/list/file routes and the `evidence` observation kind in contracts and `observations.ts`; verify schema decoding and bounded fields.

## 3. Agent tools

- [x] 3.1 Add `evidence_attach` and `evidence_list` tools for every durable run using the environment capability; verify attaching a worktree file and refusal of an outside path.

## 4. Checks

- [x] 4.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

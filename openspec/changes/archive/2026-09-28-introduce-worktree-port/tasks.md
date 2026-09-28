# Tasks

## 1. Worktree port and worktrunk adapter

- [x] 1.1 Add `src/worktree/port.ts` defining the Effect-native `WorktreePort`
  (`list`, `find`, `ensure`, `remove`), `WorktreeRef`,
  `WorktreeLocation`, and the `WorktreeError` kind discriminator; verify
  `bun run type-check` passes with no `Promise` method, optional method,
  capability flag, or raw-argument method on the interface.
- [x] 1.2 Add `src/worktree/template.ts` with the pure shared layout
  (`worktreeTemplate`, `worktreePathConfig`) reproducing
  `<root>/<ident>/<ident>.{{ branch | sanitize }}`; verify a unit test asserts
  the environment layer's current `ident.branch` directory name for a branch
  containing `/`.
- [x] 1.3 Add `src/worktree/cli.ts` (the `wt`/`git` argv boundary, JSON
  decoding, realpath normalization, failure classification) and
  `src/worktree/index.ts` (`WorktreeAdapter implements WorktreePort`) with an
  injectable runner seam; verify a test asserts the exact `wt` argv for
  `list`, `ensure` with and without `--base`, and `remove`.
- [x] 1.4 Verify against the installed `wt`: a test in a temporary repository
  covers create-from-base, reuse of an existing worktree, reuse of a branch
  checked out in the primary worktree, removal keeping the branch, and
  stale-entry reclamation; skip the test when `wt` is not on `PATH`.
- [x] 1.5 Add `src/worktree/boundary.ts` as the single Effect execution point
  for the Promise- and sync-shaped consumers, mirroring
  `src/multiplexer/boundary.ts`.
- [x] 1.6 Verify `bun run type-check`, `bun run lint`, and the new tests pass
  before any caller migration.

## 2. Environment migration

- [x] 2.1 Replace `GitRepository.primaryWorktreeDir`/`linkedWorktreeDir` and
  `environment/config.ts`'s `worktreeBranchToDir`/path builders with
  `src/worktree/template.ts`; verify `test/integration-git-providers.test.ts`
  and the `worktree-lifecycle` fixture pass unchanged.
- [x] 2.2 Point `GitRepository.listWorktrees`/`addWorktree`/`removeWorktree`
  at the port, keeping the credential-carrying fetch, the primary-worktree
  diagnostic, and the empty result for an uncloned repository; verify the
  fixture suite and `test/environment-*.test.ts` pass.
- [x] 2.3 Verify the `/api/git/worktrees` request/response payloads are
  byte-identical for list, create, switch, and delete.

## 3. Action definitions

- [x] 3.1 Translate a declared `git worktree add`/`remove` command into a port
  call in the action runner instead of adding a step kind, so the compiled
  definition (and its pinned Go-parity fixture) is unchanged; verify
  `test/actions-definitions.test.ts`, `test/actions-handlers.test.ts` pass.
- [x] 3.2 Verify no other module constructs `worktree add`, `worktree remove`,
  `worktree list`, or `worktree prune` argv.

## 4. Workflow migration and multiplexer cleanup

- [x] 4.1 Replace `worktreeForBranch` with the port's `find` and the
  multiplexer `worktreeCreate` call with `ensure` plus
  `workspaceCreate({ cwd, label })` in `workflow/effect-runner.ts`.
- [x] 4.2 Replace the cleanup `git worktree remove` call with `remove`,
  keeping the rule that a workflow whose worktree is its repository removes
  nothing.
- [x] 4.3 Delete `worktreeCreate` from `src/multiplexer/port.ts`, the Herdr
  adapter, the Luvus adapter, the Luvus worktree schemas, and the
  multiplexer-adapters test legs that assert it.
- [x] 4.4 Verify a workflow start creates a branch at the requested base and
  that the same start succeeds with `AGENTIC_CODING_MULTIPLEXER` set to either
  runtime.

## 5. Documentation and specification hygiene

- [x] 5.1 Add `src/worktree/` to the root layer in
  `docs/workflow-architecture.md` and describe the port in a worktree doc.
- [x] 5.2 Add the spec delta removing worktree creation from
  `multiplexer-runtime` and dropping the corresponding Luvus requirement.
- [x] 5.3 Verify `openspec validate introduce-worktree-port --strict` and
  `bun run lint` pass.

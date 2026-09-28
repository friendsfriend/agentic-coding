# Proposal

## Why

Worktree mechanics are currently owned by five independent call sites: the
environment repository facade (`server/integrations/git-repository.ts`), the
environment path policy (`server/environment/config.ts`, `manager.ts`), the git
action definitions (`server/actions/compile.ts`, `actions/labels.ts`), workflow
workspace setup and cleanup (`workflow/effect-runner.ts`), and — until this
change — the multiplexer port, whose Herdr and Luvus adapters implement
worktree creation with different capabilities. Luvus cannot create a branch
from a requested base at all, so workflow worktree setup fails on Luvus and
works on Herdr for the same input. Duplicated mechanics also duplicate the
path template, the primary-worktree protection rule, and the fetch/credential
handling around worktree creation.

[Worktrunk](https://worktrunk.dev) (`wt`, installed `v0.80.0`) already owns
that vocabulary: branch-addressed worktrees, a configurable path template,
create-from-base, reuse, remove, stale-entry pruning, and process reaping.

## What Changes

- Introduce `src/worktree/` (root layer) with an Effect-native `WorktreePort`
  of required intent-level operations: `list`, `find`, `ensure`,
  `remove`. Callers never construct `wt` argument vectors and never parse
  worktrunk JSON themselves.
- Implement the port over the `wt` CLI (`--format json`, `--no-cd`,
  `--no-hooks`, `-y`) as its only tool. `wt` is validated as a bounded external
  binary (`WORKTRUNK_BIN_PATH`, minimum version) exactly like `herdr`/`luvus`.
- Keep one worktree layout for both layers:
  `<root>/<ident>/<ident>.{{ branch | sanitize }}`, passed to worktrunk as its
  `worktree-path` template. The environment layer keeps its `$DEVENV_HOME`
  root byte-for-byte; the workflow layer supplies its own root.
- Never run worktrunk hooks: every port call passes `--no-hooks`, so a
  repository-configured project hook can never run during a workflow or an
  environment worktree operation.
- Remove worktree creation from the multiplexer port and both adapters, and
  delete the Luvus worktree schemas. A workflow resolves its worktree through
  the worktree port and then opens a multiplexer workspace at that path.
- Migrate the environment repository facade, the git action definitions, and
  workflow setup/cleanup to the port so one module owns worktree mechanics.
- Classify port failures onto the existing policy: a conflict (branch checked
  out elsewhere, occupied path, primary worktree) is permanent; an unavailable
  transport or an unparseable reply is transient.

## Capabilities

### New Capabilities

- `worktree-runtime`: One worktree port over worktrunk for environments and
  workflows, its shared layout template, binary validation, and the failure
  classification callers rely on.

### Modified Capabilities

- `multiplexer-runtime`: The multiplexer port no longer covers worktree
  creation; workspace setup resolves the worktree through the worktree port
  and only opens a workspace at the resolved path.

## Impact

The change adds `src/worktree/` and migrates the environment
(`server/integrations/*`, `server/environment/*`), action-definition, and
workflow call sites that currently run worktree `git`/`wt` commands directly. Worktree creation stops being a multiplexer capability, so
a workflow's worktree is identical on Herdr and Luvus. Worktrunk `v0.80.0` or
newer becomes a required external binary for worktree operations, validated
loudly at the composition root; `git` remains required. The environment
worktree path layout and the legacy `/api/git/worktrees` contract are
unchanged, pinned by the existing cross-runtime fixtures. No package
dependency is added.

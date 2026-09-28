# Design

## Context

Constraints that shape the approach:

- `src/server/integrations/git-repository.ts` owns one credential-carrying git
  boundary (`run`/`must`/`credentialConfig`) and the environment worktree
  methods (`primaryWorktreeDir`, `linkedWorktreeDir`, `listWorktrees`,
  `addWorktree`, `removeWorktree`). `test/fixtures/integrations/git/*` pins the
  observable contract against the recorded Go behavior, including worktree
  creation, ownership protection and removal.
- `src/server/environment/config.ts` and `manager.ts` reproduce worktrunk's
  path template independently (`worktreeBranchToDir`, `primaryWorktreePath`,
  `resolveActiveWorktreePath`), and `state-store.ts` persists the
  `active_worktree` / `main_worktree_branch` selection.
- `src/server/actions/compile.ts` emits `worktree add` / `worktree remove`
  argument vectors that the action engine runs; `actions/labels.ts` classifies
  them by verb.
- `src/workflow/effect-runner.ts` resolves a worktree by branch
  (`worktreeForBranch`), creates one through the multiplexer port, and removes
  it during cleanup.
- `src/multiplexer/port.ts` requires a `worktreeCreate` operation; the Herdr
  adapter passes `--base`, the Luvus adapter cannot and fails loudly whenever
  the requested base is not the repository's current `HEAD`.
- Source-layer policy (`docs/workflow-architecture.md`) puts composition roots
  and foundational clients in the **root** layer, which every layer may import
  and which may import anything.

Installed worktrunk `v0.80.0` behavior verified against throwaway repositories
before this design was written:

| Intent | Invocation | Verified outcome |
| --- | --- | --- |
| list | `wt -C <repo> list --format json` | `items[].branch`, `head.sha`, `worktree{path,main,detached,branch_mismatch,prunable{reason}}` |
| reuse | `wt switch <b> --no-cd -y --no-hooks --format json` | `{"action":"existing","branch":…,"path":…}` |
| create (existing branch) | same | `{"action":"created","created_branch":false,"path":…}` |
| create from base | `… --create <b> --base <sha> --format json` | `{"action":"created","created_branch":true,"base_branch":"<sha>","path":…}` |
| branch is the primary worktree | `wt switch <b>` | `Already on worktree for <b> @ <repo>` — returns the primary path |
| custom location | `--config-set 'worktree-path="{{ repo_path }}/../{{ repo }}.{{ branch \| sanitize }}"'` | creates at the overridden root |
| remove, keep branch | `wt remove <b\|path> --force --no-delete-branch --no-hooks --format json -y` | JSON `[{kind:"worktree",path,branch_outcome}]`, branch kept |
| remove the primary | `wt remove <main>` | refused (usage error) |
| stale entry | `wt remove <path>` | `Pruned stale worktree for <branch>` |

## Goals / Non-Goals

**Goals:**

- One module owns worktree mechanics for environments and workflows.
- The environment worktree layout and the `/api/git/worktrees` contract stay
  unchanged; the workflow layer gets the same layout shape under its own root.
- Worktree creation behaves identically on every multiplexer.
- Failures classify onto the existing policy without a new vocabulary.

**Non-Goals:**

- Worktrunk hooks, `wt merge`, forge/PR shortcuts, or `wt step prune`.
- Branch operations (checkout, pull, push, fetch), credentials, or the
  environment `active_worktree` state.
- Changing the multiplexer port's remaining operations.

## Decisions

### Decision 1: Worktrunk is the implementation, git argv is the escape

The port is worktrunk-backed for every operation, because worktrunk supplies
the branch-addressed vocabulary, the path template, reuse, stale-entry
detection and pruning that this repository currently reimplements. Worktrunk is
then the port's only tool: a detached checkout (`git worktree add --detach`),
which worktrunk cannot express, has no consumer — the change-request AI review
that needed one was removed (`remove-change-request-ai-review`) — so the port
does not carry a second transport for it.

### Decision 2: One call per intent, results from JSON

`ensure` is a single `wt switch` call: worktrunk creates or reuses as needed
and reports `action`, `branch` and `path` in `--format json`, so the port never
has to catch "branch already exists" for the reuse case and never needs a
second `list` after creating. The only retry is a `--create` call that loses a
race to an existing branch, which falls back to a plain switch.

### Decision 3: The port never runs hooks and never changes the caller's cwd

Every invocation passes `--no-hooks`, `--no-cd` and `-y`. A repository project
hook must not run because a workflow or a dashboard action asked for a
worktree: the trust decision belongs to a human running `wt` in a terminal, not
to an orchestrated agent. `--no-cd` keeps the calling process's cwd intact, and
`-y` keeps every call non-interactive.

### Decision 4: One layout, caller-supplied root

The shared layout is `<root>/<ident>/<ident>.{{ branch | sanitize }}`, passed
to worktrunk as the `worktree-path` template through `--config-set`, so the
port stays layout-agnostic and never reads ambient configuration. The
environment layer passes `$DEVENV_HOME` and its app ident (unchanged, including
the existing `ident.branch` directory name); the workflow layer passes its own
worktree root and the repository directory name. Both layers keep the
subfolder-per-repository shape the environment layer already has.

### Decision 5: The environment facade's worktree methods are its only async ones

`GitRepository` is synchronous and the port is Effect-native, so the facade's
three worktree methods (`listWorktrees`, `addWorktree`, `removeWorktree`) return
`Promise` and run their effects through `src/worktree/boundary.ts`. The
alternative — a second `Bun.spawnSync` transport so the facade stays
synchronous — would duplicate the subprocess boundary and lose its hard timeout
and cancellation, which is why the three call sites (`routes.ts` handlers plus
the fixture harness) simply await instead. `boundary.ts` therefore exposes only
`runWorktree`; nothing consumes a synchronous execution point.

### Decision 6: The action runner translates, the definition does not change

The compiled `git worktree add|remove` steps keep their wire shape: they are
what an app configures, what the actions view renders, and what the pinned
Go-parity fixture (`test/fixtures/actions/definitions.json`) records. A new step
kind would have changed that fixture, the shared `@devenv/types` wire union and
the engine's handler registry for no user-visible gain, so the translation
happens one layer below, in the action runner that already special-cases `git`
for credentials. Only the two mutations are translated; `worktree list` and
`worktree prune` stay plain git because the actions view shows their output.

### Decision 7: Credentials and fetches stay outside the port

Worktrunk runs `git` without a way to pass `-c http.extraheader`, and injecting
`GIT_CONFIG_KEY_0` would leak a token into a child environment. The credential
carrying fetch therefore stays in the environment repository facade and runs
before `ensure`, exactly as `addWorktree` already does. The port never sees a
credential.

### Decision 8: Primary-versus-linked is decided from the worktree itself

Whether a resolved path is the primary worktree is read from the path — its
`.git` is a directory for the primary worktree and a file pointing at the
per-worktree git directory for a linked one — rather than from comparing it
against the caller's repository argument. That is the same test the environment
layer already uses, it costs one `stat`, and it stays exact whichever worktree
the caller named (the environment layer's active checkout may be a linked
worktree).

### Decision 9: Failure classification carries a permanent kind

`WorktreeError.kind` is `absent`, `unavailable`, `conflict`,
`invalid-response`, or `ownership-lost`. `conflict` (branch checked out
elsewhere, occupied path, the primary worktree) maps to the runner's permanent
class, and `unavailable`/`invalid-response` keep the transient class that the
multiplexer boundary already maps to. Primary-worktree protection is checked
from `list` before removal so the diagnostic is bounded text rather than a
worktrunk usage message.

### Decision 10: The multiplexer port loses the repository concept

A workflow resolves its worktree through the worktree port and then calls
`workspaceCreate({ cwd, label })`, which already exists for the pre-existing
worktree path. The multiplexer port keeps only terminals: workspaces, tabs,
panes, agents, notifications and events.

### Decision 11: A stale directory at the layout path is a conflict

`addWorktree` today returns the linked directory when it merely exists on disk,
without checking that Git has a worktree registered there — the caller then
treats a non-worktree as the app's active checkout. The port instead creates or
reuses a *registered* worktree and reports an occupied path as a conflict, which
is the user's accepted behavior change (option A of the migration review).
`wt switch --clobber` (back the stale path up, then create) remains available
without a port input if that behavior is ever wanted back.

## Risks / Trade-offs

- [Worktrunk becomes a required binary for worktree operations] -> Validated at
  the composition root with `Bun.which` and a minimum version, failing loudly
  with the binary name, exactly like the selected multiplexer.
- [Worktrunk's JSON schema could drift] -> The adapter decodes only the fields
  it needs and reports an unexpected shape as `invalid-response`; the version
  floor is pinned by the capability check.
- [Removal semantics differ from `git worktree remove`] -> Worktrunk deletes
  merged branches by default, so the port always passes `--no-delete-branch`
  unless the caller asks otherwise; removal keeps the branch by default.
- [The recorded environment fixtures pin behavior that migration could change]
  -> The fixture suite is the gate for every environment step, and the
  environment path layout is intentionally left byte-identical.
- [Existing workflow worktrees live under the previous runtime directories] ->
  Reuse is branch-based through the git worktree registry, so an in-flight
  workflow keeps its recorded path and only new worktrees use the new layout.

## Migration Plan

1. Add `src/worktree/` (port, template, CLI boundary, adapter, boundary) with
   contract tests; no callers change.
2. Migrate the environment repository facade and its path policy to the port
   and the shared template; the fixtures gate the step.
3. Migrate the git action definitions.
4. Migrate workflow setup and cleanup; then delete `worktreeCreate` from the
   multiplexer port, both adapters, and the Luvus worktree schemas.
5. Update `docs/workflow-architecture.md` (root layer gains `src/worktree/`),
   add a worktree port doc, and amend the multiplexer spec delta.

Each step is independently revertible and leaves both runtimes working.

## Open Questions

- Whether the workflow worktree root should be configurable per project or stay
  a process-level default; the first step uses the default and the port takes
  the root as an input either way.
- Whether `--reap` should be the default for workflow cleanup, which would
  replace part of the pane teardown during workflow close.

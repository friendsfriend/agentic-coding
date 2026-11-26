# OpenCode TUI plugin

The app-centric OpenCode 2.0.22 TUI for `environment-mcp`. It presents the
configured environments — applications, libraries, infrastructure, services,
receipts, logs and telemetry — rather than the agent's MCP tool list.

It uses the same authenticated loopback capability API as the standalone UI. It
does not construct an MCP server, listener, journal, runtime adapter or approval
gate, and it has no plugin-local action table.

## Install

The plugin is a local package beside the server:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD/opencode-plugin" ~/.config/opencode/plugins/environment-mcp
opencode plugin list
```

OpenCode discovers `<config>/plugins/<directory>` automatically and hot-reloads
the source; there is no build step for local use.

The optional configuration-editing skill can be linked into the same config:

```sh
ln -sfn "$PWD/opencode-plugin/skills/environment-config-editing" \
  ~/.config/opencode/skills/environment-config-editing
```

Open it with any of:

- the clickable **Environment** chip in the home footer
- `/environment`
- `<leader>v` (the default leader is `ctrl+x`, so `ctrl+x v`)
- `<leader>G` (leader then Shift+G; bind string `<leader>shift+g`) opens **Git
  for the agent's current working directory**, including repositories outside
  the environment allowlist
- `/git` opens the same Git view
- `/issues` and `/changes` open the current directory's provider issues or
  change requests
- the command palette (`ctrl+p`) entries **Environment**, **Git actions for
  current directory**, **Issues for current directory** and **Changes for
  current directory**

Full runtime descriptors, profiles and bulk configuration edits are covered by
the optional `environment-config-editing` skill.

## Screens

- **Applications / Libraries / Infrastructure** — create apps with build/test/run
  defaults; edit targets with command, timeout, environment, secret references,
  ready text, endpoints and prerequisites; the configured environment
  inventory, glyph target summaries (`⚒` build, `✓` test, `▶` run), git branch
  and modified/added/deleted counts with ahead/behind, and current run status
  with owned-resource count. An authenticated SSE stream invalidates
  status/history/git while the panel is open; 15s/30s reconciliation polling is
  the fallback.
- **Application detail** — kind, repository, git state, current status, defaults,
  targets, owned resources, recent receipts, and the action keys. `c` opens the
  changed-files list; `E` edits the application and `X` deletes it.
- **App/target CRUD** — `n` on the applications table opens the new-application
  form. In the target picker, `n` creates a shell target, `d` duplicates the
  selected target, `e` edits profile/action/shell settings, and `x` deletes it.
  Forms preview the exact intent digest; `y` confirms, `Tab` moves fields, and
  `Esc` cancels. Profiles are optional target labels, not separate records.
- **Changes / Diff** — bounded changed paths with status glyphs, stage/worktree
  flags, rename origins and a staged count; `s` toggles staging for the selected
  path, `a` stages all, `u` unstages all, and `Enter` opens a bounded unified
  diff. In the diff, `s` cycles all/staged/worktree sides. Binary, symlink,
  directory and invalid paths are refused with a clear note. Session Git opens
  the same changes/diff views.
- **Git** — `g` opens a raised header matching the environment shell, with the
  current branch, branch/worktree counts and the `/` branch filter in the
  header. `Enter` switches branch, `f` fetches, `p` pulls fast-forward-only,
  `P` pushes, `F` force-pushes with an exact lease, `X` aborts an in-progress
  rebase, `L` opens commit history, `t` creates a tag (message optional for an
  annotated tag), `T`
  lists tags, `R` renames the selected branch, `C` commits staged changes, `A`
  commits all changes, `s` stashes, `S` lists stashes, `M` merges the selected
  branch into the current branch, `B` rebases the current branch onto the
  selected one, `d` safely deletes the selected branch, `m` opens remotes, and
  `c` opens changes. Writes show an exact target and digest, then require `y`;
  ordinary push never forces, force push requires an upstream and local
  remote-tracking ref and binds that SHA into the confirmation digest, and
  merge/rebase require a clean worktree. `<leader>G` opens the same view
  directly for the agent cwd, hiding the environment tabs; `Esc` closes it.
  The cwd is `process.cwd()` unless the plugin receives a `directory` or `cwd`
  option.
- **Providers** — provider descriptions, timeline notes and commit messages
  normalize GitLab/GitHub HTML fragments to Markdown before rendering. Change
  and issue lists use two-line rows (title/state plus
  branches/author or author/labels), and every scrollable list shows a vertical
  scrollbar on the right when its content overflows. `c` and `i` on the applications table resolve the selected
  app's git remote to its configured provider and open change requests or issues
  directly; `Esc` returns to the application list. `p` opens the configured
  GitHub/GitLab providers with token availability, `/` filtering and `Enter`
  to search repositories. Open a repository to browse changes, issues and
  pipelines (`c`, `i`, `l`), cycle change/issue state with `s`, and open
  pipeline jobs with `Enter`. Change and issue `Enter` opens detail with the
  body rendered as Markdown; change detail `d` opens bounded changed files,
  file `Enter` opens the native OpenTUI diff viewer with line numbers and
  add/remove styling, `h` opens a discussion timeline with a continuous rail,
  typed event glyphs and Markdown note bodies, and `v` opens version history
  with commit glyphs and the same rail. Issue detail `h` opens its comment
  timeline; job `Enter` opens a bounded redacted log. Provider writes are
  preview-confirmed: change/issue `c` comments, change `a` approves the exact
  displayed head, `u` withdraws approval, `M` opens the GitHub merge-method
  picker (merge/squash/rebase) or merges directly on GitLab, `B` requests a
  GitLab rebase, `l` adds labels, `A` sets assignees, issue `o` toggles open/closed,
  discussion `c` replies and `x` resolves/unresolves (GitLab discussions or
  GitHub review threads through GraphQL), pipeline `t`/`x`
  retries or cancels, job `t` retries it, `y` confirms the exact digest, and `w`
  lists durable write receipts. `/issues` and `/changes` open the current
  directory's provider lists directly. All read views support `/`
  filtering where applicable and use the same raised environment-style header.
  Tokens are never shown.
- **Commit history** — `L` lists the current branch's last 50 commits with
  short SHA, subject, author, date and ref badges. `Enter` opens the commit's
  full message, parents, file stats and a per-file native diff.
- **Tags** — `T` lists lightweight and annotated tags with subject/date; `t`
  creates a tag (message optional), `d` deletes the selected tag, and both use
  the preview-confirm flow.
- **Stashes** — `S` lists stashes with index, branch, message and date; `p`
  pops, `a` applies, and `d` drops the selected stash with confirmation.
- **Remotes** — sanitized fetch/push URLs; `a` adds a remote (credential-bearing
  HTTP URLs are refused), `e` updates the selected remote URL through the
  preview-confirm flow, `x` removes the selected remote.
- **Worktrees** — current/locked/prunable linked worktrees; `a` opens the
  worktree form with editable path and branch fields (`Tab` switches), an
  existing/new branch badge, and creates a new branch when the name is not
  local. `u` runs targets from the selected worktree (shell/process, Docker
  builds, Compose, container-run and Helm). Compose projects, container names
  and Helm releases get a per-worktree suffix, as do Docker-build tags and
  container-run images that reference a build target. Compose files and Helm
  charts must be repository-local. Network-only targets refuse. `x` removes the
  selected clean non-current worktree. The active worktree carries an
  `execution` badge and detail/history show its path.
- **Container stats** — `m` from application detail reads CPU, memory, network
  and PID stats for containers owned by the scope or registered shared services.
  While the view is open it samples every two seconds, keeps a bounded 60-sample
  history and shows CPU/memory sparklines plus CPU, memory and network deltas.
  Other host containers are never listed.
- **Kubernetes** — `K` from the applications table lists authorized clusters;
  `Enter` opens a selectable namespace list (default selected) with `/` for a
  custom namespace, then returns deployments, statefulsets, pods and services as
  selectable two-line resources. `Enter` describes the selected
  resource, `e` opens namespace events with `/` filtering, and `l` reads tail
  logs for the selected pod. Multi-container pods open a container picker
  first; pod logs `p` switches to the previous container instance. System
  namespaces are refused; no exec or attach is exposed.
- **Target picker** — the exact configured target/profile for build, test or run.
- **Operation** — the running or settled execution receipt, subject,
  digest/revision, live build steps and per-step logs.
- **History** — operation receipts with safe app/target/action attribution.
- **Services** — configured service bindings and controller-wide shared state.
- **Logs / Telemetry** — owned logs and captured OTLP logs/traces for the
  selected application.

## Actions

| Key | Action |
| --- | --- |
| `b` | Prepare a build review |
| `s` | Prepare a start/run review |
| `t` | Prepare a test review |
| `S` | Stop owned resources for the selected app |
| `l` | Read owned logs |
| `L` | Open operation history |
| `e` | Read telemetry |
| `r` | Refresh the current surface |
| `Esc` | Back / close |
| `?` | Full keybind help |

Build, test and run execute directly:

1. The plugin calls `env_execute` with the exact app/target and a fresh request id.
2. The operation is admitted and dispatched in one step.
3. `env_wait` observes the settled receipt; `r` refreshes if it is still running.

Stop is owned-only and does not touch borrowed/shared services. There is no
approval surface.

## Filtering

While the application filter is focused, `↑/↓` moves the filtered result
selection. `Enter` returns focus to the list without opening anything; the
normal arrows/`j/k` then navigate and `Enter` opens the selected application.
`Esc` clears the filter.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| URL | `http://127.0.0.1:38471` |
| Token file | `~/.config/environment-mcp/client-token` |

Override with `ENVIRONMENT_MCP_URL` / `ENVIRONMENT_MCP_TOKEN_FILE`, or pass
`url` / `tokenFile` plugin options through an explicit `cli.json` entry.

## Current backend limits

The environment-mcp capability registry exposes the execution inventory, direct
execution/wait, owned stop, logs, telemetry, services, scoped container stats,
git reads and guarded git writes, provider reads and guarded writes, app/target
configuration writes, and read-only Kubernetes inspection including events,
describe and pod logs. It does not yet expose pod attach or exec.

The table and detail only read metadata. `env_list` still carries executable
descriptors for the agent; this UI never renders them.

## Checks

```sh
bun install
bun run type-check
bun test
```

From the server package, `bun run lint`, `bun run type-check` and `bun run test`
also cover the plugin sources and tests. The focused equivalents are
`bun run --cwd opencode-plugin type-check` and
`bun run --cwd opencode-plugin test`.

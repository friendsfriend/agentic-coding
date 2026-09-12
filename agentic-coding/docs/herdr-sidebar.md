# Herdr workflow sidebar

Native Herdr sidebar cards for managed workflows and agents
(`improve-herdr-workflow-sidebar`). The integration publishes display-only
Herdr metadata and one transient native Agents view; it never owns workflow
state, agent processes, or Herdr topology.

- Projection: `src/workflow/sidebar.ts` (pure: typed views + supplied
  observations → display tokens and input ranks).
- Publication boundary: `src/workflow/sidebar-sync.ts` (shared `herdr` CLI
  envelope plus the socket-only `agent.view.set` / `agent.view.clear`).
- Lifecycle owner: `src/workflow/sidebar-observer.ts`, started by the TUI shell
  while home/dash is alive.

## Requirements

- Herdr 0.9.0 or newer (workspace/pane metadata tokens, `agent.view.set`).
- A running Herdr server with `HERDR_SOCKET_PATH` exported (Herdr sets it for
  agents it launches). Without it, metadata still publishes but the custom
  Agents view is not installed.

## Enable it

The preference is trusted user configuration only — a project
`.pi/herdr-workflow.toml` cannot turn the integration on or off for other
workspaces.

```toml
# ~/.config/agentic-coding/config.toml
[ui]
herdr_sidebar = true
```

Default is `false`. Nothing is published or installed while it is off.

## Configure the native rows

Back up the current configuration first and merge the rows by hand; the
installer never rewrites `~/.config/herdr/config.toml`.

```bash
cp ~/.config/herdr/config.toml ~/.config/herdr/config.toml.bak
```

```toml
# ~/.config/herdr/config.toml
[ui.sidebar.spaces]
rows = [
  ["$ac_project_line"],
  ["$ac_workflow_line"],
  ["$ac_type_line"],
  ["$ac_phase_line"],
]

[ui.sidebar.agents]
rows = [
  ["$ac_project_line"],
  ["$ac_workflow_line"],
  ["$ac_role_line"],
  ["$ac_status_line"],
]
```

Reload with `herdr server reload-config` (or restart Herdr). One complete
display token per row is intentional: Herdr trims token values and inserts
separators between tokens on the same row, so composing the whole line in the
publisher keeps the marker adjacent to the project name and keeps the tree
indentation after `├─` / `│` / `└─` visible.

### Colors

Custom metadata tokens render dim by default, so set `fg` and `dim = false`
explicitly or the cards look faded. Add styles to the row entries:

```toml
[ui.sidebar.spaces]
rows = [
  [{ token = "$ac_project_line", fg = "#cdd6f4", bold = true, dim = false }],
  [{ token = "$ac_workflow_line", fg = "#89b4fa", bold = false, dim = false }],
  [{ token = "$ac_type_line", fg = "#a6adc8", bold = false, dim = false }],
  [{ token = "$ac_phase_line", fg = "#f9e2af", bold = false, dim = false }],
]

[ui.sidebar.agents]
rows = [
  [{ token = "$ac_project_line", fg = "#cdd6f4", bold = true, dim = false }],
  [{ token = "$ac_workflow_line", fg = "#89b4fa", bold = false, dim = false }],
  [{ token = "$ac_role_line", fg = "#cba6f7", bold = false, dim = false }],
  [{ token = "$ac_status_line", fg = "#94e2d5", bold = false, dim = false }],
]
```

A row style is static per token: Herdr accepts only a strict `#RGB`/`#RRGGBB`
`fg` plus `bold`/`dim`, so it cannot color the status row differently for
`working` vs `blocked` from the token value. The status text carries its own
glyph (`○ ● ◆ ✓ ?`) for that. If you would rather have Herdr's own
state-colored indicator, add its built-in `state_icon` to the status row — it
is colored from the same live agent state this integration observes:

```toml
[{ token = "state_icon" }, { token = "$ac_status_line", dim = false }]
```

Target cards:

```text
◆ agentic-coding            ◆ agentic-coding
├─ improve-authentication   ├─ improve-authentication
│  openspec-full            │  worker
└─ Implementation           └─ ● blocked (input)
```

Reading a card:

- `◆` — developer input is owed: a pending developer question for this exact
  run, a fresh `blocked` runtime prompt, a registered blocking approval gate,
  or committed paused/attention-required state.
- `◇` — no *known* obligation. With an incomplete observation the status row
  says `unknown` and the card is explicitly not verified idle.
- Each card repeats its project line; there is no shared project header. Two
  repositories with the same basename stay distinct workflows.
- Spaces keep Herdr's native order and worktree grouping; only the Agents view
  is reordered, input-required cards first, then uncertain, then freshly
  observed no-input cards, each group in native workspace/tab/pane order.
- Unmanaged panes/spaces show their existing Herdr name and status, without a
  marker, workflow identity, or sort key. They sort after managed cards.

## View ownership and lifetime

`agent.view.set` replaces whichever custom view is active: the view is
transient, server-scoped, and singular. Agentic Coding installs it once per
connection (startup/reconnect) and does not reassert it on every metadata
refresh, so a view selected later by you or another tool is not fought over.

Live refresh is owned by the running Agentic Coding application: event-driven
reconciliation plus a bounded two-second fallback while home/dash is alive,
including when another Herdr tab is focused. **There is no background daemon**
— continuous live refresh stops when every Agentic Coding application exits.
The last published cards remain in place until the next application starts and
reconciles. Publication failures are bounded, non-fatal diagnostics; a Herdr
outage never changes a workflow revision, action availability, agent status,
or effect attempt.

## Disable and roll back

1. Set `ui.herdr_sidebar = false` (or remove the key).
2. Restore the saved rows:

   ```bash
   cp ~/.config/herdr/config.toml.bak ~/.config/herdr/config.toml
   herdr server reload-config
   ```

3. Explicit disable also clears the integration's own view
   (`agent.view.clear` with `source = "agentic-coding"`) and its `ac_*` tokens:

   ```bash
   agentic-coding workflow sidebar --repo PATH --disable
   ```

   Ordinary application shutdown is not an explicit disable: it leaves the
   server-wide view alone so another live application keeps using it.

Rollback never changes workflow stores, agent processes, native Herdr names, or
unrelated user settings, and it does not stop or relaunch agents.

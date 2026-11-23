# OpenCode TUI plugin

The OpenCode 2.0.22 TUI surface for `environment-mcp`. It renders the same
capability registry the agent uses, over the authenticated loopback HTTP API.
It does not construct an MCP server, listener, journal, runtime adapter or
approval authority.

## Install

The plugin is a local package beside the server:

```sh
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD/opencode-plugin" ~/.config/opencode/plugins/environment-mcp
opencode plugin list
```

OpenCode discovers `<config>/plugins/<directory>` automatically. The plugin
hot-reloads from source; there is no build step for local use.

Open it with any of:

- the clickable **Environment** chip in the home footer
- `/environment` or `/env`
- `<leader>v` (the default leader is `ctrl+x`, so `ctrl+x v`)
- the command palette (`ctrl+p`) entry **Environment**

## What it shows

- A searchable capability list grouped **Inspect**, **Operate**, **Observe**.
- The action's JSON-Schema inputs, required markers, defaults and allowed values.
- A running state with cancellation, a scrollable structured result, and a
  telemetry trace list with parent/child drill-down.
- A two-column `?` help dialog and a footer that advertises only special keys.
- Theme colors, keybind dispatch and dialogs from the host OpenCode TUI.

The UI consumes `UiCapabilityApi` through the same
`createEnvironmentUiController` as the standalone OpenTUI. Capability names,
labels and input schemas therefore remain registry-derived; there is no
plugin-local action table. Approval remains a separate operator surface.

## Configuration

Defaults:

| Setting | Default |
| --- | --- |
| URL | `http://127.0.0.1:38471` |
| Token file | `~/.config/environment-mcp/client-token` |

Override with environment variables:

```sh
ENVIRONMENT_MCP_URL=http://127.0.0.1:38471
ENVIRONMENT_MCP_TOKEN_FILE=/absolute/path/client-token
```

If installed through an explicit `cli.json` plugin entry, options are also
accepted:

```json
{
  "plugins": [
    {
      "package": "/absolute/path/to/environment-mcp/opencode-plugin",
      "options": {
        "url": "http://127.0.0.1:38471",
        "tokenFile": "/absolute/path/client-token"
      }
    }
  ]
}
```

The token is read from the file and never displayed. A missing or invalid token
shows the same setup error as an unreachable service; `r` retries.

## Limits

- Forms support the flat scalar object schemas the capability registry currently
  declares. A nested schema is reported as unsupported rather than guessed.
- The plugin can prepare and dispatch agent capabilities, including destructive
  ones, after the server's own admission rules. It is not the approval surface.
- `requestId` fields are prefilled with a fresh UUID so exact-review actions are
  usable without hand-typing an idempotency key.
- The local package is not published. OpenCode aliases the TUI runtime imports
  (`@opentui/solid`, `solid-js`); the package's own `node_modules` is only for
  type-checking and tests.

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

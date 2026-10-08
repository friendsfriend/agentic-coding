# Agent environment instances

An environment instance is one run target of one configured app, bound to an
owner and a checkout. Instances are stored in the environment state database
(schema v8) alongside their allocated host ports. The durable storage key is
app-scoped; the user-facing instance id for a human-owned app is `default`,
while workflow ids are sanitized, stable slugs with a short hash suffix. Since
`default` may identify more than one app, instance read/stop requests can pass
`?app=<app-id>` when the id is not unique.

Owners are `user` or `workflow:<id>`. User instances use the app's active
checkout. For workflow owners, the server resolves the recorded workflow
repository/worktree or finds the workflow branch in the managed app worktree;
clients cannot submit an arbitrary checkout path. An optional configuration
overlay is searched ahead of the live configuration directory.
Only one instance is allowed for each owner/app pair. A repeated start of a
running pair returns `already-running` rather than launching a duplicate.

## Instance variables

The server passes these values to Compose interpolation or the script process:

| Variable | Value |
| --- | --- |
| `AC_INSTANCE` | Stable instance id (`default` for the user instance). |
| `AC_OWNER` | `user` or `workflow:<id>`. |
| `AC_APP_DIR` | Checkout path bound to the instance. |
| `AC_IMAGE_TAG` | `latest` for the user, otherwise the instance id. |
| `AC_PORT_<NAME>` | Agent-owned host port allocated for a source reference to that name. |

Compose definitions should use `${AC_PORT_HTTP:-8080}`-style references, use
`AC_IMAGE_TAG` for image tags, and avoid fixed `container_name` values or
infrastructure `include:` directives. User instances receive no allocated
`AC_PORT_*` variables, so Compose's `:-default` value preserves the usual
human port. Production currently selects agent-owned ports from the fixed
`20000-29999` range, checks loopback bindability, persists allocations, and frees
them when a confirmed stop completes. Embedding callers can inject a custom
range; parsing `environment.instances.port_range` from configuration is not yet
wired into the production composition. A start that finds a port conflict retries
allocation once; exhaustion reports `port-unavailable`.

Docker instances use Compose project `<app>-<instance>` on the shared external
`devenv-local` network. Script instances are tracked with an instance-specific
process/tmux handle, so stopping one instance does not stop another instance
or a user's unrelated process. Workflow-owned scripts run as logged child
processes even when the server itself is inside tmux, so they do not inherit the
tmux server environment; their process environment is an allowlist of runtime
settings plus `AC_*` values. User-owned scripts retain the operator environment
except server capability variables. If no target/profile is named, selection
prefers Docker and then shell/system-shell; Kubernetes is not implicitly
selected.

The instance API is served at `/api/v1/environment/instances`: `GET` lists,
`GET /{id}` reads, `POST /start` starts from `{ owner, app, target?, profile? }`,
and `POST /{id}/stop` stops a selected instance. Responses include resolved
endpoints as `name -> http://127.0.0.1:<port>`. A runtime observation failure
on server startup yields `unknown`, not `stopped`; unknown instances retain
port reservations until an explicit successful stop or later observation.

---
name: environment-config-editing
description: "Edit environment-mcp environments.json safely: profiles, bulk target changes and full runtime descriptors."
---

Use this skill when the environment panel's app/target forms do not expose a
field, or when several targets must change together.

## Files

The configuration root is `$ENVIRONMENT_CONFIG_DIR` or the server's
`--config-dir` (commonly `~/.config/agentic-coding-v2`).

- `config.json` — authorized repositories.
- `environments.json` — projects, kinds, defaults and targets.
- `.env` — declared secret values referenced by `secretRefs`.
- `clusters.json` — optional Kubernetes clusters.

Read the current files first. Before a manual write, copy
`environments.json` to a timestamped `.bak` beside it. Never put secret values in
`environments.json`; put them in `.env` and reference the environment name from
`secretRefs`.

## Profiles

`profile` is only a free-form label on a target. There is no profile entity and
no MCP profile CRUD. To offer a variant, duplicate the target and set a different
`id` and `profile`. Defaults are `{ "build": "<target>", "test": "<target>",
"run": "<target>" }` and must point at targets with the matching action.

## Full descriptors

Edit the target object directly for fields the capability surface does not
support. Preserve every unknown field.

Shell target:

```json
{
  "id": "dev",
  "action": "run",
  "runtime": "shell",
  "command": "bun run dev",
  "timeoutMs": 600000,
  "environment": { "MODE": "development" },
  "secretRefs": { "API_TOKEN": "LOCAL_API_TOKEN" },
  "readyUrl": "http://127.0.0.1:3000/healthz"
}
```

Compose target: keep `file` or inline `source`, `project`, `services`,
`networkOnly`, `networkFrom` and collector telemetry exactly as reviewed. Do not
attach or rewrite existing services.

Container target: keep the provider, `container` image/name, publications,
environment, mounts and telemetry declarations. Kubernetes targets keep
`workload: "helm-release-v1"`, `helm`, the config-contained chart, namespace and
cluster id. CRDs, hooks, subcharts and chart upgrades are unsupported.

## Bulk edits

Use `jq` or a short Python script that loads the whole document, changes only the
named targets, and writes atomically. Verify afterwards:

- every project has a unique id;
- every target id is unique inside its project;
- every default names an existing target with the same action;
- prerequisites name existing app/target pairs;
- secret refs name variables present in `.env`;
- removed targets are not defaults or referenced by another target.

## Applying

For supported fields prefer the panel or `env_app_*` / `env_target_*`
capabilities; they validate, back up and refresh. After a manual file edit, run
`env_refresh` through environment-mcp or restart the service. If execution or
owned resources are active, `env_refresh` refuses; finish or stop them first.

# Proposal

## Why

All 23 existing app compose files and the infra compose files are singletons
(`container_name`, fixed host ports, `include:` of infra compose,
`image: <app>:latest`). Agents can only use templated targets
(`add-environment-instances`), so the existing configuration must be converted
once, safely and reviewably, and new drift must be detectable.

## What Changes

- `agentic-coding env migrate-templates` — dry run by default, `--apply` writes
  with a protected backup, like `config migrate`. Mechanical rewrites per app
  compose file:
  - drop `container_name`;
  - host ports `"8080:8080"` → `"${AC_PORT_HTTP:-8080}:8080"` (name from the
    service/port, stable);
  - `image: <app>:latest` → `image: <app>:${AC_IMAGE_TAG:-latest}`;
  - infra `include:` entries → `x-devenv-requires` metadata (parsed by
    `parseComposeRequires`) and `networks.devenv-local.external: true`;
  - service names stay, so in-network DNS keeps working.
- Infra compose files get `name` kept, `devenv-local` external network, unchanged
  container names (infra is shared and singleton by design).
- A validator `agentic-coding env validate` reports per target: templated /
  untemplated (with reasons) / needs-semantic-pass (requires isolated infra but
  does not reference `AC_DB_SCHEMA`; no `AC_OTEL_*`).
- Semantic parts (datasource schema variable, mock-auth profile, OTel) are left
  for the per-app `env-setup` pass.

## Capabilities

### New Capabilities

- `environment-template-migration`: the migration command, its safety
  guarantees, and the template validator.

## Impact

- New `src/server/environment/template-migration.ts`, `template-validate.ts`,
  CLI wiring in `src/cli.ts` / `src/config-command.ts` style.
- YAML handling: use Bun's built-in YAML parse/stringify if available in the
  locked Bun version, else a line-preserving targeted rewrite (decided in task
  1.1; no new dependency without justification).
- Depends on `add-environment-instances`, `add-instance-infra-isolation`.

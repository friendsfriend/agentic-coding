# Adding Infrastructure Services

Infrastructure services (databases, message queues, caches, local native daemons) are defined as Docker Compose services or script-backed services managed by DevEnv.

## 1. Create the service definition

Create a JSON file at `~/.config/devenv/infrastructure/definitions/IDENT.json`:

```json
{
  "ident": "postgres",
  "displayName": "PostgreSQL",
  "containerBaseName": "postgres"
}
```

Docker services may omit `type`; DevEnv treats them as `"docker"`.

- `ident` — unique identifier (required)
- `displayName` — human-readable name shown in the TUI
- `containerBaseName` — Docker container base name for lifecycle management

## 2. Create the Compose file

Place a Docker Compose file at `~/.config/devenv/infrastructure/compose/IDENT.yml`:

```yaml
services:
  postgres:
    image: postgres:16
    environment:
      - POSTGRES_DB=app
      - POSTGRES_PASSWORD=secret
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
```

Infrastructure services appear in the **Infrastructure** tab of the TUI. Docker services support `s` (start), `S` (stop), `R` (restart), and container logs (`l`).

## 3. Script-backed services

Create a service definition with `"type": "script"` and at least one runner:

```json
{
  "ident": "local-api",
  "displayName": "Local API",
  "type": "script",
  "shellPath": "/Users/me/project/scripts/start-api.sh",
  "powerShellPath": "C:/project/scripts/start-api.ps1",
  "defaultRunner": "shell",
  "cwd": "/Users/me/project",
  "args": ["--port", "8080"],
  "env": {
    "NODE_ENV": "development"
  }
}
```

- `type` — set to `script`
- `shellPath` — shell script path, run with `sh`/`bash`
- `powerShellPath` — PowerShell script path, run with `pwsh`/`powershell`
- `defaultRunner` — optional: `shell` or `powershell`
- `cwd` — working directory for the script
- `args` — extra arguments passed to the script
- `env` — environment variables added to the process
- `logPath` — optional output log path; defaults under DevEnv logs

When both runners exist and no `defaultRunner` is configured, DevEnv prompts before manual start. App run dependencies can also start script services; set `defaultRunner` when no prompt is possible.

When DevEnv server runs inside tmux, script services start in a tmux window and DevEnv tracks the window id for stop/status. Outside tmux, DevEnv falls back to managed log-only execution and writes stdout/stderr to the service log.

## 4. Share infra between apps

Multiple apps can depend on the same infra service. Declare dependencies in app run metadata:

Shell or PowerShell run script:

```sh
# devenv:requires=[{"infra":"postgres"},{"infra":"script-clock"}]
```

Docker app run Compose file:

```yaml
x-devenv:
  requires: [{"infra":"postgres"},{"infra":"script-clock"}]
services:
  my-service:
    image: my-service:latest
```

DevEnv starts missing infrastructure dependencies before the requested app run target. Stopping an app stops only that app target; shared infrastructure keeps running. Docker Compose `depends_on` is ignored by DevEnv dependency graph construction.

## 5. Differences from apps

Infrastructure services do **not** have:
- Git operations (clone, pull, branch switching)
- Build/test workflows
- Change Request integration
- CI/CD pipeline features

See [Adding a Repository](adding-repositories.md) for full application definitions.

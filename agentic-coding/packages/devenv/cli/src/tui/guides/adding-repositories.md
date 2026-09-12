# Adding a Repository

This guide walks through defining a new repository in DevEnv. Repositories can appear in either the Applications tab or the Libraries tab.

## 1. Create the repository definition

Create a JSON file in one of these locations:

- Application: `~/.config/devenv/apps/definitions/IDENT.json`
- Library: `~/.config/devenv/libraries/definitions/IDENT.json`

The definition shape is the same; location determines destination/type:

```json
{
  "ident": "my-service",
  "displayName": "My Service",
  "repositoryPath": "https://github.com/org/my-service.git",
  "containerBaseName": "my-service",
  "sourceType": "github",
  "provider": "my-github",
  "gitMode": "BRANCH"
}
```

Key fields:

- `ident` — unique identifier, becomes the directory name under `$DEVENV_HOME`
- `repositoryPath` — Git remote URL (HTTPS or SSH)
- `sourceType` — `"github"` or `"gitlab"` for Change Request features
- `provider` — name of the provider from `providers/` for authenticated API access
- `gitMode` — `"BRANCH"` (default) or `"WORKTREE"` for parallel worktrees

## 2. Create Dockerfiles

Place build and test Dockerfiles next to the selected destination:

- Application: `~/.config/devenv/apps/build/IDENT-build.Dockerfile`
- Application: `~/.config/devenv/apps/build/IDENT-test.Dockerfile`
- Library: `~/.config/devenv/libraries/build/IDENT-build.Dockerfile`
- Library: `~/.config/devenv/libraries/build/IDENT-test.Dockerfile`

**Build Dockerfile** produces a runnable image and can extract artifacts. Use `LABEL devenv.artifacts="PATH"` to declare build output:

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM debian:bookworm-slim
LABEL devenv.artifacts="dist"
WORKDIR /app
COPY --from=build /app/dist ./dist
```

**Test Dockerfile** runs ephemerally — build succeeding = tests pass:

```dockerfile
FROM golang:1.26-bookworm
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./...
```

## 3. Configure Compose

For applications, create a Docker Compose file for running the app:

```
~/.config/devenv/apps/compose/IDENT-compose.yml
```

Libraries normally use build/test workflows and do not need compose run targets.

```yaml
x-devenv:
  requires: [{"infra":"postgres"},{"app":"api","runtime":"systemshell","profile":"dev"}]
services:
  my-service:
    image: devenv-my-service:latest
    ports:
      - "3000:3000"
    env_file:
      - .env
```

For profile variants, use `IDENT-PROFILE-compose.yml` (e.g., `my-service-staging-compose.yml`). `x-devenv.requires` is optional and declares DevEnv-run dependencies for this Docker run target. Docker Compose `depends_on` is not used for DevEnv dependency orchestration.

## 4. Add shell action variants

Shell actions live next to Docker resources and can coexist with them:

- Application build/test: `~/.config/devenv/apps/build/IDENT-build.sh`, `~/.config/devenv/apps/build/IDENT-test.sh`
- Application run profile: `~/.config/devenv/apps/run/IDENT-PROFILE.sh`
- Library build/test: `~/.config/devenv/libraries/build/IDENT-build.sh`, `~/.config/devenv/libraries/build/IDENT-test.sh`

Example run profile:

```sh
#!/usr/bin/env sh
# devenv:name=Dev Server
# devenv:mode=tmux
# devenv:requires=[{"app":"api","runtime":"systemshell","profile":"dev"},{"infra":"postgres"}]
set -eu
bun run dev
```

PowerShell run profiles use `~/.config/devenv/apps/run/IDENT-PROFILE.ps1` and support the same metadata comments.

`systemshell` is a portable run runtime: DevEnv uses `.ps1` on Windows and `.sh` on macOS/Linux. It is strict: missing platform script fails instead of falling back. Docker `dev`, shell `dev`, PowerShell `dev`, and systemshell `dev` are separate targets.

Metadata:

- `devenv:name` controls picker label.
- `devenv:mode=tmux` opens run scripts in a new tmux window.
- `devenv:requires=[...]` declares DevEnv dependencies as inline JSON.
- Build/test shell scripts default to logged execution.
- Run shell scripts default to tmux.

Tmux mode requires the DevEnv server process to run inside tmux. Attach mode connected to a server without `TMUX` will fail clearly instead of launching hidden background processes. Stop/restart target the tracked tmux window id.

## 5. Link to infrastructure or other apps

Use DevEnv metadata, not Docker Compose `depends_on`:

```sh
# devenv:requires=[{"infra":"postgres"},{"app":"worker","runtime":"docker","profile":"dev"}]
```

App dependency refs require `app`, `runtime`, and `profile`; they always target run actions. Infra refs require `infra`. DevEnv starts missing dependencies before the requested target and leaves them running when you stop the requested target.

This is a breaking change for configs that relied on Compose `depends_on` as DevEnv dependency source. No migration or compatibility shim exists; update configs manually to `devenv:requires` or `x-devenv.requires`.

## 6. Add from the TUI

Alternatively, press `+` in the TUI table view to add a repository interactively — select provider, choose Applications or Libraries as destination, search for a repository, name it, and choose a branch.

See [Effective Docker Builds](effective-docker-builds.md) for fast Dockerfiles that work with Docker and Podman. See [Adding Infrastructure](adding-infrastructure.md) for shared services and [Adding Libraries](adding-libraries.md) for library definitions.

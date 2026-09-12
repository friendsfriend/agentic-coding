# Adding Libraries

Libraries use the same definition schema as apps, but their type is derived from their definition location under `libraries/definitions/`. They appear in the **Libraries** tab of the TUI.

## 1. Create the library definition

Create a JSON file at `~/.config/devenv/libraries/definitions/IDENT.json`:

```json
{
  "ident": "shared-lib",
  "displayName": "Shared Library",
  "repositoryPath": "https://github.com/org/shared-lib.git",
  "provider": "my-github"
}
```

Libraries support:
- Git operations — clone, pull, push, fetch, branch switching, worktree management
- Docker build (`B`) and test
- Full Change Request workflow
- CI/CD pipeline jobs, logs, test results
- Action history

Libraries do **not** support running containers or container logs since they are not deployed as services.

## 2. Build Dockerfile

Place at `~/.config/devenv/apps/build/IDENT-build.Dockerfile`:

```dockerfile
FROM golang:1.26-bookworm AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o bin/my-lib .
```

## 3. Test Dockerfile

Place at `~/.config/devenv/apps/build/IDENT-test.Dockerfile`:

```dockerfile
FROM golang:1.26-bookworm
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... -v
```

## 4. Using libraries in the TUI

- Switch to the **Libraries** tab (press `3` or Tab to cycle)
- Use `s`/`S`/`R` is not available (no container lifecycle)
- Use `B` to build the library
- Use `m`/`M` for Change Request workflow
- Use uppercase `L` for action history and lowercase `l` for runtime logs

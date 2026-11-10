# Effective Docker Builds

DevEnv build targets use your app Dockerfile with the configured container runtime (`docker` or `podman`). Fast builds come from cache-friendly Dockerfiles, small build contexts, and runtime-compatible BuildKit features.

## How DevEnv builds

For Docker, DevEnv enables BuildKit and reuses the previous app image as cache:

```sh
DOCKER_BUILDKIT=1 docker build --cache-from devenv-IDENT:latest --build-arg BUILDKIT_INLINE_CACHE=1 ...
```

For Podman, DevEnv does not use BuildKit. It probes `podman build --help` and only adds supported cache flags such as `--layers` or `--cache-from`.

Your Dockerfile should still work without Docker-only features unless you only use Docker.

## Start with stable dependency layers

Copy lockfiles before source files so dependency install layers survive code edits:

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build
```

Avoid this pattern because every source change invalidates dependency install:

```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY . .
RUN bun install
RUN bun run build
```

Same idea for Go:

```dockerfile
FROM golang:1.26-bookworm AS build
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build ./...
```

## Keep build context small

Add a project `.dockerignore` next to your source checkout. Large contexts slow Docker and Podman before build even starts.

```gitignore
.git
node_modules
dist
coverage
.tmp
*.log
.DS_Store
```

For Go projects:

```gitignore
.git
bin
dist
coverage
*.test
```

For frontend projects:

```gitignore
.git
node_modules
dist
build
coverage
.cache
```

## Handle workspaces and monorepos

If `package.json` declares workspaces, copy each workspace manifest before installing. Package managers need those files to resolve the workspace graph.

```dockerfile
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
COPY shared/package.json ./shared/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
RUN bun run build
```

Do not copy only the root `package.json` when it contains workspaces like `"./server"`, `"./client"`, or `"./shared"`; Bun will fail with `Workspace not found`.

If install lifecycle scripts need source files (`postinstall`, `prepare`, generated types, TypeScript builds), skip them in the dependency-cache layer and run the real build after copying source:

```dockerfile
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build
```

Without `--ignore-scripts`, `bun install` may run `postinstall` before `tsconfig.json` or workspace source files exist.

## Use cache mounts when available

Cache mounts speed repeated installs and compiles. They work with Docker BuildKit and recent Podman/Buildah versions.

Bun example:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM oven/bun:1 AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY . .
RUN bun run build
```

Go example:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /app

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build ./...
```

If your Podman version rejects `RUN --mount=type=cache`, remove those mounts. Dockerfile will be slower but portable.

## Use multi-stage builds

Keep build tools out of final images and make artifact extraction predictable:

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM debian:bookworm-slim
LABEL devenv.artifacts="dist"
WORKDIR /app
COPY --from=build /app/dist ./dist
```

`LABEL devenv.artifacts="dist"` tells DevEnv which path to copy out after the image build.

## Pin images and avoid moving package indexes

Use stable base image tags:

```dockerfile
FROM golang:1.26-bookworm
```

Avoid broad package upgrades during every build:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates
```

If you need OS packages, put them before source `COPY` so they cache well:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
```

## Prefer deterministic package commands

Use lockfile/frozen install modes:

```dockerfile
RUN bun install --frozen-lockfile
RUN npm ci
RUN yarn install --frozen-lockfile
RUN pnpm install --frozen-lockfile
RUN go mod download
```

Do not write commands that mutate dependency files during normal builds.

## Docker and Podman compatibility checklist

Use:

- standard Dockerfile syntax when possible
- `# syntax=docker/dockerfile:1.7` only when using BuildKit-style mounts
- cache mounts only if your Podman version supports them
- cache-friendly `COPY lockfiles -> install -> COPY source` order
- `.dockerignore` in each repository
- multi-stage builds for small final images

Avoid:

- Docker-only CLI behavior inside Dockerfiles
- relying on `DOCKER_BUILDKIT` when runtime is Podman
- copying whole repo before dependency install
- downloading dependencies after every source edit
- putting secrets directly in Dockerfiles

## Quick templates

### Bun app

```dockerfile
# syntax=docker/dockerfile:1.7
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM debian:bookworm-slim
LABEL devenv.artifacts="dist"
WORKDIR /app
COPY --from=build /app/dist ./dist
```

### Go app

```dockerfile
# syntax=docker/dockerfile:1.7
FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /out/app ./cmd/app

FROM debian:bookworm-slim
LABEL devenv.artifacts="/out"
COPY --from=build /out /out
```

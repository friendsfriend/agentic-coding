# Container Runtime Guide

DevEnv supports Docker and Podman for Docker-based app and infrastructure features.

Set the runtime in your local config `.env` file:

```bash
# ~/.config/devenv/.env
DEVENV_CONTAINER_RUNTIME=docker
```

`docker` is the default when `DEVENV_CONTAINER_RUNTIME` is unset.

Do not commit `.env`; runtime choice is machine-local.

## Use Docker

1. Start Docker Desktop or Docker Engine.
2. Configure DevEnv:

```bash
cat >> ~/.config/devenv/.env <<'EOF'
DEVENV_CONTAINER_RUNTIME=docker
EOF
```

3. Restart DevEnv.

DevEnv checks Docker at startup. If Docker is not installed or server is not running, startup fails with a container runtime error.

## Use Podman

1. Start Podman service or machine.

macOS example:

```bash
podman machine start
```

Linux rootless example:

```bash
systemctl --user start podman.socket
```

2. Configure DevEnv:

```bash
cat >> ~/.config/devenv/.env <<'EOF'
DEVENV_CONTAINER_RUNTIME=podman
EOF
```

3. Restart DevEnv.

DevEnv uses the Podman-compatible Docker API socket for status, logs, stats, and lifecycle operations. Build, cp, and inspect commands use the `podman` CLI. Compose operations use `podman-compose`.

If your Podman socket is custom, set:

```bash
DEVENV_CONTAINER_RUNTIME=podman
DEVENV_PODMAN_HOST=unix:///path/to/podman.sock
```

`DOCKER_HOST` also works for Podman if `DEVENV_PODMAN_HOST` is unset.

Docker runtime uses `docker` plus `docker-compose`. Podman runtime uses `podman` plus `podman-compose`.

See [Effective Docker Builds](effective-docker-builds.md) for writing fast build Dockerfiles that stay compatible with both runtimes.

## Behavior

- DevEnv never auto-switches between Docker and Podman.
- Configured runtime must be available and running.
- If neither setting exists, DevEnv uses `docker`.
- If configured runtime is unavailable, startup and runtime-dependent commands fail.

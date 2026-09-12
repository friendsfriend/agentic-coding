# Kubernetes Runtime

DevEnv can run app and infrastructure targets as Helm releases on one managed local `kind` cluster. It is intended for production-like local development: build/load an app image, install Helm releases, show pod-based status, expose logs, and optionally open `k9s`.

## Prerequisites

Install:

- `kind`
- `kubectl`
- `helm`
- selected container runtime: `docker` or `podman`
- optional: `k9s` for cluster inspection from the TUI (`9` key)

macOS with Homebrew:

```sh
brew install kind kubectl helm k9s
# plus one runtime:
brew install --cask docker
# or:
brew install podman
podman machine init
podman machine start
```

Set runtime with `DEVENV_CONTAINER_RUNTIME=docker` or `DEVENV_CONTAINER_RUNTIME=podman`. Podman uses kind's `KIND_EXPERIMENTAL_PROVIDER=podman` environment for cluster and image-load commands. DevEnv sets this for its own kind calls; use it manually for one-off kind commands:

```sh
KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name devenv
```

DevEnv always targets managed context `kind-devenv`. It never uses your current kube context for app/infra lifecycle commands.

## Cluster management tab

The Kubernetes tab shows the managed kind cluster state, provider, context, Kubernetes version, nodes, pod counts, namespaces, DevEnv Helm releases, and Docker/Podman node resource stats when available.

Cluster controls live in the footer/help keybinds:

- `s`: create/start the managed cluster and export kubeconfig
- `S`: delete/stop the managed cluster after confirmation
- `R`: recreate the cluster after confirmation
- `r`: refresh cluster status
- `e`: export kubeconfig for `kind-devenv`
- `9`: open `k9s --context kind-devenv`

Delete/stop runs `kind delete cluster --name devenv`. This is destructive: all in-cluster namespaces, workloads, volumes, and DevEnv Helm releases are removed. After successful deletion DevEnv stops tracked Kubernetes port-forwards, clears cached Kubernetes app run state, refreshes Kubernetes infrastructure/app status, and broadcasts updates so stopped state appears in the TUI.

Lazy creation still works: starting a Kubernetes app or infrastructure target creates the managed cluster if missing and reuses it if already running. Explicitly creating the cluster first is optional.

Custom kind config, node sizing, registry mirrors, and cluster resource setup are not part of this release and remain future work.

## Using the runtime

Typical flow:

1. Build the app normally with the DevEnv build target. This creates the local app image, for example `devenv-bhvr-site:latest` or `localhost/devenv-bhvr-site:latest` with Podman.
2. Run the Kubernetes target. DevEnv ensures kind exists, starts dependencies, loads the existing image into kind, uninstalls the previous app release, and installs the Helm chart.
3. Press `9` to open `k9s --context kind-devenv`.

When running inside tmux, `9` opens k9s in a new tmux window. Outside tmux, DevEnv suspends the TUI and runs k9s in the same terminal, like lazygit.

## Status display

Kubernetes app and infrastructure status is pod based:

- `running (N/N pods)`
- `starting (N/M pods)`
- `failed (N/M pods)`
- `stopped (0 pods)`

DevEnv discovers Kubernetes targets at startup and watches pod events with `kubectl --watch-only`, so pod changes update the TUI through normal server-sent events. A one-shot status check also runs after restart so already-running Helm releases are restored in the UI.

## App target discovery

DevEnv discovers Helm charts from app checkout paths:

- `Chart.yaml`
- `chart/Chart.yaml`
- `helm/Chart.yaml`
- `deploy/helm/Chart.yaml`
- `charts/*/Chart.yaml`

Config directory targets live under:

```text
apps/k8s/<app-ident>/devenv.k8s.json
apps/k8s/<app-ident>/values.yaml
```

If `devenv.k8s.json` exists, DevEnv uses explicit targets from that file and does not add an extra implicit target for the config-dir chart. Config values override repository defaults. Helm install order is: chart values, config values, generated `--set-string` image values.

## `devenv.k8s.json`

Example using an existing image produced by the normal DevEnv build target:

```json
{
  "targets": [
    {
      "profile": "local",
      "name": "Kubernetes Local (kind)",
      "chart": { "path": "$CONFIG/apps/k8s/my-app/chart" },
      "values": ["$CONFIG/apps/k8s/my-app/values.yaml"],
      "release": "my-app-local",
      "namespace": "apps",
      "image": {
        "repository": "my-app",
        "tag": "latest",
        "pullPolicy": "IfNotPresent",
        "valuePaths": {
          "repository": "image.repository",
          "tag": "image.tag",
          "pullPolicy": "image.pullPolicy"
        }
      },
      "secrets": [{ "name": "my-app-env", "keys": ["DB_USER", "DB_PASS"] }],
      "ports": [{ "name": "http", "resource": "svc/my-app", "localPort": 8080, "remotePort": 80 }],
      "requires": [{ "infra": "postgres-k8s", "runtime": "kubernetes", "profile": "local" }],
      "wait": { "timeout": "5m" }
    }
  ]
}
```

If you want the Kubernetes run itself to build an image, add `image.build`:

```json
"build": { "context": "$APP", "dockerfile": "$CONFIG/apps/build/my-app-build.Dockerfile" }
```

When the Dockerfile is outside the app checkout, DevEnv copies it into the checkout temporarily before running the build so Docker/Podman can access it.

Path variables:

- `$APP`: app checkout directory
- `$CONFIG`: DevEnv config directory

Secrets use explicit `.env` key allowlists. DevEnv validates keys before Helm install and logs only Secret names/key names, never values.

## Kubernetes infrastructure

Define Helm-backed infrastructure in `infrastructure/definitions/<ident>.json`:

```json
{
  "ident": "postgres-k8s",
  "displayName": "Postgres (Kubernetes)",
  "type": "kubernetes",
  "kubernetes": {
    "profile": "local",
    "chartPath": "$CONFIG/infrastructure/k8s/postgres",
    "release": "postgres-local",
    "namespace": "infra",
    "values": ["$CONFIG/infrastructure/k8s/postgres/values.yaml"],
    "wait": true,
    "timeout": "5m"
  }
}
```

Manual start installs release when stopped. Dependency startup skips already-running infrastructure only when matching pods are running; a stale Helm release with no pods is reset and reinstalled. Manual stop uninstalls the infrastructure release, so next start is fresh.

## Dependencies and mixing runtimes

Kubernetes app targets can depend on:

- Kubernetes app targets: `{ "app": "api", "runtime": "kubernetes", "profile": "local" }`
- Kubernetes infrastructure: `{ "infra": "postgres-k8s", "runtime": "kubernetes", "profile": "local" }`
- Existing Docker/script infrastructure via bare infra refs: `{ "infra": "postgres" }`

So yes, DevEnv can start Docker-based infrastructure and then run an app in Kubernetes. Example:

```json
"requires": [{ "infra": "postgres" }]
```

Caveat: DevEnv starts the Docker container, but it does not automatically make Docker Compose services reachable from inside the kind cluster. Your Helm values/chart must point the app at a host-reachable address and port for that container. Depending on runtime/platform, that may be `host.docker.internal`, `host.containers.internal`, or another kind/Podman host gateway. For reliable production-like setups, prefer Kubernetes infrastructure (`type: "kubernetes"`) so apps and dependencies share cluster networking.

Stopping a Kubernetes app only uninstalls that app release and stops its port-forwards. Dependencies keep running until stopped directly from the infrastructure view.

## Logs and troubleshooting

- Press `s` while a run/start is active to open the live action command log.
- Press `9` to open k9s for the managed cluster.
- Use action history (`L`) to inspect full command output (`kind`, `helm`, `kubectl`, Docker/Podman).
- Podman kind command issue: some `kind get clusters` calls can fail with a Podman template error; DevEnv falls back to create/export kubeconfig and continues when the node already exists.
- Missing tool: install `kind`, `kubectl`, `helm`, Docker/Podman, or `k9s`.
- Podman cluster issues: verify `podman machine start`, `podman ps`, and `DEVENV_CONTAINER_RUNTIME=podman`.
- Helm timeout: check action history, k9s pods/events, and `kubectl --context kind-devenv get events -A`.
- Image not used: verify chart image value paths match chart templates.
- Missing Secret key: add key to config `.env` or remove it from allowlist.

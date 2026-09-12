# Combining Runtimes

DevEnv can run one dependency graph across Docker Compose, Podman Compose, shell commands, scripts, and Kubernetes. Each target declares its runtime, provider, profile, dependencies, and endpoints. DevEnv starts dependencies in order and waits for readiness before starting consumers.

## Pick a runtime

| Runtime | Good for | Requires |
| --- | --- | --- |
| Docker Compose | Existing Docker Compose stacks | Docker daemon and `docker compose` |
| Podman Compose | Rootless/local Compose stacks | Podman socket and `podman-compose` |
| Shell or tmux | Hot-reload dev servers and host tools | Command, working directory, environment |
| Script infrastructure | Small helpers, tunnels, mocks, migrations | Script command and readiness policy |
| Kubernetes | Helm charts and production-like local topology | Provider, kind, kubectl, Helm, cluster identity |

Use one runtime when possible. Mix runtimes when a boundary is explicit and reachable.

## Declare complete identities

A target is identified by its resource, action, runtime, provider, and profile. Kubernetes targets also need a cluster, kube context, namespace, Helm release, chart, and image identity.

Do not rely on current Docker context, current kube context, an inferred Compose project, or a label. Use unique identities for separate profiles.

```json
{
  "profile": "k8s-local",
  "provider": "podman",
  "cluster": "devenv",
  "context": "kind-devenv",
  "release": "api-local",
  "namespace": "apps"
}
```

Docker kind and Podman kind are separate systems. Do not let both claim same nonlegacy cluster/context pair. Give each provider its own cluster, context, namespace, Helm release, and image archive path.

## Connect runtimes with endpoints

An endpoint producer exports a named public address. A consumer binds it into an environment variable, Compose value, or Helm value. DevEnv publishes an endpoint only after producer readiness.

| Producer → consumer | Use | Address form |
| --- | --- | --- |
| Docker Compose → Docker Compose | `compose-service` | `service:port` |
| Podman Compose → Podman Compose | `compose-service` | `service:port` |
| Kubernetes → Kubernetes in same cluster | `kubernetes-service` | `service.namespace.svc.cluster.local:port` |
| Kubernetes → host shell/script | `port-forward` | `127.0.0.1:localPort` |
| Host shell/script → Kubernetes | `host-published` | host gateway plus published port |
| Docker/Podman Compose → Kubernetes | `host-published` | host gateway plus published port |
| Shell/script → Compose | explicit host endpoint | host address plus port |

Examples:

```text
# Kubernetes Service
postgres.infra.svc.cluster.local:5432

# Kubernetes forwarded to host script
DATABASE_URL=postgres://127.0.0.1:15432

# Host service consumed by Podman kind workload
API_URL=http://host.containers.internal:38006

# Same Podman Compose project
REDIS_URL=redis://redis:6379
```

### Docker and Podman boundary

Docker and Podman do **not** share Compose DNS or networks. A Docker Compose consumer cannot use a Podman producer's `compose-service` address, and vice versa.

Publish producer port to host, then use `host-published`. Choose platform-specific host gateway explicitly, commonly `host.docker.internal` or `host.containers.internal`.

## Dependencies and lifecycle

Use `requires` to identify exact dependency target:

```json
{
  "infra": "postgres-k8s",
  "runtime": "kubernetes",
  "profile": "local",
  "provider": "podman",
  "lifecycle": "shared"
}
```

Lifecycle choices:

| Policy | Behavior |
| --- | --- |
| `shared` | Start once and leave running when consumer stops |
| `owned` | Consumer holds a lease; dependency stops after final owner stops |
| `external` | Never start or stop dependency; validate existing dependency readiness |

DevEnv rejects a manual dependency stop while another active owner depends on it.

## Readiness and action history

A successful launch command is not enough. DevEnv waits for runtime-specific readiness:

- Compose: service/container readiness.
- Shell/script: managed process survives stabilization or endpoint probe succeeds.
- Kubernetes: selected release pods become Ready.
- Port-forward: managed process survives and accepts connections.

Action history records every executed backend command as its own step, including command, stdout, stderr, exit code, and error. Shared dependency references do not duplicate command output.

## Kubernetes workflow

A Kubernetes app run normally:

1. Ensures selected kind cluster exists.
2. Checks and loads image into selected provider's kind cluster.
3. Creates namespace.
4. Installs Helm release.
5. Waits for workload readiness.
6. Starts configured port-forwards.

A Kubernetes restart performs separate actions:

1. Uninstall Helm release with `--ignore-not-found`.
2. Install Helm release.
3. Wait for readiness.

Stopping a Kubernetes target uninstalls only its configured release and ends its managed port-forwards. It must never fall back to Compose `down` while Kubernetes pods are live.

## Cleanup rules

- Stop Compose by its exact project. Do not use global container cleanup.
- Stop Kubernetes by exact context, namespace, and Helm release.
- DevEnv shutdown ends managed port-forwards and processes.
- Preserve tagged local images needed by kind. Prune dangling images/cache/volumes only; never use image prune `--all` or `podman builder prune --all`.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Consumer cannot resolve service | Confirm same provider/runtime or use `host-published` |
| Kubernetes cannot reach host service | Confirm port is published and Helm value uses reachable host gateway |
| Kubernetes action unavailable | Install/start provider plus `kind`, `kubectl`, and `helm` |
| Helm release is stale | Inspect action history and pod events; stop target then run again |
| Stop selects wrong runtime | Confirm live pod status and target identity; Kubernetes workload status wins |
| Endpoint missing | Check producer export name, dependency selector, destination, and readiness |

Prefer same-provider Compose DNS or cluster-local Kubernetes Services. Use host-published endpoints and port-forwards only at intentional runtime boundaries.

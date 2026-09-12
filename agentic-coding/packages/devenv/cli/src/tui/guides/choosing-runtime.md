# Choosing a Runtime

DevEnv supports several ways to run apps and infrastructure locally. Pick the one that matches what you want to validate.

## Quick recommendation

- Use **Docker Compose** when you want fast local service orchestration and your project already has Compose files.
- Use **Kubernetes** when you want to validate Helm charts, image values, namespaces, Secrets, and pod behavior close to production.
- Use **shell/tmux scripts** when you need maximum flexibility or your run command is already a local dev command.
- Use **script infrastructure** for small helper processes that are not containers.

## Docker Compose app runs

Best for:

- Fast inner-loop development.
- Apps already packaged with Compose.
- Teams that use Docker Compose as local standard.
- Local infrastructure that should run as normal host containers.

Trade-offs:

- Less similar to production Kubernetes.
- Compose networking and lifecycle differ from Helm/Kubernetes.
- Scaling/status maps to containers, not pods.

Use when:

```text
apps/compose/<app>-compose.yml
apps/compose/<app>-dev-compose.yml
```

Dependency example:

```json
{ "infra": "postgres" }
```

## Kubernetes app runs

Best for:

- Validating Helm charts locally.
- Catching image value, namespace, Secret, Service, and pod issues before production.
- Production-like app/infrastructure topology.
- Teams deploying primarily through Helm.

Trade-offs:

- Slower than Docker Compose due to kind, image load, and Helm wait.
- Requires `kind`, `kubectl`, `helm`, and Docker/Podman.
- More moving parts; use `k9s` and action history for diagnostics.

Use when:

```text
apps/k8s/<app>/devenv.k8s.json
apps/k8s/<app>/chart/
```

Dependency example:

```json
{ "infra": "postgres-k8s", "runtime": "kubernetes", "profile": "local" }
```

## Shell/tmux app runs

Best for:

- Framework dev servers (`bun dev`, `npm run dev`, `go run`, etc.).
- Hot reload workflows.
- Non-containerized local tools.
- Quick scripts before formalizing Docker/Kubernetes config.

Trade-offs:

- Least production-like.
- Environment drift depends on host machine.
- Status is based on tracked tmux/process state.

Use when:

```text
apps/run/<app>-dev.sh
apps/run/<app>-dev.ps1
```

Metadata example:

```sh
# devenv:name=Dev Server
# devenv:mode=tmux
# devenv:requires=[{"infra":"postgres"}]
```

## Infrastructure choices

### Docker infrastructure

Use for common local databases/caches when container networking from host apps is enough.

```text
infrastructure/definitions/postgres.json
infrastructure/compose/postgres-compose.yml
```

Good with:

- Docker Compose app runs.
- Shell/tmux app runs.
- Kubernetes app runs only if app chart can reach host/container service address.

### Kubernetes infrastructure

Use when Kubernetes apps need cluster-local dependencies, or when you want Helm lifecycle and pod status for infra too.

```text
infrastructure/definitions/postgres-k8s.json
infrastructure/k8s/postgres/
```

Good with:

- Kubernetes app runs.
- Production-like local stacks.
- Scaling/Pod status checks.

### Script infrastructure

Use for helper daemons, mock services, clocks, file watchers, tunnels, or commands that do not fit containers.

```json
{
  "ident": "script-clock",
  "type": "script",
  "shellPath": ".../script-clock.sh"
}
```

## Can I mix runtimes?

Yes.

Examples:

- Shell app + Docker postgres.
- Docker Compose app + script helper.
- Kubernetes app + Kubernetes postgres.
- Kubernetes app + Docker postgres.

For Kubernetes app + Docker infra, DevEnv starts both, but networking is your responsibility. The Kubernetes app runs inside kind. The Docker/Podman container runs outside the cluster. Configure Helm values to reach the host/container service (`host.docker.internal`, `host.containers.internal`, a published port, or another explicit route).

If you want the least surprise, keep Kubernetes apps with Kubernetes infrastructure.

## Decision table

| Goal | Best runtime |
| --- | --- |
| Fast dev server with hot reload | Shell/tmux |
| Existing Compose setup | Docker Compose |
| Validate Helm chart locally | Kubernetes |
| Local DB/cache for host or Compose apps | Docker infrastructure |
| Cluster-local DB/cache for Kubernetes apps | Kubernetes infrastructure |
| Mock daemon/helper process | Script infrastructure |
| Production-like local stack | Kubernetes app + Kubernetes infra |

## Operational shortcuts

- `s`: start/run selected item.
- `S`: stop selected item.
- `9`: open `k9s --context kind-devenv`.
- Press `s` during an active operation to open live action logs.
- Action history shows full commands and output for build/run/start/stop actions.

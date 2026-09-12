# Cross-runtime endpoint strategies

Supported contracts:

| Producer / consumer | Strategy | Address form |
|---|---|---|
| Kubernetes → Kubernetes | `kubernetes-service` | `<service>.<namespace>.svc.cluster.local:<port>` |
| Kubernetes → host | `port-forward` | `127.0.0.1:<localPort>` |
| Compose → same-provider Compose | `compose-service` | service DNS name and container port |
| Host/Kubernetes → host container | `host-published` | configured host address and published port |

Docker and Podman networks are separate. Direct `compose-service` bindings across providers are rejected; use `host-published` instead.

Endpoint exports become action values under `endpoint.<name>`. Consumers bind them to `env`, `compose`, or `helm` destinations. Endpoint values are published only after producer readiness and are not secret values unless future secret-specific endpoint support is added.

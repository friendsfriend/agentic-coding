# Spec Delta

## Purpose

Opt-in, concurrent per-instance deployments into the shared kind cluster for
bugs that need several replicas.

## ADDED Requirements

### Requirement: Per-instance Kubernetes deployment

An agent-owned Kubernetes instance SHALL deploy into its own namespace with an instance-suffixed Helm release and an image tagged with its instance id loaded into the shared cluster, and SHALL expose its ports through port-forwards on allocated host ports.

#### Scenario: Two workflows deploy one chart

- **WHEN** two workflow instances of the same Kubernetes target start
- **THEN** they SHALL run in distinct namespaces with distinct releases, images and host ports

### Requirement: Kubernetes is explicit opt-in

A Kubernetes target SHALL start only when explicitly requested and SHALL count against `max_kubernetes`; a missing cluster SHALL fail with `cluster-unavailable` and SHALL NOT be created implicitly.

#### Scenario: Cluster absent

- **WHEN** an agent requests a Kubernetes instance and the `devenv` cluster does not exist
- **THEN** the start SHALL fail with `cluster-unavailable`

### Requirement: Replicas are configurable

A Kubernetes start SHALL accept a replica count and apply it through the configured Helm value path.

#### Scenario: Three replicas

- **WHEN** an agent starts a Kubernetes instance with `replicas: 3`
- **THEN** Helm SHALL receive `--set replicaCount=3` unless the target configures another value path

### Requirement: Removal cleans the cluster

Removing a Kubernetes instance SHALL uninstall its release and delete its namespace; image removal from the node SHALL be best-effort and SHALL NOT fail the removal.

#### Scenario: Image removal fails

- **WHEN** removing the instance image from the kind node fails
- **THEN** the instance SHALL still be removed and the failure logged

# Spec Delta

## Purpose

Agents can run an app in the shared kind cluster with several replicas, on
explicit request only, for problems that need concurrency.

## ADDED Requirements

### Requirement: Kubernetes runs are explicit and use the app slot

A Kubernetes target SHALL start only when explicitly requested, SHALL hold the app's single slot like any other runtime, and SHALL use the target's static release, namespace and port-forward ports.

#### Scenario: Implicit start

- **WHEN** an agent starts an app with Docker and Kubernetes targets without naming a runtime
- **THEN** the Docker target SHALL be started

### Requirement: Replicas are configurable

A Kubernetes start SHALL accept a replica count and apply it through the configured Helm value path.

#### Scenario: Three replicas

- **WHEN** an agent starts a Kubernetes run with `replicas: 3`
- **THEN** Helm SHALL receive `--set replicaCount=3` unless the target configures another value path

### Requirement: Cluster is a precondition

A Kubernetes start SHALL fail with `cluster-unavailable` when the configured cluster does not exist and SHALL NOT create it.

#### Scenario: Cluster absent

- **WHEN** an agent requests a Kubernetes run and the `devenv` cluster does not exist
- **THEN** the start SHALL fail with `cluster-unavailable`

### Requirement: Stop cleans up the release

Stopping a Kubernetes run SHALL uninstall its Helm release and stop its port-forwards before releasing the app slot.

#### Scenario: Stop

- **WHEN** an agent stops its Kubernetes run of `customer-mw`
- **THEN** the release SHALL be uninstalled and the `customer-mw` slot granted to the next waiter

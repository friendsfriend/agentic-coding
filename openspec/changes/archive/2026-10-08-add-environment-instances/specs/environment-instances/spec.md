# Spec Delta

## Purpose

Owner-scoped, concurrent copies of configured app run targets with stable
identity, allocated ports and per-instance naming, so several workflows can run
the same app from different checkouts at once.

## ADDED Requirements

### Requirement: Environment instances are owned and persisted

The environment server SHALL represent every started run target as an environment instance with an owner (`user` or `workflow:<id>`), an app, a run target, a checkout path, an image tag and a status, persisted in the environment state database. At most one instance SHALL exist per owner and app.

#### Scenario: Repeated start returns the existing instance

- **WHEN** an owner starts an app that already has a running instance for that owner
- **THEN** the server SHALL return the existing instance with outcome `already-running`
- **AND** it SHALL NOT start a second copy

#### Scenario: Two workflows run the same app

- **WHEN** `workflow:a` and `workflow:b` each start `customer-mw`
- **THEN** two instances with distinct instance ids, compose projects, image tags and host ports SHALL exist
- **AND** each SHALL run from its own workflow's checkout path

### Requirement: Template variables are resolved per instance

The server SHALL provide `AC_INSTANCE`, `AC_OWNER`, `AC_APP_DIR`, `AC_IMAGE_TAG` and one `AC_PORT_<NAME>` per port name referenced by the target definition to the compose CLI or script process of the instance. Agent-owned instances SHALL receive ports allocated from the configured port range; the `user` instance SHALL receive no allocated port so the definition's `:-default` applies.

#### Scenario: User instance keeps default ports

- **WHEN** the user starts a templated target declaring `${AC_PORT_HTTP:-8080}`
- **THEN** the app SHALL be published on host port 8080 and `AC_IMAGE_TAG` SHALL be `latest`

#### Scenario: Port range exhausted

- **WHEN** an agent-owned start needs a port and none is free in the range
- **THEN** the start SHALL fail with a typed `port-unavailable` error and no instance SHALL be persisted as running

### Requirement: Untemplated targets are user-only

A run target that hardcodes `container_name` or includes infrastructure compose files SHALL be startable only as the `user` instance.

#### Scenario: Agent starts an untemplated target

- **WHEN** a `workflow:<id>` owner starts an untemplated target
- **THEN** the server SHALL refuse with a typed `untemplated-target` error naming the offending construct

### Requirement: Agent-owned starts prefer Docker

When an agent-owned start names no target, the server SHALL choose the first available runtime in the order Docker compose, then script, and SHALL NOT choose Kubernetes implicitly.

#### Scenario: App has compose and kind targets

- **WHEN** an agent starts an app with a Docker compose and a Kubernetes target without naming one
- **THEN** the Docker compose target SHALL be started

### Requirement: Observation failure is not absence

On server start the persisted instances SHALL be reconciled with runtime observation; an instance whose runtime cannot be observed SHALL be reported as `unknown` and SHALL NOT be marked stopped or have its ports freed.

#### Scenario: Container runtime unavailable at startup

- **WHEN** the server starts while the Docker socket is unreachable
- **THEN** persisted running instances SHALL be reported `unknown` and keep their port allocations

# Spec Delta

## Purpose

Each configured app runs at most once at a time with its static routing and
ports. Owners take turns through a FIFO wait, and the developer is notified
about waits and grants.

## MODIFIED Requirements

### Requirement: Environment instances are owned and persisted

The environment server SHALL represent the running copy of an app as an environment instance with an owner (`user` or `workflow:<id>`), an app, a run target, a checkout path and a status, persisted in the environment state database. At most one instance SHALL exist per app across all owners, and all runs of one workflow SHALL share that workflow's instance.

#### Scenario: Repeated start returns the existing instance

- **WHEN** an owner starts an app that already has a running instance for that owner
- **THEN** the server SHALL return the existing instance with outcome `already-running`
- **AND** it SHALL NOT start a second copy

#### Scenario: Second workflow requests a held app

- **WHEN** `workflow:a` holds `customer-mw` and `workflow:b` starts `customer-mw`
- **THEN** no second copy SHALL be started
- **AND** `workflow:b` SHALL wait until `workflow:a`'s instance is stopped, then run `customer-mw` from its own checkout

### Requirement: Template variables are resolved per instance

The server SHALL provide `AC_OWNER` and `AC_APP_DIR` to the compose CLI or script process of an instance and SHALL run the definition with its own static names, ports and image references.

#### Scenario: Workflow runs a compose target

- **WHEN** a workflow owner starts a compose target that declares `container_name` and host port `8080:8080`
- **THEN** the app SHALL run under that container name on host port 8080 with `AC_APP_DIR` set to the workflow's checkout

### Requirement: Observation failure is not absence

On server start the persisted instances SHALL be reconciled with runtime observation; an instance whose runtime cannot be observed SHALL be reported as `unknown`, SHALL NOT be marked stopped, and SHALL keep its app occupied.

#### Scenario: Container runtime unavailable at startup

- **WHEN** the server starts while the Docker socket is unreachable
- **THEN** persisted running instances SHALL be reported `unknown` and their apps SHALL remain occupied

## ADDED Requirements

### Requirement: Held apps are waited for in FIFO order

A start for an app held by another owner SHALL wait in a per-app FIFO queue; the start request SHALL long-poll for a bounded time and answer `waiting` with the queue position and holder when the time elapses, and a repeated request by the same owner within the grace period SHALL keep its position.

#### Scenario: Re-poll keeps position

- **WHEN** a waiting owner's long-poll returns `waiting` with position 2 and the owner requests again within the grace period
- **THEN** the owner SHALL still be at position 2 or better

#### Scenario: Grant on stop

- **WHEN** the holder stops the app while one owner waits
- **THEN** the waiting owner's start SHALL proceed and answer `started`

### Requirement: Multi-app requests are all-or-nothing and deadlock-checked

A start naming several apps SHALL be granted only when all of them are free and the request heads every one of their queues, and a request whose wait would close a hold/wait cycle SHALL fail immediately with `deadlock` naming the cycle.

#### Scenario: Crossed holds

- **WHEN** `workflow:a` holds `customer-fe` and waits for `customer-mw`, and `workflow:b` holding `customer-mw` requests `customer-fe`
- **THEN** `workflow:b`'s request SHALL fail with `deadlock` naming both workflows and both apps

### Requirement: Human runs hold the app

An app run target observed running without an agent-held instance SHALL count as held by `user`, and agents SHALL wait for it; a human start of an app held by an agent SHALL be refused naming the holding workflow.

#### Scenario: Agent waits for the developer

- **WHEN** the developer runs `customer-mw` from the TUI and an agent starts `customer-mw`
- **THEN** the agent SHALL wait with holder `user`

### Requirement: Developer can force-release an app

The server SHALL offer a release operation that stops the holder's run and grants the next waiter, and the holder's next operation on that app SHALL report `released-by-developer`.

#### Scenario: Unblock a waiter

- **WHEN** the developer force-releases `customer-mw` held by `workflow:a` while `workflow:b` waits
- **THEN** `workflow:a`'s run SHALL be stopped and `workflow:b` SHALL be granted `customer-mw`

### Requirement: Waits and grants are notified

The server SHALL publish an `environment.slot.waiting` event once per new queue entry and an `environment.slot.granted` event per grant, and the shell SHALL show a toast naming the app, the waiting or granted owner, and the holder.

#### Scenario: Workflow starts waiting

- **WHEN** a workflow starts waiting for `customer-mw` held by the developer
- **THEN** the shell SHALL show a toast that the workflow waits for `customer-mw` held by you

## REMOVED Requirements

### Requirement: Untemplated targets are user-only

**Reason**: Apps run once at a time with their static definitions, so fixed container names and ports are valid for every owner.

**Migration**: None. Definitions keep working unchanged, and the `untemplated-target` error is no longer produced.

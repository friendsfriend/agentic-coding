# Spec Delta

## Purpose

Agent-owned instances are bounded in number and lifetime: removed with their
owner or when idle, and queued when the machine is at capacity.

## ADDED Requirements

### Requirement: Owner-bound teardown

When a workflow is closed or deleted, the engine SHALL remove every instance owned by that workflow through a durable `environment.teardown` effect; an unreachable environment server SHALL be retried and SHALL NOT be recorded as a completed removal.

#### Scenario: Workflow deleted

- **WHEN** a workflow with two running instances is deleted
- **THEN** both instances and their provisioned schemas SHALL be removed

### Requirement: Idle instances are reaped

Agent-owned instances idle longer than the configured TTL SHALL be removed; instances in `unknown` state and `user` instances SHALL NOT be reaped.

#### Scenario: Forgotten instance

- **WHEN** an agent-owned instance has no activity for longer than `idle_ttl_minutes`
- **THEN** the reaper SHALL remove it

### Requirement: Capacity caps queue starts

An agent-owned start that would exceed `max_total`, or `max_kubernetes` for a Kubernetes target, SHALL be queued FIFO and answered with its queue position; removing an instance SHALL promote queued starts that now fit. `user` instances SHALL NOT count against the caps.

#### Scenario: Seventh instance

- **WHEN** six agent-owned instances run and a seventh start arrives with the default cap
- **THEN** the start SHALL be answered `queued` with position 1
- **AND** it SHALL start once one of the six is removed

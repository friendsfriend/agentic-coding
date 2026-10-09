# Spec Delta

## Purpose

Agent-held apps are released when their workflow ends or when they sit idle,
so waiting workflows always make progress.

## ADDED Requirements

### Requirement: Owner-bound release

When a workflow is closed or deleted, the engine SHALL stop every app held by that workflow through a durable `environment.teardown` effect; an unreachable environment server SHALL be retried and SHALL NOT be recorded as a completed release.

#### Scenario: Workflow deleted while another waits

- **WHEN** a workflow holding `customer-mw` is deleted while another workflow waits for `customer-mw`
- **THEN** `customer-mw` SHALL be stopped and granted to the waiting workflow

### Requirement: Idle agent-held apps are released

Agent-held apps idle longer than the configured TTL SHALL be stopped and released, with a reap event published; apps in `unknown` state, apps held by `user`, and apps held by an owner that is currently waiting for other apps SHALL NOT be reaped.

#### Scenario: Forgotten app

- **WHEN** an agent-held app has no activity for longer than `idle_ttl_minutes`
- **THEN** the reaper SHALL stop it, release the slot and publish `environment.slot.reaped`

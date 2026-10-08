# Spec Delta

## Purpose

The developer sees which instances run for whom, what is queued, and can stop
agent instances from the Environments feature.

## ADDED Requirements

### Requirement: Instances and queue are listed live

The Environments feature SHALL list instances grouped by owner with app, runtime, status, endpoints, idle time and TTL remaining, and queued starts with position, updated from instance events.

#### Scenario: Agent starts an app

- **WHEN** a workflow agent starts an instance
- **THEN** the view SHALL show it under that workflow without a manual refresh

### Requirement: Stop and navigate

The developer SHALL be able to stop an instance after confirmation and open the owning workflow's dashboard from an instance row.

#### Scenario: Stop agent instance

- **WHEN** the developer confirms stopping an agent-owned instance
- **THEN** the instance SHALL be removed including its provisioned schema

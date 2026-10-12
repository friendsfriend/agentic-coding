# Spec Delta

## Purpose

Give a question raised by an orchestrator-started workflow an owner that always
acts: the orchestrator first, the developer whenever the orchestrator does not.

## ADDED Requirements

### Requirement: Developer questions from orchestrator-started workflows

A developer question created by a run of an orchestrator-started workflow SHALL be routed to the orchestrator session first: the record SHALL carry an orchestrator routing marker, SHALL appear in the orchestrator's workflow observation as an orchestrator question, and SHALL NOT open the developer's question modal while it is unanswered. The orchestrator SHALL be able to answer it or forward it to the developer; forwarding SHALL clear the marker and give the developer a full wait window. While an orchestrator-routed question is pending, the developer SHALL also be able to answer it directly, which clears the marker, so an orchestrator session that is off or idle cannot strand the workflow. A pending orchestrator-routed question SHALL remain visible in the workflow's pending question view so the parked workflow shows what it waits for.

#### Scenario: Question routes to the orchestrator first

- **WHEN** a run of an orchestrator-started workflow creates a developer question
- **THEN** the record SHALL carry the orchestrator routing marker and appear as an orchestrator question
- **AND** the record SHALL NOT appear in the developer's pending developer questions before it is forwarded

#### Scenario: Orchestrator forwards to the developer

- **WHEN** the orchestrator forwards a pending orchestrator-routed question it cannot answer
- **THEN** the marker SHALL be cleared and the wait window reset
- **AND** the question SHALL appear in the developer's pending developer questions

#### Scenario: Developer unblocks an idle orchestrator

- **WHEN** the developer answers a pending orchestrator-routed question while the orchestrator has not answered or forwarded it
- **THEN** the engine SHALL accept the answer, clear the routing marker, and record the developer's answer
- **AND** the asking run SHALL resume under the same rule as a developer-routed question

#### Scenario: Orchestrator question cannot be answered by the wrong actor

- **WHEN** the orchestrator attempts to answer a question that is not routed to it
- **THEN** the engine SHALL reject the answer without changing the question

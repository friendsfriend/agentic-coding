# Spec Delta

## Purpose

The developer sees who holds and who waits for each app, and can unblock a
waiter by force releasing the holder from the Environments feature.

## ADDED Requirements

### Requirement: Slots show holders and waiters live

The Environments feature SHALL list every app that is agent-held or has waiters, with its holder, status, endpoints, idle time and the waiting workflows in queue order, updated from slot events without a manual refresh.

#### Scenario: Workflow starts waiting

- **WHEN** a workflow starts waiting for `customer-mw` held by another workflow
- **THEN** the Slots section SHALL show `customer-mw` with its holder and the waiting workflow at its queue position

### Requirement: Force release and navigation

The developer SHALL be able to force-release an app after a confirmation naming the holder and the next waiter, and SHALL be able to open the dashboard of the holder or of a waiter from the section.

#### Scenario: Unblock a waiter

- **WHEN** the developer confirms force release of `customer-mw`
- **THEN** the holder's run SHALL be stopped and the next waiter SHALL be shown as the holder

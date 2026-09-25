# Spec Delta

## Purpose

Adopts optional upstream Herdr notification controls so a developer-action notification can focus the workflow dashboard on click and agent-finished alerts can be muted without muting workflow notifications.

## ADDED Requirements

### Requirement: Dashboard click target when supported

When the installed Herdr accepts a pane/click target on `notification.show`, Agentic Coding SHALL send the workflow's dashboard pane as that target so clicking the notification focuses the dashboard. When the installed Herdr does not accept a target, Agentic Coding SHALL raise the notification without the field and focus the dashboard at raise time as before.

#### Scenario: Herdr supports a notification target
- **WHEN** the resolved Herdr capability set includes a notification click target and a workflow dashboard pane is available
- **THEN** the notification SHALL carry that pane as its target
- **AND** clicking the notification SHALL focus the workflow dashboard

#### Scenario: Herdr does not support a notification target
- **WHEN** the resolved Herdr capability set has no notification click target
- **THEN** the notification SHALL be raised without a target field
- **AND** the dashboard SHALL still be focused at raise time

### Requirement: Finished-only notification suppression when supported

When the installed Herdr accepts a per-kind or per-agent toast filter, Agentic Coding SHALL document and use it so agent-finished alerts can be muted while developer-action notifications remain enabled. When no filter is available, the documented global Herdr configuration recipe SHALL remain the only supported suppression path, and the documentation SHALL state its whole-toggle limitation.

#### Scenario: Herdr supports a finished-only filter
- **WHEN** the resolved Herdr capability set includes a per-kind or per-agent toast filter and the operator mutes finished alerts
- **THEN** agent-finished toasts SHALL be suppressed
- **AND** developer-action notifications SHALL still be delivered

#### Scenario: No filter is available
- **WHEN** the resolved Herdr capability set has no per-kind or per-agent toast filter
- **THEN** the documentation SHALL state that disabling finished toasts disables all toasts
- **AND** the notification integration SHALL continue to work under any delivery setting that shows toasts

### Requirement: Capability detection and safe degradation

Agentic Coding SHALL detect the supported notification controls from the installed Herdr schema or version and SHALL NOT send fields the installed Herdr does not accept. Detection failure SHALL degrade to the no-target, no-filter behavior instead of failing notification delivery.

#### Scenario: Older Herdr is installed
- **WHEN** the installed Herdr rejects or does not declare the target or filter fields
- **THEN** notification delivery SHALL succeed using the legacy request shape
- **AND** no workflow state SHALL change

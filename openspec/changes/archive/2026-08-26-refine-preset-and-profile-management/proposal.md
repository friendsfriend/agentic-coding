## Why

The shipped configuration hard-codes a large catalog of model-specific profiles and presets, while the dashboard cannot reliably persist profile or preset edits on Linux. A minimal built-in choice must let users choose the agent harness while that harness chooses its own model, without requiring global default profiles.

## What Changes

- Replace the shipped model-specific profiles, routes, and presets with one built-in `use-default-model` preset.
- Make that preset accept a configured harness (`pi`, `opencode`, or `opencode-v2`) while passing no configured model, so the selected harness chooses its default.
- Remove the requirement for a global default profile and permit configuration with no user profiles or presets.
- Update routing and workflow-start selection so the built-in preset is available by default and custom profiles/presets remain opt-in.
- Fix dashboard profile/preset persistence for the resolved Linux configuration target and surface save failures instead of losing edits.
- Update dashboard behavior, documentation, and regression coverage for empty user configuration, the built-in preset, model omission, and create/edit/delete flows.

## Capabilities

### New Capabilities

- `default-model-preset`: Built-in model-agnostic workflow routing with a configurable agent harness.

### Modified Capabilities

- `agent-configuration-presets`: Preset and profile configuration, routing, and dashboard management no longer require or ship global default profiles.

## Impact

Affected areas include `pi/herdr-workflow.toml`, agent configuration parsing and routing, configuration write-back, the dashboard new-workflow and model-configuration modals, their focused tests, and the README configuration guidance for selecting the default preset's harness. No new dependencies or external APIs are required.

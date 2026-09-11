## 1. Ownership extraction

- [ ] 1.1 Confirm unify-terminal-ui-primitives is implemented; read current feature/parity inventory.
- [ ] 1.2 Move repository execution coordinators/application disposal to root-owned application module with no TUI imports.
- [ ] 1.3 Move telemetry receiver/store/watch/retention ownership out of feature components; test hide/show versus root disposal.
- [ ] 1.4 Update architecture checks for extracted ownership without weakening pure-domain or CLI/TUI boundaries.

## 2. Shell and routes

- [ ] 2.1 Implement one AppShell renderer entry with Environments/Workflows/Observability/Wiki top-level tabs.
- [ ] 2.2 Add typed resource routes and per-feature history with cross-feature origin/back restoration tests.
- [ ] 2.3 Integrate environment content and existing app/library/infrastructure/script/Kubernetes sub-tabs.
- [ ] 2.4 Integrate provider/issue/change-request/CI/detail/action-history/agent utility routes without dropping inventory entries.
- [ ] 2.5 Integrate workflow overview/detail/creation/reviews/questions/configuration and retain draft state across tabs.
- [ ] 2.6 Integrate telemetry signal views and Wiki with shared chrome measurements and root-owned services.

## 3. Modal and input ownership

- [ ] 3.1 Implement authoritative modal stack/host with instance IDs, focus restoration and top-overlay mouse ownership.
- [ ] 3.2 Migrate basic dialogs/pickers to stack routes and remove their boolean synchronization paths.
- [ ] 3.3 Migrate workflow review/question/credential and environment action overlays; test nested help and text-entry isolation.
- [ ] 3.4 Register shared global/feature/view/modal/panel keymap fields and central shifted-letter normalization.
- [ ] 3.5 Migrate environment, workflow and observability command handlers/catalog metadata into the single keymap.
- [ ] 3.6 Render footer/help from registrations with standard/short/context semantics; delete raw duplicate dispatchers/catalogs.
- [ ] 3.7 Preserve workflow directional grid and scoped environment panel traversal; test absent panels and Tab ownership.

## 4. Compatibility and acceptance

- [ ] 4.1 Route home/manager/dash entrypoints into the shared shell and remove competing root renderer paths.
- [ ] 4.2 Test tab switches during drains, telemetry arrivals, active dialogs and pending review submissions.
- [ ] 4.3 Replace foreground synchronous child waits with asynchronous spawn/wait and try/finally renderer restoration; test lease renewal/telemetry continue during external tools without leaked input handlers.
- [ ] 4.4 Run feature-inventory journeys, narrow-terminal renderer tests and interactive footer/? help checks.
- [ ] 4.5 Run combined verification and record frontend composition parity without claiming runtime port completion.

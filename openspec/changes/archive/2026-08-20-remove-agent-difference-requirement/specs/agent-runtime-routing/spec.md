## REMOVED Requirements

### Requirement: Optional runtime diversity constraints
**Reason**: This requirement let configuration force selected steps or roles (e.g. plan and worker/implementation) to resolve to different agent runtimes, hard-failing workflow start on a match. The user wants complete freedom to assign the same agent harness to any steps/roles, so the constraint mechanism is removed outright rather than made optional or advisory.
**Migration**: Remove any `runtime_diversity` entries from agent configuration; they are no longer parsed or enforced. Workflows that previously relied on this check to catch accidental same-runtime routing must review their routing configuration manually — no automated equivalent replaces it. No data migration is needed for already-pinned workflow routing.

#### Scenario: Configuration declares runtime diversity
- **WHEN** configuration includes a `runtime_diversity` (or equivalent) rule naming steps or roles
- **THEN** the field SHALL be ignored and SHALL NOT affect routing resolution or workflow start

#### Scenario: Two constrained routes resolve to the same runtime
- **WHEN** two previously-constrained routes (for example plan and worker) resolve to the same agent runtime
- **THEN** workflow start SHALL succeed
- **AND** no diversity error or attention item SHALL be raised

## ADDED Requirements

### Requirement: One feature-preserving terminal shell
The application SHALL render Environments, Workflows, Observability and Wiki under one OpenTUI renderer with shared chrome. All feature-inventory capabilities from both applications SHALL remain reachable, including environment sub-tabs, providers/issues/change requests/CI, agent utilities, workflow reviews/questions/configuration and telemetry detail views.

#### Scenario: User moves between domains
- **WHEN** a user opens workflow detail from an environment and later opens telemetry
- **THEN** navigation SHALL occur inside the same renderer without starting another TUI root
- **AND** returning SHALL restore the relevant route identity, selection and draft state

### Requirement: Authoritative navigation and modal stacks
The shell SHALL own feature navigation and an authoritative modal stack with instance identity. The top modal SHALL exclusively own overlay input; closing it SHALL reveal the prior modal and restore valid focus. Legacy boolean synchronization SHALL NOT remain a competing final authority.

#### Scenario: Help opens over a review dialog
- **WHEN** contextual help opens above a review dialog and Escape closes help
- **THEN** the review dialog SHALL retain its draft and regain focus
- **AND** underlying views SHALL NOT process the help key or closing Escape

#### Scenario: Text input contains shortcut characters
- **WHEN** a text-entry control receives `?`, shifted letters or search characters
- **THEN** text-entry semantics SHALL take precedence over unrelated global shortcuts

### Requirement: One discoverable command catalog
A single OpenTUI keymap SHALL own application dispatch. Per-surface command registration metadata SHALL drive footer and help projections with compact labels, standard-key hiding and view/modal/panel context. Shifted letters SHALL be normalized centrally and displayed as uppercase letters.

#### Scenario: Focus changes panels
- **WHEN** a different panel receives focus
- **THEN** dispatch and footer SHALL use that panel's active commands
- **AND** help SHALL list its applicable standard and special keys from the same registrations

#### Scenario: Hidden feature has matching binding
- **WHEN** a key matches a command registered by an inactive feature
- **THEN** that feature SHALL NOT execute it
- **AND** one user action SHALL NOT be dispatched by both raw input and keymap handlers

### Requirement: Preserve feature-specific panel navigation
Shared panel framing SHALL preserve workflow directional grid movement, rendered-panel filtering and in-panel scroll semantics. Tab/Shift+Tab SHALL remain shell tab navigation rather than workflow panel movement.

#### Scenario: OpenSpec panel is absent
- **WHEN** no artifacts render and the user moves workflow panel focus
- **THEN** navigation SHALL skip the absent panel and retain the existing grid wrap behavior

### Requirement: Services outlive feature visibility
Workflow execution coordinators, telemetry listeners/watchers and database lifetimes SHALL be owned by the application root independently of feature visibility. Feature rendering SHALL NOT create additional execution coordinators or claim durable effects.

#### Scenario: Switch tabs during workflow execution
- **WHEN** the user hides Workflows while an execution pass is active
- **THEN** execution and lease renewal SHALL continue under the same root owner
- **AND** showing Workflows again SHALL subscribe to authoritative state without duplicating execution

#### Scenario: External tool temporarily owns terminal
- **WHEN** the renderer is suspended while a foreground terminal utility runs
- **THEN** asynchronous child waiting SHALL allow workflow lease renewal and telemetry processing to continue
- **AND** renderer/input ownership SHALL be restored on success, failure or cancellation

#### Scenario: Dispose application
- **WHEN** the application owner is disposed
- **THEN** owned services SHALL be cancelled/finalized once without disposing another application's resources

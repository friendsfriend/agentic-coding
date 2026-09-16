# unified-feature-shell Specification

## Purpose
TBD - created by archiving change compose-unified-feature-shell. Update Purpose after archive.
## Requirements
### Requirement: One feature-preserving terminal shell
The full application SHALL render Home with exactly Environments, Observability, Wiki and Settings under one OpenTUI renderer with shared page-based chrome. The shell SHALL publish the chrome height it renders so an embedded feature sizes its body to the remaining rows instead of reserving header/footer lines the shell owns. Environment categories, providers/issues/change requests/CI, agent utilities, wiki browsing/reviews and telemetry detail capabilities SHALL remain reachable. Workflow creation SHALL be contextual to application/library or independent Wiki pages; persistent model configuration SHALL live in Settings. Workflow execution reviews and questions SHALL remain in the Herdr-managed dashboard. No global or project-local workflow browser, history/reopen route or active-workflow dashboard launcher SHALL remain.

#### Scenario: User starts repository work
- **WHEN** a user opens an application and starts a workflow
- **THEN** existing Herdr orchestration SHALL own its workflow workspace/dashboard and the full application SHALL retain the application page
- **AND** Settings and telemetry SHALL remain reachable through the page hierarchy

#### Scenario: Embedded feature sizes itself to the remaining rows
- **WHEN** a feature body renders inside the shell chrome
- **THEN** it SHALL size its content to the rows the shell leaves it
- **AND** it SHALL NOT reserve header or footer lines the shell renders

### Requirement: Authoritative navigation and modal stacks
The shell SHALL own feature navigation and an authoritative modal stack with instance identity. The top modal SHALL exclusively own overlay input; closing it SHALL reveal the prior modal and restore valid focus. Dialog input order SHALL be dialog open order across shell and feature dialogs, so the most recently opened dialog owns Escape and other input, one level per press, regardless of the dialog's kind, origin or any fixed enumeration order. Legacy boolean synchronization SHALL NOT remain a competing final authority, and the shell SHALL NOT close a feature-owned dialog entry on the feature's behalf.

#### Scenario: Help opens over a review dialog
- **WHEN** contextual help opens above a review dialog and Escape closes help
- **THEN** the review dialog SHALL retain its draft and regain focus
- **AND** underlying views SHALL NOT process the help key or closing Escape

#### Scenario: Text input contains shortcut characters
- **WHEN** a text-entry control receives `?`, shifted letters or search characters
- **THEN** text-entry semantics SHALL take precedence over unrelated global shortcuts

#### Scenario: Dialog spawned from a dialog
- **WHEN** a dialog opens a second dialog and the user presses Escape
- **THEN** only the second dialog SHALL close
- **AND** a subsequent Escape SHALL close the first dialog

#### Scenario: Feature dialog stays with the feature
- **WHEN** an embedded feature renders one of its own dialogs and the user presses Escape
- **THEN** the feature SHALL close that dialog itself and report the change
- **AND** the shell SHALL NOT pop the mirrored feature overlay entry

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
Shared panel framing SHALL preserve workflow directional grid movement, rendered-panel filtering and in-panel scroll semantics. Tab/Shift+Tab SHALL traverse page-local focus regions rather than switch shell destinations.

#### Scenario: OpenSpec panel is absent
- **WHEN** no artifacts render and the user moves workflow panel focus
- **THEN** navigation SHALL skip the absent panel and retain the existing grid wrap behavior

### Requirement: Services outlive feature visibility
Workflow execution coordinators, telemetry listeners/watchers and database lifetimes SHALL be owned by the application root independently of feature visibility. Feature rendering SHALL NOT create additional execution coordinators or claim durable effects.

#### Scenario: Navigate while workflow executes
- **WHEN** the user changes full-application pages while an execution pass is active
- **THEN** execution and lease renewal SHALL continue under the same root owner
- **AND** an explicitly launched Herdr dashboard SHALL subscribe to authoritative state without duplicating execution

#### Scenario: External tool temporarily owns terminal
- **WHEN** the renderer is suspended while a foreground terminal utility runs
- **THEN** asynchronous child waiting SHALL allow workflow lease renewal and telemetry processing to continue
- **AND** renderer/input ownership SHALL be restored on success, failure or cancellation

#### Scenario: Dispose application
- **WHEN** the application owner is disposed
- **THEN** owned services SHALL be cancelled/finalized once without disposing another application's resources

### Requirement: Shell chrome names the page and carries no keybinds
The shell chrome SHALL consist of the logo bar and one breadcrumb row. A page's name SHALL appear in the chrome, not repeated by a title row in the page body, and a page SHALL NOT render a description or hint row that restates keyboard bindings, controls or instructions. Rows that carry data (counts, identifiers, status, timestamps, filter/sort summaries, page-local section headings) SHALL remain. Keybind information SHALL be discoverable from the footer and the `?` help modal, which are projected from the registered command catalog for the active surface, panel and modal context.

#### Scenario: Destination and settings pages
- **WHEN** a user opens Home, a category page or a Settings section
- **THEN** the page SHALL render the chrome followed directly by its selectable rows
- **AND** the page SHALL NOT render a title, description or spacer row above them

#### Scenario: View header keeps its data
- **WHEN** a user opens a list or detail page that shows counts, service identity, duration, status or a timestamp
- **THEN** those values SHALL remain visible
- **AND** any row that only repeated the page name SHALL be gone

#### Scenario: Feature body inside the shell
- **WHEN** an environment view renders inside the page shell
- **THEN** its identity row SHALL be suppressed because the breadcrumb names the page
- **AND** the same view rendered standalone SHALL keep its identity row

#### Scenario: Hint text in a modal
- **WHEN** a dialog needs to state its accept and close keys
- **THEN** it SHALL render them through the shared modal footer contract
- **AND** no dialog SHALL paint an ad-hoc key hint row of its own


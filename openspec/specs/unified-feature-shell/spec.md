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

### Requirement: Shell chrome is pointer-reachable

The workspace sidebar rows, the tab and section strip, the breadcrumb row, the destination lists, the location picker and the footer key chips SHALL be pointer targets.
Their behavior follows the shared semantics: a tap selects, a tap on the selected
row opens, a tab or section header switches on a tap, and a footer chip runs its
registered command when that command takes no argument and is available. A tap
on the sidebar as a whole SHALL focus the sidebar panel. Pointer input SHALL NOT
change the shell's navigation history, its modal stack, its input isolation or
any key binding.

#### Scenario: Opening a workflow from the sidebar

- **WHEN** the developer taps a workflow row that is not selected and then taps it again
- **THEN** the first tap SHALL select the row
- **AND** the second tap SHALL open that workflow's dashboard as `Enter` does

#### Scenario: Tapping the sidebar focuses it

- **WHEN** the developer taps the sidebar panel while the page body holds focus
- **THEN** the sidebar SHALL take panel focus
- **AND** the body SHALL keep its state

#### Scenario: Footer chip runs a shell command

- **WHEN** the developer taps a footer chip for an available argument-free command
- **THEN** that command SHALL run once
- **AND** a chip with no available command SHALL do nothing

#### Scenario: Pointer input stays isolated while a dialog owns input

- **WHEN** a shell dialog is open and the developer taps the page body
- **THEN** the sidebar and the body SHALL keep their selection and focus unchanged

#### Scenario: Existing shell keys and catalog are unchanged

- **WHEN** the footer and help modal are opened after this change
- **THEN** they SHALL list the same keybindings as before
- **AND** every shell key SHALL behave as before

### Requirement: Embedded Environments feature accepts pointer input

The Environments feature SHALL accept the pointer across the surfaces it
embeds: its tab and section strip, its tables and list views, its detail views,
its slot and action views and its dialogs. Table and list rows SHALL select on a
tap and open their detail on a tap of the selected row; detail, log, diff and
markdown panes SHALL scroll on the wheel; dialog rows and tabs SHALL follow the
shared semantics; and dialogs holding typed input, a passphrase, a running
operation or an irreversible confirmation SHALL NOT be dismissed by a backdrop
tap. Text selection and copy inside its diff and markdown views SHALL remain
unaffected.

#### Scenario: Opening a detail from a table

- **WHEN** the developer taps a table row and then taps it again
- **THEN** the first tap SHALL select the row
- **AND** the second tap SHALL open the same detail the row's key opens

#### Scenario: Scrolling a detail or log pane

- **WHEN** the developer moves the wheel over a detail, log, diff or markdown pane
- **THEN** that pane SHALL scroll
- **AND** no other pane's offset or selection SHALL change

#### Scenario: Guarded environment dialog

- **WHEN** the developer taps outside a passphrase, typed-comment or confirmation dialog
- **THEN** the dialog SHALL stay open
- **AND** its input SHALL remain unchanged

#### Scenario: Dragging inside a diff view selects text

- **WHEN** the developer drags across lines in a diff or markdown review view
- **THEN** the drag SHALL keep selecting text
- **AND** no row SHALL be selected or activated by the gesture

#### Scenario: Environment keys are unchanged

- **WHEN** the developer navigates, opens, filters, sorts and confirms with the keyboard
- **THEN** every environment key SHALL behave as before


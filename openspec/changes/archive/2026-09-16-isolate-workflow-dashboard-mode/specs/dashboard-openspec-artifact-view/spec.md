## MODIFIED Requirements

### Requirement: OpenSpec artifact view renders formatted Markdown
When a workflow-operation review opens OpenSpec artifact content, the dashboard SHALL render the artifact's content as block-level Markdown—rendering the whole document so multi-line constructs (lists, tables, block quotes, fenced code blocks) render as formatted blocks—rather than as raw source with Markdown delimiter characters shown as ordinary document text. The view SHALL remain scrollable and dismissable. Artifacts SHALL be reached through the dashboard's own workflow-scoped artifact panel or an operational review: dash SHALL NOT mount the full application's artifact routes or artifact drill-down navigation.

#### Scenario: Review opens artifact content
- **WHEN** a required workflow review opens an OpenSpec artifact
- **THEN** the artifact opens in a scrollable view that renders its Markdown as formatted terminal output, with headings, lists, and fenced code blocks presented as formatted blocks
- **AND** no application page or artifact drill-down route SHALL open in its place

#### Scenario: Multi-line constructs render as blocks
- **WHEN** the opened artifact contains a list, table, block quote, or fenced code block
- **THEN** the construct is rendered as one formatted block rather than one raw source line at a time

#### Scenario: Dismiss the artifact view
- **WHEN** the user presses Esc while viewing an artifact
- **THEN** the view closes and returns to the previous dashboard context

# dashboard-openspec-artifact-view Specification

## Purpose

Defines how the dashboard displays an OpenSpec artifact opened from the OpenSpec panel (the "plan panel"), so proposal, design, tasks, and delta-spec Markdown appears as formatted terminal output rather than raw highlighted source.

## Requirements

### Requirement: OpenSpec artifact view renders formatted Markdown
When the user opens an OpenSpec artifact from the dashboard OpenSpec panel, the dashboard SHALL render the artifact's content as block-level Markdown—rendering the whole document so multi-line constructs (lists, tables, block quotes, fenced code blocks) render as formatted blocks—rather than as raw source with Markdown delimiter characters shown as ordinary document text. The view SHALL remain scrollable and dismissable.

#### Scenario: Open an artifact from the OpenSpec panel
- **WHEN** the user selects an OpenSpec artifact in the OpenSpec panel and opens it
- **THEN** the artifact opens in a scrollable view that renders its Markdown as formatted terminal output, with headings, lists, and fenced code blocks presented as formatted blocks

#### Scenario: Multi-line constructs render as blocks
- **WHEN** the opened artifact contains a list, table, block quote, or fenced code block
- **THEN** the construct is rendered as one formatted block rather than one raw source line at a time

#### Scenario: Dismiss the artifact view
- **WHEN** the user presses Esc while viewing an artifact
- **THEN** the view closes and returns to the previous dashboard context

### Requirement: Non-artifact popups keep their plain presentation
The dashboard SHALL apply formatted Markdown rendering only to the OpenSpec artifact view. Popups that share the same underlying modal but display non-artifact content—the verifier verdict/report popup and the Tasks list popup—SHALL retain their existing plain presentation and SHALL NOT be reinterpreted as Markdown.

#### Scenario: Verifier verdict popup is unchanged
- **WHEN** the user opens a verifier verdict or report popup
- **THEN** its content is presented as before, without Markdown block rendering applied to it

#### Scenario: Tasks list popup is unchanged
- **WHEN** the user opens the Tasks list popup
- **THEN** its content is presented as the existing task list, without Markdown block rendering applied to it

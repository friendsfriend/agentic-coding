# dashboard-layout-spacing Specification

## Purpose
Defines the edge-to-edge terminal layout contract for the home and per-workflow dashboard surfaces, preserving their internal component spacing while reclaiming unused shell space.

## Requirements

### Requirement: Dashboard shells use the full terminal bounds
The home dashboard and per-workflow dashboard SHALL place their outer shell at the terminal's left and top edges, SHALL extend the shell to the terminal's right edge, and SHALL end it at the terminal's bottom edge without reserving blank outer rows or columns.

#### Scenario: Home dashboard fills the terminal
- **WHEN** `agentic-coding home` renders the dashboard shell
- **THEN** the header begins on the first terminal row, the footer occupies the last terminal row, and the dashboard shell spans from the first through the last terminal column

#### Scenario: Per-workflow dashboard fills the terminal
- **WHEN** `agentic-coding dash` renders a per-workflow dashboard
- **THEN** the header begins on the first terminal row, the footer occupies the last terminal row, and the detail dashboard content reaches both terminal side edges

#### Scenario: Dashboard content remains usable after edge spacing is removed
- **WHEN** either dashboard renders its header, tabs, panels, lists, and footer at any supported terminal size
- **THEN** those components retain their existing content, ordering, and interaction behavior while only the outer shell whitespace is removed

## MODIFIED Requirements

### Requirement: Configured apps and libraries are discovery authority
Project discovery SHALL use the backend's configured app/library catalog for contextual workflow creation, telemetry roots and CLI project listing; retained non-UI history consumers SHALL use the same catalog without requiring a TUI workflow list. Recursive root/cwd/development-directory scanning and legacy TOML discovery SHALL NOT remain as fallbacks. Catalog observation SHALL NOT clone repositories or launch operational pollers/actions.

#### Scenario: Unconfigured repository exists nearby
- **WHEN** an unconfigured Git repository exists under the current directory or old discovery root
- **THEN** it SHALL NOT appear in automatic project/workflow discovery

#### Scenario: Catalog server is unavailable
- **WHEN** a catalog request fails
- **THEN** consumers SHALL show a retryable discovery error rather than presenting success with an empty list or scanning elsewhere

#### Scenario: Headless project listing
- **WHEN** CLI project listing runs without a managed TUI server
- **THEN** it SHALL use the canonical backend catalog through a bounded read-only invocation
- **AND** it SHALL NOT start container pruning, workflow drains or environment mutation

### Requirement: Standalone targets and explicit CLI targeting remain supported
Independent wiki/research creation SHALL remain available from Wiki outside the project catalog without a workflow discovery/list surface. Repository-bound research/wiki creation in the full application SHALL originate from the relevant application/library page. Explicit authenticated CLI repository targeting SHALL remain supported independently of automatic discovery.

#### Scenario: Catalog is empty
- **WHEN** no apps or libraries are configured
- **THEN** independent wiki/research creation SHALL remain accessible from Wiki
- **AND** empty project state SHALL NOT be treated as a discovery transport failure

## ADDED Requirements

### Requirement: Embedded durable agent host
The one distributable executable SHALL embed the durable agent host and its pinned pi-durable dependencies, so that the default agent route runs without any separately installed agent runtime. Non-host command modes SHALL NOT eagerly load the durable host modules.

#### Scenario: Compiled executable hosts an agent
- **WHEN** the compiled artifact runs its agent host mode from an unrelated temporary directory
- **THEN** the host SHALL start, open SQLite storage, and serve the control socket without source checkouts or `node_modules`

## REMOVED Requirements

### Requirement: Managed workflow dashboard trace browser
The Herdr dashboard SHALL expose same trace browser for selected workflow's local trace history.

**Reason**: Traces are now inspected exclusively in the dedicated otel TUI tab (`otel-tui` / `--traces-only` mode). The dashboard-embedded Traces panel and trace-browser modal duplicate that capability and are removed from `agent-dash`.

**Migration**: Developers open the dedicated otel TUI tab and filter by the workflow's change identifier instead of pressing Enter on the dashboard Traces panel. The workflow engine continues writing normalized `traces.jsonl`, which the standalone viewer loads unchanged.

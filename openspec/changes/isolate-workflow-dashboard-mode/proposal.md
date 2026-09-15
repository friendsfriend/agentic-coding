## Why

Herdr launches a dashboard for a specific workflow. Rendering the full navigation shell around it exposes irrelevant destinations and lets a workflow pane become a second application browser.

## What Changes

- **BREAKING** Make `agentic-coding dash` render only the explicitly targeted workflow dashboard, without tabs, breadcrumbs, Home, location picker, Settings or feature navigation.
- Compose a separate dashboard root from the existing dashboard component and shared primitives; do not merely hide shell chrome.
- Remove standalone trace/artifact browsing and unrelated drill-down commands; retain workflow-operation review, question, approval and confirmation dialogs, panel focus and contextual help.
- Preserve CLI workflow identity, typed backend access, Herdr integration, durable execution and owned-versus-attached lifecycle semantics.

## Capabilities

### New Capabilities
- `standalone-workflow-dashboard`: Restricted dashboard root and command surface with workflow-operation parity.

### Modified Capabilities
- `unified-application-distribution`: Dash is an explicit dashboard-only presentation mode, not a shared feature-shell route; full-app aliases open Home.
- `dashboard-openspec-artifact-view`: Clarify that artifact rendering is retained where a workflow review requires it, not as standalone dash browsing navigation.

## Impact

Depends on `launch-workflows-from-project-and-wiki-pages` (and its navigation/Settings predecessors). Touches `src/cli.ts`, `src/tui/index.tsx`, root composition, `src/tui/dash/App.tsx`/keymaps, shared service setup and CLI/render tests. Reuses one dashboard implementation and the existing authenticated backend. No new executable, workflow engine or server ownership model.

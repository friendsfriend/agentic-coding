## Why

Creating a new workspace for a project you're already standing in requires either navigating to it in the project list (if the discovery root covers it) or typing the full custom path. Neither is frictionless when you just ran `cd` and want "start working here."

## What Changes

- **Dashboard new‑workflow modal** adds a `Current Directory (<basename>)` entry between the discovered project list and the existing `Custom path…` option. Selecting it fills the repo path from `process.cwd()`.
- **Pi extension `implementation` command** adds the same entry at the end of the project select list. Selecting it passes `process.cwd()` as the repository path.

## Capabilities

### New Capabilities
- `current-directory-quick-select`: Both project selectors expose the shell's current working directory as a one‑tap option.

## Impact

- `agent-dash/src/ui/NewWorkflowModal.tsx` — add CWD row in the step‑0 choices list and handler.
- `pi/extensions/herdr-workflow.ts` — add CWD entry in the labels array and handler.
- No changes to `pi/bin/herdr-workflow` — the `projects` command stays unchanged.
- No changes to `agent-dash/src/data.ts`.

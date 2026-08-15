# Proposal: On-demand SSH passphrase popup for git operations

## Why

Git commands run by the workflow engine — notably the delivery `git push` — fail with `Permission denied (publickey)` when the SSH key is passphrase-protected and not unlocked in an agent. With no tty and no askpass program, ssh cannot prompt, the `delivery.push` effect fails, and the dashboard can only surface an error dialog telling the user to configure a Git/SSH credential agent before the workflow can finish.

The legacy wizard worked around this by collecting the passphrase up front as a step in the "New workflow" modal. That step asks for a secret nobody may need, blocks workflow creation, and was already dropped during the workflow-state-handling rework — but no replacement was built. The developer wants lazygit's behavior (see jesseduffield/lazygit, `pkg/commands/oscommands/cmd_obj_runner.go` and `pkg/gui/controllers/helpers/credentials_helper.go`): run network git commands credential-aware and show a masked popup on demand — only when git/ssh actually asks for a passphrase — then feed the answer to the already-running command so the workflow continues.

Separately, the "Agent routing" row in the new-workflow confirm summary is redundant: routing is fully resolved from configuration (`[agents.routes]`, `[agents.role_routes]`, `[agents.definition_defaults]` in `pi/herdr-workflow.toml`) and the modal merely repeats that fact. It should be removed.

## What Changes

- Add a credential-aware git runner (`agentic-coding/src/workflow/credentials.ts`) that executes network git commands with `SSH_ASKPASS` / `GIT_ASKPASS` bridged to the dashboard UI through a small askpass shim. The popup appears exactly when ssh/git requests a credential — nothing is asked up front.
- Add a masked `CredentialsModal` popup to the dashboard, wired to the in-process effect runner so `delivery.push` can pause, request the passphrase, and continue without restarting the workflow.
- Fail fast with an actionable diagnostic when a credential is requested in a non-interactive context (CLI drain), instead of hanging or surfacing a bare `publickey` error.
- Remove the "Agent routing" summary row from the new-workflow confirm summary.
- Formalize that the new-workflow wizard has no passphrase input step (already removed in the rework; the spec pins the behavior).

## Capabilities

### New Capabilities
- `credentials-popup`: On-demand, masked credential popup for engine-run git commands, surfaced only when ssh/git actually requests a passphrase, plus new-workflow wizard cleanups (no passphrase step, no Agent routing summary row).

### Modified Capabilities

- None.

## Impact

- New module `agentic-coding/src/workflow/credentials.ts` (askpass shim + async runner), new UI component `agentic-coding/src/tui/dash/ui/CredentialsModal.tsx`, bridge wiring in `engine.ts`/`App.tsx`, one-line summary change in `agentic-coding/src/tui/dash/ui/NewWorkflowModal.tsx`.
- `delivery.push` effect handler switches from sync `Bun.spawnSync` to the credential-aware async runner when an interactive bridge is attached; all other effects (local git ops, gh/glab PR create) are unchanged.
- New tests: runner/shim contract unit tests, popup render test, wizard summary test. Existing suites stay green.
- No changes to the workflow engine core, persistence, definitions, agent protocol, or configuration.

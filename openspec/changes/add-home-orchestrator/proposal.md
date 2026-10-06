# Proposal

## Why

Workflows can only be started from a project page, the workspace sidebar or the
Wiki, one form at a time, and every lifecycle step (resume, retry, close, PR)
is a manual dashboard action. The developer wants one agent they can chat with
that sees the configured projects, presets and workflows, starts the right
workflow for a request, and keeps workflows moving — while every plan,
developer, findings and wiki review stays a human decision.

This change records the implemented baseline so the follow-up changes
(monitoring, attribution, launch caps, custom workflow graphs) extend a
specified capability instead of an undocumented one.

## What Changes

- Home gains an **Orchestrator** destination: one persistent `pi-durable`
  conversation hosted by a dedicated agent host in orchestrator mode, with
  `/new` to start a fresh session.
- `[agents.orchestrator] { model, thinking }` selects the session model,
  edited in Settings → Agent Presets and applied whenever the page opens.
- The session gets `read` plus orchestrator tools only (discover projects,
  workflow types, presets, branches and workflows; read one workflow; start,
  act on and drain workflows). No shell, no writes, no codemode.
- The unified server accepts a second, narrower **orchestrator capability**
  (HMAC of the instance token) and confines it to a route and action policy.
- Workflows the orchestrator starts pin the plan, developer and wiki gates to
  `always`, decided by the server from the principal, never from the request.

## Capabilities

### New Capabilities

- `home-orchestrator`: the Home chat page, its session, model setting, tool
  surface, and the server-enforced orchestrator boundary.

### Modified Capabilities

None. The orchestrator uses the existing start/action/execute operations.

## Impact

- `agentic-coding/src/tui/orchestrator/` (page, host bootstrap),
  `src/tui/shared/routes.ts`, `src/tui/shared/navigation/destinations.ts`,
  `src/tui/otel/app/App.tsx`, `src/tui/dash/ui/AgentSessionView.tsx`
  (route slash commands), `src/tui/dash/keymap-setup.ts`
  (`orchestrator.view` field).
- `src/agent-host/orchestrator.ts`, `orchestrator-env.ts`, `host.ts`,
  `host-main.ts` (`--orchestrator`), `protocol.ts` (`orchestrator` policy),
  `client.ts` (spawn env).
- `src/server/auth.ts` (principal), `src/server/orchestrator-policy.ts`,
  `src/server/app.ts`, `src/server/handlers.ts`, `src/server/config.ts`
  (`set-orchestrator`), `src/workflow/startup.ts`, `src/workflow/profiles.ts`.
- `src/tui/settings/` (Orchestrator model picker, inventory entry).
- Docs: `agentic-coding/docs/orchestrator.md`, settings inventory, launch.

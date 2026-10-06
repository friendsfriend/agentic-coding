# Design

## Context

The shell already owns the unified server and renders durable agent sessions
(`AgentSessionView`) for workflow runs. The durable host is per workflow
directory and spawned on demand. Workflow starts go through one typed start
boundary; actions through one revision-guarded action route.

## Goals / Non-Goals

**Goals:**

- A chat surface that can discover, start and manage workflows.
- Human reviews can never be decided or skipped on the orchestrator's behalf,
  enforced by the server rather than by the prompt.
- No new workflow semantics: the orchestrator calls existing operations.

**Non-Goals:**

- Custom workflow graphs (follow-up changes).
- Event-driven wake-ups, actor attribution and launch limits (follow-ups).
- Answering agents' developer questions.

## Decisions

- **Dedicated host in orchestrator mode.** `agent host --workflow-dir
  <config root>/orchestrator --orchestrator` installs only the coding tools and
  the orchestrator extension, and serves only the `orchestrator` tool policy;
  a workflow run can never land on it and vice versa.
- **Derived capability.** `orchestratorTokenFor(token)` is an HMAC of the
  instance token: any holder of the instance token can issue it, the server
  verifies it statelessly, and its holder cannot recover the instance token.
  The TUI writes it into the session's private run env on every page open
  (the server token changes per shell run) and strips the operator tokens from
  the host process environment.
- **No shell.** With `bash`, the session could read the instance token from the
  environment or the loopback handoff file and bypass the policy. Its tools are
  exactly `read` plus the orchestrator tools.
- **Policy in one pure module.** `orchestrator-policy.ts` holds the route
  allowlist, the human-review step set and the action allowlist; `app.ts`
  applies it before routing. Starts receive `enforceHumanReviewGates` as a
  server-decided option; the wire schema rejects the field.
- **Own keymap field.** The page owns keys through `orchestrator.view`
  (`session`/`picker`) because the workflow dashboard repairs `agent.view`
  before every key.

## Risks / Trade-offs

- [The orchestrator host outlives the shell; its run env then names a dead
  server] → Tools report "no server connection"; reopening the page rewrites
  the run env.
- [`read` can read any file, including the token handoff file] → Without a
  network-capable tool the token is useless to the session.

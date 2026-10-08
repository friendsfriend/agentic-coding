# Tasks

## 1. Capability

- [ ] 1.1 Add `environmentTokenFor` and owner-bound authorization in `src/server/auth.ts`; verify valid token, wrong owner, tampered token and constant-time comparison path in `test/server-auth.test.ts`.
- [ ] 1.2 Pass `AGENTIC_ENV_URL`/`AGENTIC_ENV_TOKEN` into every durable workflow run env with owner `workflow:<id>`; verify the run env file contents.

## 2. Routes

- [ ] 2.1 Add `/api/v1/agent-env/{list,start,status,stop,build,test,logs}` mapping to instance operations for the derived owner; verify an owner can never address another owner's instance.
- [ ] 2.2 Add the redactor and apply it to every agent-route response; verify `.env` values and secret action values are redacted.

## 3. Tools

- [ ] 3.1 Add `src/agent-host/environment-tools.ts` (`agentic.environment` extension) with the seven tools, bounded output, non-replay; install it for every durable run in `host.ts`; verify the tool list for read-only and writable runs.
- [ ] 3.2 Verify `env_start` returns endpoints, `already-running`, and `queued {position}` through a fake server.
- [ ] 3.3 Add the environment-tools section to `agent-definitions/instructions/workflow-agent-protocol.md` (Docker first; kind only for concurrency; stop what you started when done).

## 4. Checks

- [ ] 4.1 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

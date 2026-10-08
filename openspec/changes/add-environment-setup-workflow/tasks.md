# Tasks

## 1. Overlay and discovery

- [ ] 1.1 Add config-dir Kubernetes discovery (`apps/kubernetes/<app>-<profile>.k8s.json`, `$APP` → checkout); verify discovery and that checkout `devenv.k8s.json` still works.
- [ ] 1.2 Add overlay resolution (drafts before live, per file) for instance discovery and compilation; verify replace and add cases.

## 2. Role and family

- [ ] 2.1 Write `agent-definitions/instructions/env-setup.md` (inspect repo build tooling, templating rules and variables, Docker-first, kind only if needed, OTel wiring, mock-auth, report template) and register role `env-setup`.
- [ ] 2.2 Add `graphs/env-setup.ts` + `steps/env-setup.ts` (author → validate → approval → promote → completed, bounded loops) and register; verify registry validation and digest pins.
- [ ] 2.3 Add `--app` input and `checkout` mode enforcement to start/launch dialog/orchestrator workflow types; verify.

## 3. Gates

- [ ] 3.1 Implement `setup.validate` (validator + start + readiness, failure report back to author); verify pass and fail paths with executor doubles.
- [ ] 3.2 Implement the write guard fingerprint and `attention-required` transition; verify detection of a live-config write and a checkout change.
- [ ] 3.3 Implement the approval diff view with shared-infra flag; open the TUI and confirm footer and `?` help for the gate keybinds.
- [ ] 3.4 Implement `setup.promote` with backup, atomic writes, reload and full rollback; verify rollback on an injected write failure.

## 4. Checks

- [ ] 4.1 Document the family in the README workflow list and `agentic-coding/docs/agent-environments.md`.
- [ ] 4.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

# Tasks

## 1. Overlay and discovery

- [x] 1.1 Add config-dir Kubernetes discovery (`apps/kubernetes/<app>-<profile>.k8s.json`, `$APP` → checkout); verify discovery and that checkout `devenv.k8s.json` still works.
- [x] 1.2 Add overlay resolution (drafts before live, per file) for slot-run discovery and compilation; verify replace and add cases.

## 2. Role and family

- [x] 2.1 Write `agent-definitions/instructions/env-setup.md` (inspect repo build tooling, static ports that do not collide with other apps, `AC_OWNER`/`AC_APP_DIR`/`AC_OTEL_*` variables, Docker-first, kind only if needed, OTel wiring, mock-auth, report template) and register role `env-setup`.
- [x] 2.2 Add `graphs/env-setup.ts` + `steps/env-setup.ts` (author → validate → approval → promote → completed, bounded loops) and register; verify registry validation and digest pins.
- [x] 2.3 Add `--app` input and `checkout` mode enforcement to start/launch dialog/orchestrator workflow types; verify. (The `start` command (with `--app` in the flag schema), `WorkflowStartRequest`, the contracts schema, the server handlers, the public catalog and the manifest policy (`checkoutRequired`, `clean-tree`) carry it. Verified by `test/workflow-startup.test.ts` (app required, ident validated, checkout mode forced, app pinned), `test/workflow-cli.test.ts` (the flag is accepted), and `test/dash/newWorkflowModal.test.tsx` (the launch dialog's "Configured app to set up" step: the launch context's own app is the default entry and an empty catalog states the remedy).)

## 3. Gates

- [x] 3.1 Implement `setup.validate` (structural checks incl. port collisions + start + readiness, failure report back to author); verify pass and fail paths with executor doubles.
- [x] 3.2 Implement the write guard fingerprint and `attention-required` transition; verify detection of a live-config write and a checkout change.
- [x] 3.3 Implement the approval diff view with shared-infra flag; open the TUI and confirm footer and `?` help for the gate keybinds. (The gate opens the environment-review popup over the draft diff; a replacement of an existing shared definition carries its own `Shared` column in the file list and an "affects all apps" label in the diff header, while the row's path stays the raw anchor identity comments match on. No keybind was added: the popup reuses the review popup's own `j/k`, `Enter`, `/`, `f`, `Esc`, so the footer and `?` help catalogs are unchanged and nothing new can be missing from them. Asserted by `test/ui/changedFilesView.test.tsx` (the column and the raw path) and `test/dash/data.test.ts` (the gate's action key); no interactive TTY was available for a manual footer read.)
- [x] 3.4 Implement `setup.promote` with backup, atomic writes, reload and full rollback; verify rollback on an injected write failure.

## 4. Checks

- [x] 4.1 Document the family in the README workflow list and `agentic-coding/docs/agent-environments.md`.
- [x] 4.2 Run `bun run lint`, `bun run type-check` and focused tests with zero diagnostics.

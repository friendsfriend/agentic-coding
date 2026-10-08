# Design

## Context

Run targets are discovered by convention (`apps/compose/<app>-<profile>-compose.yml`,
`apps/run/<app>-<profile>.sh`) in `src/server/actions/discovery.ts` and compiled
into immutable action definitions. Dependencies are expressed through
`requires` and shared via `DependencyLeases` (`src/server/runtime/leases.ts`).
Environment state lives in `$DEVENV_HOME/db/state.db`, schema v7, owned by
`src/server/environment/state-store.ts`.

## Goals / Non-Goals

**Goals:** many concurrent copies of the same app, each tied to an owner and a
checkout; zero behavior change for the human `user` instance; one code path for
compose and script.

**Non-Goals:** DB isolation and infra endpoint variables (change 2), TTL/caps/
queue (change 3), kind (change 4), rewriting existing definitions (change 5),
agent tools (change 6).

## Decisions

- **Instance identity.** `instanceId` = `default` for the `user` owner,
  otherwise a sanitized slug `[a-z0-9-]{1,24}` derived from the owner id plus a
  short hash to stay unique. One instance per (owner, app); a second start for
  the same pair returns the existing instance (`already-running`), matching the
  action engine's semantics.
- **Owners.** Only `user` and `workflow:<id>`. Debug sub-agents share the
  caller workflow's owner; standalone debug and env-setup are workflows. An
  instance may carry a `config_overlay` directory (column reserved here, used
  by env-setup drafts) that discovery reads before the live config dir.
- **Owner checkout.** `workflow:<id>` resolves the workflow worktree through
  the worktree port; `user` keeps the active-checkout resolution of
  `environment/config.ts`. The path is stored on the instance and exported as
  `AC_APP_DIR`; discovery receives it as `localDir`.
- **Template variables are environment variables, not a template engine.**
  Compose already interpolates `${VAR:-default}`; scripts read env. The server
  only computes values and passes them to the compose CLI / script process. No
  custom templating language. `$APP`/`$CONFIG` expansions stay as they are.
- **Port names come from the definition text.** The allocator scans the target
  source for `AC_PORT_<NAME>` references and allocates one host port per name
  from `environment.instances.port_range` (default `20000-29999`), checking the
  port is bindable on `127.0.0.1` before persisting. `user` instances use the
  `:-default` literal and allocate nothing.
- **Image tag.** `AC_IMAGE_TAG` = `latest` for `user`, `<instanceId>` otherwise,
  so two branches never overwrite each other's image.
- **Compose isolation.** `docker compose -p <app>-<instanceId>`; the shared
  network `devenv-local` is declared `external` by templated definitions. A
  compose file that still sets `container_name` or `include:`s infra is
  **untemplated**: it may only run as the `user` instance (validator in
  change 5 surfaces this).
- **Script isolation.** The launch handle (pid / tmux window) records the
  instance id; stop kills only that process tree.
- **Runtime choice.** When an agent-owned start names no target, choose the
  first available runtime in `docker` → `shell`/`systemshell`; within a runtime
  prefer profile `default`, then the only profile, else fail asking for a
  profile. `kubernetes` is never auto-chosen.
- **Persistence (v8).** Tables `env_instances(id, owner, app, target_id,
  runtime, checkout_path, config_overlay, image_tag, status, created_at, last_activity_at)` and
  `port_allocations(instance_id, name, port)`. Migration follows the existing
  `BEGIN IMMEDIATE` + `VACUUM INTO` backup + integrity-check path; a future
  schema still fails closed.
- **API.** `GET /api/v1/environment/instances`, `GET .../{id}`,
  `POST .../start {owner, app, target?, profile?}`, `POST .../{id}/stop`.
  Responses carry resolved endpoints (`name → http://127.0.0.1:<port>`).
  Routes use the instance capability; owner scoping for agents comes in
  change 6.

## Risks / Trade-offs

- [A port allocated then grabbed by another process] → bind-check before
  persisting and surface a typed `port-unavailable` failure at start; retry
  allocation once.
- [Instance rows orphaned by a crash] → on startup reconcile rows against
  runtime observation; an unobservable instance stays `unknown`, never
  `stopped` (observation failure is not absence).
- [Two owners share one checkout path] → allowed; instances stay distinct by
  owner.

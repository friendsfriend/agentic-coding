# Standalone environment server

- Run `bun run lint`, `bun run type-check` and `bun run test` in this package.
- Biome is the sole formatter/linter; use tabs and no non-null assertions.
- This package must install/build/run without either sibling application.
  No imports of their source, packages, agents, profiles, state or runtime hosts.
- Copy/adapt required functionality locally and record its source in
  `PROVENANCE.md`. Keep pure environment rules independent of I/O and MCP.
- V1 behavior is the reference; the original live-handle cleanup and separate
  operator approval guarantees remain explicit. Shared/external use is not owned
  cleanup authority. Never stop/reconfigure an existing database as a convenience.
- Advertise only working tools. Inspection-only compatibility is not execution
  validation or a live runtime compatibility claim.
- Keep tests at public/pure decision boundaries, small and functional. The
  copied-artifact stdio scenario is the package-independence contract; avoid
  repeated server/database/container setup for input tables.

- Every agent action is declared once in `src/interface/capabilities.ts`.
  MCP (`src/mcp`) and OpenTUI (`src/ui`) must derive from that registry; never
  add a tool or UI-only action with its own handler. `test/capability-parity.test.ts`
  must keep MCP names, UI names and input schemas identical.
- The UI layer must not import MCP registration, listener/bootstrap code or
  service construction. It consumes `EnvironmentCapabilities`; standalone and
  OpenCode-hosted UIs inject different implementations (in-process or proxy).
- Operator approval is a separate human-only capability surface, not an MCP
  action; do not add approval/decision tools to the agent registry.
- The OpenTUI view consumes `UiCapabilityApi`; it must not construct MCP servers,
  listeners, journals or runtime adapters. Standalone uses `createHttpUiCapabilityApi`
  over the authenticated loopback capability transport; an embedded host mounts
  the same view with `mountEnvironmentTui`. Keep the transport out of the renderer.
- `opencode-plugin/` is an OpenCode-hosted adapter over the same
  `UiCapabilityApi`/controller. It must not add a plugin-local action table,
  construct the server, or expose operator approval; its route, forms, results
  and trace browser stay registry-derived.
- `env_list`/`env_run` readiness must name its source. `docker-running` is never
  reported as application health. Endpoint readiness requires declared loopback
  `endpoints` plus matching `endpointServices`; a missing probe capability is
  `unknown`, not success.
- The operator approval UI belongs to `src/operator/`, consumes `OperatorApi` and
  must never be registered as an agent capability or imported by `src/ui/`.
  Approval/rejection/acknowledgement stay exact digest/revision-fenced; the UI
  must not construct a server, journal, session or runtime adapter.
- `--connect` is a stdio-to-authenticated-HTTP MCP bridge for hosts such as
  OpenCode. It must not construct state, journals, sessions or runtime adapters,
  and must never print the bearer token. Keep credentials in a private file or
  named environment reference.
- Shell run targets own a live detached process group only through the current
  controller. Never adopt or kill a saved PID after restart; process groups must
  be stopped on graceful shutdown, and a failed group stop retains the owned
  record. Process output/logs must pass through the same redaction as Docker.


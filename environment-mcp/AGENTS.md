# Standalone environment server

- Run `bun run lint`, `bun run type-check` and `bun run test` in this package.
- Biome is the sole formatter/linter; use tabs and no non-null assertions.
- This package must install/build/run without either sibling application.
  No imports of their source, packages, agents, profiles, state or runtime hosts.
- Copy/adapt required functionality locally and record its source in
  `PROVENANCE.md`. Keep pure environment rules independent of I/O and MCP.
- V1 behavior is the reference; the original live-handle cleanup and
  owned-resource guarantees remain explicit. Execution is direct. Shared/external
  use is not owned cleanup authority. Never stop/reconfigure an existing database
  as a convenience.
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
- The OpenTUI view consumes `UiCapabilityApi`; it must not construct MCP servers,
  listeners, journals or runtime adapters. Standalone uses `createHttpUiCapabilityApi`
  over the authenticated loopback capability transport; an embedded host mounts
  the same view with `mountEnvironmentTui`. Keep the transport out of the renderer.
- `opencode-plugin/` is an app-centric OpenCode adapter over the same
  `UiCapabilityApi`. It must not add a plugin-local action table or construct
  the server; its inventory, detail, target picker, receipts, logs and telemetry
  stay registry-derived. Execution is direct; there is no approval gate.
- `env_list`/`env_execute` readiness must name its source. `docker-running` is never
  reported as application health. Endpoint readiness requires declared loopback
  `endpoints` plus matching `endpointServices`; a missing probe capability is
  `unknown`, not success.
- `--connect` is a stdio-to-authenticated-HTTP MCP bridge for hosts such as
  OpenCode. It must not construct state, journals, sessions or runtime adapters,
  and must never print the bearer token. Keep credentials in a private file or
  named environment reference.
- Shell run targets own a live detached process group only through the current
  controller. Never adopt or kill a saved PID after restart; process groups must
  be stopped on graceful shutdown, and a failed group stop retains the owned
  record. Process output/logs must pass through the same redaction as Docker.


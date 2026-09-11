## 1. Lifecycle ownership

- [ ] 1.1 Confirm replace-workflow-project-discovery and all frontend predecessor changes are implemented.
- [ ] 1.2 Define shared startup/shutdown states and owned resource handles for Go, workflow application, telemetry and renderer.
- [ ] 1.3 Add backend instance/version/config health identity and remove listener-PID-based ownership/termination.
- [ ] 1.4 Implement partial-startup rollback and readiness-gated input with progress/error tests.
- [ ] 1.5 Implement idempotent bounded quit/signal cleanup and active-action confirmation through domain cancellation APIs.
- [ ] 1.6 Test attach and per-workflow no-owner modes never stop unrelated servers or durable workspace resources.

## 2. Commands and distribution

- [ ] 2.1 Consolidate default/workflow/home/manager/dash/server/attach dispatch and thin devenv alias behavior.
- [ ] 2.2 Expose environment-only attach capabilities explicitly during mixed-runtime milestone; avoid implicit remote/local data mixing.
- [ ] 2.3 Consolidate version source and host-target Bun build with embedded platform Go backend.
- [ ] 2.4 Secure embedded extraction directory, permissions, failure cleanup and owned-process shutdown.
- [ ] 2.5 Include instruction materialization, guides, OpenTUI native/worker assets and telemetry protocol assets.
- [ ] 2.6 Convert optional gRPC helper to internal executable mode; validate actual protocol startup and loopback binding.

## 3. Frontend release gate

- [ ] 3.1 Test occupied port, wrong-instance health, child startup failure and quit during each acquisition step.
- [ ] 3.2 Test repeated quit and SIGINT/SIGTERM/SIGHUP with active effects/actions and verify all owned ports/handles release.
- [ ] 3.3 Run host-target packaged smoke tests outside source trees without Go compiler or external devenv checkout.
- [ ] 3.4 Run all feature-inventory journeys including terminal-tool suspend/resume and optional telemetry protocols.
- [ ] 3.5 Run combined verification, update CLI/platform/upgrade docs and record this as frontend-first release milestone.

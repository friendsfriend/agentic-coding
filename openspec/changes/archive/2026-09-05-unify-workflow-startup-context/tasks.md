## 1. Characterize entry points and configuration

- [x] 1.1 Add parity tests capturing normalized engine-start inputs for CLI, dashboard, and internal wiki/research starts.
- [x] 1.2 Add cross-repository, linked-worktree, no-repository, explicit HERDR_WORKFLOW_CONFIG, and provenance/write-back tests without launching real runtimes.
- [x] 1.3 Test preset-only fusion, explicit-list precedence, gaps, duplicate profiles, unknown models, and unsupported capabilities across both user entry points.

## 2. Share preparation and context

- [x] 2.1 Extract one typed application startup function and reusable role resolution from CLI/dashboard orchestration, reusing current preflight and Git helpers.
- [x] 2.2 Make configuration loading, preset listing, model configuration reads, and write-back accept explicit selected repository context and retain source provenance.
- [x] 2.3 Route CLI and dashboard/internal starts through the shared function while preserving final direct-engine guards and entry-point presentation.
- [x] 2.4 Remove duplicate fusion/start preparation and TUI imports of CLI startup orchestration; verify all callers use the shared boundary.

## 3. Pin execution settings safely

- [x] 3.1 Add validated non-secret execution settings/provenance to the workflow contract and startup snapshot without changing existing agent profile pins.
- [x] 3.2 Make delivery/PR and other configuration-sensitive handlers use accepted settings rather than drainer-time loadConfig defaults.
- [x] 3.3 Add a revision-bound preview/accept path for legacy settings adoption through repair/migration; retain readable status and block sensitive effects until adoption.
- [x] 3.4 Test changed cwd/config after start, stale adoption, missing PR tooling, rollback, and absence of persisted credentials.

## 4. Validate and document

- [x] 4.1 Run affected workflow-cli, workflow-dashboard, workflow-model-config, workflow-plan-fusion, workflow-effects, workflow-runtime, and home/model modal tests.
- [x] 4.2 Update CLI help and architecture/config docs with repository scope, fusion precedence, provenance, execution pins, and legacy adoption.
- [x] 4.3 From agentic-coding/, run bun run type-check, bun run lint with zero diagnostics, and bun run build; run the fake-Herdr shell smoke for changed startup paths.
- [x] 4.4 Run openspec validate unify-workflow-startup-context --strict and confirm no new dependency or credential storage was introduced.

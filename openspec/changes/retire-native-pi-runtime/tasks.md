## 1. Migration

- [ ] 1.1 Extend `config migrate` to preview/apply rewriting `pi` profiles and presets to `pi-durable`
- [ ] 1.2 Reject `runtime: "pi"` in configuration parsing with a diagnostic naming the migration command

## 2. Removal

- [ ] 2.1 Remove `PiAdapter`, `pi` model enumeration, `pi-tools.ts`, `piLaunchAssets`, and the `agent-extension` CLI
- [ ] 2.2 Remove pi extension and bridge files no longer loaded; update embedded asset generation
- [ ] 2.3 Replace pi session discovery with durable host session listing
- [ ] 2.4 Refuse resume of active workflows pinned to `pi` with repair guidance

## 3. Verification and docs

- [ ] 3.1 Focused tests for migration preview/apply, config rejection, and pinned-route refusal
- [ ] 3.2 Update README, install script, and workflow architecture docs

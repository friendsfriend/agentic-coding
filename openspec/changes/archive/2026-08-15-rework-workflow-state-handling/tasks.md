## 1. Registry and Type Contracts

- [x] 1.1 Add runtime contracts and parsers for workflow definitions, step definitions, commands, snapshots, runs, effects, agent profiles, assignments, artifacts, and workflow views without `Record<string, any>` lifecycle state.
- [x] 1.2 Implement registry and graph compiler validation for IDs, versions, actors, schemas, outcomes, effects, reachability, terminals, declared cycles, retry limits, and adapter requirements.
- [x] 1.3 Implement deterministic definition/step/instruction digests and exact-version lookup that blocks missing or changed pinned definitions.
- [x] 1.4 Register versioned built-in step catalog and standard, direct-apply, and no-OpenSpec graph manifests through public plugin-grade registry seam.
- [x] 1.5 Add pure registry tests for valid built-ins, invalid graph matrix, explicit extension composition, no implicit insertion, and definition pin mismatch.

## 2. Canonical Transactional State Runtime

- [x] 2.1 Resolve canonical repository/store from main checkout and linked worktree, then add normalized SQLite instance, run, event, and outbox tables with constraints and migrations.
- [x] 2.2 Implement snapshot/run cross-field validation on every load/write and fail-closed diagnostic workflow view for malformed or unavailable pinned state.
- [x] 2.3 Implement unified `BEGIN IMMEDIATE` command dispatcher with developer revision CAS, active run-generation authorization, pure reduction, resulting-state validation, atomic event/outbox writes, and bounded errors.
- [x] 2.4 Implement random single-use run capabilities stored hashed, exact output containment/size/schema/run checks, digest persistence, parallel handoff merge, and duplicate/stale rejection.
- [x] 2.5 Implement durable outbox claim leases, bounded retry, effect result commands, attention-required handling, and automatic draining after CLI/in-process commands and from dashboard runner.
- [x] 2.6 Convert workspace/branch setup, artifact writes, agent lifecycle, notifications, delivery, PR, close/cleanup, and other external work into named idempotent effect handlers with observe-before-retry checks.
- [x] 2.7 Replace raw override/recovery-agent paths with repair preview, revision/reason confirmation, run/effect invalidation, paused repaired snapshot, stale-agent stop effects, and explicit validated resume action.
- [x] 2.8 Implement first-access legacy migration for every workflow type/phase, equivalent mirror comparison, evidence import, generated legacy Pi routing, fresh active-run assignment, preserved source rows/files, and repair-required conflicts.

## 3. Built-in Workflow Behavior

- [x] 3.1 Implement planning and plan-approval steps, including required artifact contracts, strict OpenSpec validation, PLAN rejection diagnostics, and developer approval action.
- [x] 3.2 Implement implementation step modes for apply, verifier fix, and developer-review fix with base/task/input/output validation and generic worker handoff.
- [x] 3.3 Implement triage input generation, run-bound triage plan schema, changed-file/hunk/role validation, reusable evidence, and verifier run fan-out.
- [x] 3.4 Implement verification reducer with independent parallel results, engine-derived verdicts, automatic test-verifier launch, pass/fix/attempt-limit outcomes, findings history, and no finish-review coordinator command.
- [x] 3.5 Implement developer-review actions for advisory acceptance/comments, archive run validation, idempotent delivery commit/push, PR actions, completed close/clean actions, and terminal states.
- [x] 3.6 Enforce direct-apply pre-authored plan validation before creation and no-OpenSpec non-empty task flow without planner, OpenSpec verifier/checklist, or archive step.

## 4. Skill-free Agent Assignment and CLI

- [x] 4.1 Replace Herdr `SKILL.md` assets with common protocol and step-specific plain Markdown instruction assets outside runtime discovery; remove skill frontmatter, `--skill`, `/skill:`, and generated role-skill loading.
- [x] 4.2 Implement bounded assignment renderer with pinned instruction hashes, complete dynamic scope/policy/output/outcome fields, exact environment, and full prompt on reused sessions.
- [x] 4.3 Implement `agentic-coding workflow handoff` for complete/blocked/failed using run environment only, including blocker routing and no agent-selected workflow/role/step/effect fields.
- [x] 4.4 Replace CLI with `start`, typed-view `status`, revision-bound `action`, `handoff`, `repair`, `projects`, `config`, and `agent-extension`; remove legacy role/phase verbs and compatibility translation.
- [x] 4.5 Rename Pi extension management/config terminology to agent extensions and migrate unambiguous legacy assignments into Pi profile configuration.

## 5. Agent Profiles and Runtime Adapters

- [x] 5.1 Replace model/thinking role maps with named profile config, step routes, step/role overrides, deterministic precedence, pinned non-secret resolved routing, profile validation, and optional runtime-diversity constraints.
- [x] 5.2 Implement shared Herdr adapter lifecycle/topology utility: scoped environment, foreground-shell wait, one unavailable-shell retry, `agent start`, `agent get`, `agent prompt`, observation, stop, and session reuse.
- [x] 5.3 Implement Pi adapter profile arguments/tool policy without workflow skills and with explicit runtime bridge injection.
- [x] 5.4 Implement stable OpenCode adapter using `opencode`, isolated permissions/config, profile model/agent options, generic assignment, and OpenCode telemetry bridge.
- [x] 5.5 Implement official OpenCode V2 adapter using `opencode2`, validated workflow-scoped `opencode` PATH launcher for Herdr kind, beta config/flag translation, generic assignment, and V2 telemetry bridge.
- [x] 5.6 Add adapter capability/preflight checks that reject missing executable, unsupported policy, or diversity violation before workspace/pane/agent creation and never install or silently fall back.

## 6. Runtime-neutral Telemetry

- [x] 6.1 Define shared normalized engine/adapter/runtime telemetry envelope and W3C trace propagation keyed by workflow, run, step, role, profile, runtime, message, and effect.
- [x] 6.2 Refactor Pi telemetry into observational bridge with no state-file reads, completion inference, nudges, retries, or provider/runtime switching while preserving available model/tool/cost traces.
- [x] 6.3 Implement OpenCode and OpenCode V2 bridge hook normalization with isolated per-run loading, baseline adapter fallback, bounded content policy, local history, and best-effort OTLP.
- [x] 6.4 Update dashboard telemetry/status views to show runtime/profile and distinguish committed workflow state from adapter/runtime observations.

## 7. Dashboard and Manager Migration

- [x] 7.1 Export one engine-owned workflow view/action type and replace dashboard duplicate phase/state/action maps and raw state assumptions.
- [x] 7.2 Drive all dashboard approvals, review comments, retries, PR, close/clean, and other controls through returned action IDs plus displayed revision, refreshing on conflicts.
- [x] 7.3 Replace phase override UI with engine repair preview/affected-run display, mandatory reason/confirmation, and explicit resume.
- [x] 7.4 Render registry-provided definition/step labels, run outcomes, profile/runtime routing, pending/failed effects, attention diagnostics, and unknown future registered steps.
- [x] 7.5 Update home discovery and focus/return metadata to use canonical store and in-process non-lifecycle updates without writable worktree state mirrors.

## 8. Assets, Configuration, Documentation, and Scripts

- [x] 8.1 Update embedded asset generator/materialization for plain instruction assets plus Pi/OpenCode/OpenCode V2 bridges, and verify instruction assets never enter global skill/plugin discovery.
- [x] 8.2 Update default TOML and examples for named profiles, step/role routes, OpenCode/OpenCode V2 options, adapter policies, and optional runtime-diversity guards.
- [x] 8.3 Update stow/install cleanup to remove stale Herdr workflow skills, avoid globally loading workflow bridges, and keep OpenCode/OpenCode V2 installation detect-only.
- [x] 8.4 Rewrite README and CLI help for registry/step model, canonical store, new commands/view, repair, generic handoff, runtime installation prerequisites, routing examples, telemetry guarantees, and plugin-versus-agent-extension terminology.
- [x] 8.5 Rewrite shell/integration smoke scripts and manager extension paths to new command/action/handoff contracts; remove dead role-specific command and git-skill paths.

## 9. Verification

- [x] 9.1 Add store/dispatcher tests for invalid state/commands, revision races, concurrent parallel handoffs, token/artifact attacks, atomic rollback, outbox crash boundaries, leases, and idempotent retries.
- [x] 9.2 Add migration fixtures for all legacy types/phases, active-agent reissue, equivalent/conflicting mirrors, malformed evidence, closed workflows, and repair-required outcomes.
- [x] 9.3 Add isolated reducer/validator tests for every built-in step/outcome/gate/loop/attempt limit and end-to-end tests for standard, direct-apply, and no-OpenSpec definitions.
- [x] 9.4 Add shared fake-Herdr adapter contract tests plus Pi/OpenCode/OpenCode V2 argument, prompt, policy, executable, capability, status, stop, and telemetry bridge tests.
- [x] 9.5 Add dashboard tests for generated actions, stale revision, generic future step rendering, repair flow, runtime routing, effect attention, and observation/state separation.
- [x] 9.6 Run focused checks permitted by worker assignment and document frozen install, full Bun suite, type-check, compiled build, shell smoke, strict OpenSpec validation, and opt-in live runtime smoke commands for downstream verifiers; do not run verifier-owned repository-wide gates during implementation.

## Context

The first live installer-space-mw attempt admitted a Docker build and a Mocked Compose run but dispatched neither. PostgreSQL already runs as service `postgres` in the old `document-service-mocked` project, publishing 5433 and attached to `document-service-mocked_devenv-local`. Its data volume belongs to that installation. The v2 captured Mocked target embeds another postgres service with the same name/port, so matching the target catalog alone cannot reproduce v1 behavior.

Reference modules:
- `agentic-coding/src/server/environment-stack.ts`: one composition of environment runtime/integration services, independent of the agent transcript.
- `agentic-coding/src/agent-host/environment-tools.ts`: owner-scoped build/test/start/status/log/stop calls, target/profile selection and bounded waits.
- `agentic-coding/src/server/actions/target-compile.ts`: dependency identity, default `shared`, `external` readiness-only and execution-key deduplication.
- `agentic-coding/src/server/actions/coordinator.ts`: already-ready external observations versus current executions/claims.
- `agentic-coding/src/server/runtime/leases.ts`: only `owned` dependencies create cleanup leases; shared/external dependencies confer no cleanup ownership. V1 also adopts durable owned leases after restart; that is a distinct policy, not required merely to reuse existing shared services.

## Goals / Non-Goals

**Goals:** Match v1's useful environment behavior through MCP; resolve the user's Mocked preset without duplicating or stopping existing PostgreSQL; keep dependency/network/readiness logic inside a single environment authority; preserve bounded diagnostics, scope isolation and exact human approval.

**Non-Goals:** Replace OpenCode, auto-import v1 state/credentials, grant agents operator authority, blindly adopt containers by name, reproduce unsafe behavior for compatibility, or certify every runtime through one live application. The original controller's conservative owned-handle recovery remains unchanged.

## Decisions

### Reference behavior, not a second CLI workflow

Create a source-backed behavioral matrix before extending adapters. The user has selected a fresh `environment-mcp/` package, not an in-process adapter to either existing application. Copy/adapt the smallest required v1/v2 domain rules and runtime adapters into package-local modules, recording their origins; do not import old source, alias old packages, initialize a coding-agent host or proxy to an old host. Environment owners/scopes use environment-native records, not fake coding tasks. Missing behavior must be explicit, not relabeled parity.

The user subsequently required that the configuration structure stay identical
to v2. The standalone package now consumes `CONFIG_DIR/environments.json` plus
`config.json` directly and normalizes that data internally; the earlier bespoke
manifest survives only as an explicit package-fixture/inspection format. V2
target descriptors map to the same execution model (shell command, Docker build
with Dockerfile/build-secret templates, Compose file/source). The only additive
section is `serviceBindings`, which supplies explicit borrowed Docker identity
for targets that declare `requires`; it does not change any v2 app/target shape
and is never inferred from a container name. Secrets use the v2 UI mechanism:
`CONFIG_DIR/.env` parsed once, process fallback, declared references only.

### Independent server standard and incremental cutover
The new package owns its scripts, lockfile, TypeScript/Biome gates, tests, build and official MCP SDK dependency. Start with a strict versioned configuration for explicit repositories, applications, targets and shared/external/owned dependencies. Compatibility inspection of v2 definitions is a separately selected read-only reader; successfully listing them does not grant execution validity or import native state. Credentials remain references. Only implemented tools are advertised. Add new operator and shared-controller transports within this package before enabling mutations; catalog stdio must never grow into competing per-client execution authorities.

Keep the old OpenCode entries and both existing source trees intact during construction. A standalone artifact must run with a fixture after copying only its built output outside the checkout. The first package milestone intentionally provides inspection/policy only and is not the final build/start migration. Existing controller startup-limit fix was separately verified (289 tests, 0 failures, 16.17s; both packages lint/type gates clean) and is not evidence that the new package executes live apps.

### Borrowed observations are different from owned handles

Represent configured shared/external prerequisites as observed bindings, including runtime identity, endpoint/network identity, readiness policy and intended use. A matching name/occupied port alone is insufficient. Shared dependencies can be started when absent under an approved plan; external dependencies are readiness-only. Already-ready shared dependencies are reused without a create/start action. Track whether an operation actually created a resource separately from whether an app references it. Borrowing never grants stop/remove/reconfigure/credential-query authority.

### Networking belongs in the approved plan

Reusing PostgreSQL also requires the app to reach it. Resolve exact network and service alias/endpoints before dispatch. Prefer creating the new application on an explicitly approved compatible existing network without modifying the borrowed service. Any network attachment mutation, credential reference change or plan change requires a new disclosed approval; do not strip a Compose service and assume DNS will work. Reject ambiguous identity/reachability with an actionable diagnostic, never silently create another database.

### Keep authority and issuance fences

The transport fixes owner/workspace; model arguments cannot declare an arbitrary resource shared or select an operator marker. Configuration and authenticated review define borrowable identities. Freeze normalized selection and observed bindings for review, revalidate before dependent startup and diagnostics, and refuse substitution or uncertain observations. A fresh read-only observation after restart does not revive prior mutation permits, cleanup handles or database credentials. A stopped/replaced borrowed resource must surface as unavailable, not be recreated silently.

### The acceptance case is observable

Through OpenCode MCP, build installer-space-mw and start Mocked using the existing PostgreSQL, inspect startup logs and application readiness, and stop only resources created/owned for this request. Preserve the PostgreSQL identity/state/data and other apps. Do not report `running` as verified application readiness. The current two pending plans are not valid approval for changed shared-resource behavior and must be superseded, not edited/rearmed.

## Risks / Trade-offs

- [V1 service reuse pulls in host/state dependencies] → inspect the adapter seam first; do not instantiate another coding harness or competing authority.
- [Same name but incompatible database/network] → explicit identity/readiness/network checks, no fallback on inspection failure.
- [Shared service interrupted by app cleanup] → borrowed bindings cannot enter owned cleanup lists; test through the public controller boundary.
- [Live build uses configured repository credentials and downloads] → retain referenced secrets and exact human approval; no values in plans/results.
- [Compatibility expands scope indefinitely] → matrix distinguishes implemented, intentionally different and deferred surfaces. Preserve native test budgets; use pure policy tables and one representative boundary scenario.

## Migration Plan

Leave the existing PostgreSQL and v1 durable state untouched. Develop/verify the shared dependency path with disposable fakes first; stage any real definition conversion for operator review. Supersede the current pending installer-space plans, approve the new exact plans, then run only the user-requested live validation. Rollback closes only newly owned app resources and removes only new configuration bindings; it must not stop shared PostgreSQL or delete its volume.

## Open Questions

Resolved reference/seam questions are recorded in `environment-mcp/docs/architecture.md`.
V1 Mocked includes shared infrastructure templates, but those templates do not
declare an external network for borrowing the existing document-service project's
PostgreSQL. The standalone server therefore uses explicit configured image/label/
network/alias/readiness bindings rather than inferring authority from an occupied
name/port. Pure rules and observation adapters are the package-local extraction
boundary, not the v1 workflow-integrated composition root.

The requested naming refactor places MCP registration in `src/mcp/`, service
orchestration in `src/services/`, trusted schemas/readers in `src/configuration/`,
legacy metadata import in `src/compatibility/`, pure rules/ports in `src/domain/`
and concrete I/O in `src/adapters/`. Package identity is `environment-mcp`.
Existing CLI/tool wire names and outputs were verified unchanged before the
separate binding implementation increment.

Read-only Docker observation and host-bound immutable dependency preparation/
revalidation are implemented; they do not complete the exact human approval or
durable issuance requirements. Those remain the next controller boundary before
any build/start/stop tools can be exposed. First bindings deliberately support
Docker only; other runtime bindings must be implemented explicitly, never guessed
through a fallback adapter.

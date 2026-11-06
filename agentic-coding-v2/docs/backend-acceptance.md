# Backend migration acceptance checkpoint

This is the current open-work index. `environment-parity.md` is chronological evidence: its early tables and historical “next” notes are not a current completion checklist. No score, subset or fake-backed fixture proves full legacy or live parity. Backend completion precedes adapting the existing TUI; do not expand the web UI or change the general UI/pi-durable session contract.

## Current supported boundaries

- Native task ownership, exact-plan approvals, atomic acquisition, cancellation/cleanup barriers and uncertain-resource quarantine; no saved process/container/Pod adoption.
- POSIX shell, owned Docker/Podman, strict Compose subset and explicit existing-cluster bare Pods. Provider-time container/Compose and single-pod logs; single-replica loopback forwards.
- Retained live waits preserve position across bounded calls. Restart marks history interrupted. Explicit recovery requires fresh current-plan approval and a new acquisition, never an old ordinal or execution authority.
- Held-shell HTTP/HTTPS and PostgreSQL; PostgreSQL admission also supports owned health-ready Docker/Podman infrastructure with an exact published loopback binding.
- Private revision-fenced JSON/Compose/auxiliary staging, bounded literal env_file resolution from exact staged bytes, candidate/tree digests, explicit retention/reuse/release, and configuration-only promotion. Source roles/path collisions are fenced. Nested auxiliary retain/reuse/reopen/release has public coverage.
- Read-only discovery at the root or one explicit nested public directory, inside the authorized checkout or captured native workspace. No recursive enumeration or automatic project selection.

## Open acceptance work

| Area | Remaining acceptance boundary |
| --- | --- |
| Durable tree effects — partial milestone complete | A committed assembly intent now precedes materialization/move and binds exact request, revision/content/tree identity, prior ownership and temporary name. SIGKILL after rename is covered for first-tree creation and supersession; pending attempts block replay, acknowledgement grants no effects, and orphan release precedes a fresh successful request. Write interruption now has SIGKILL coverage and an explicit acknowledged-intent/revision/metadata-fingerprint-fenced temporary removal route. No automatic sweep, replay or adoption. Namespace-race-safe deletion, arbitrary mutation and crash-during-temporary-deletion guarantees are not established. |
| Definition authoring/promotion | Config-layout/profile editing, custom discovery and automatic workspace/nested discovery; separately approved real-path/runtime validation; stronger namespace/path conflict fences and exact approved publication. Current promotion writes only configuration, not staged repository/source files, and does not reload running apps. Model-authorized draft writes remain unsupported. |
| Dependency/lifetime parity | Shared/external resource semantics, last-reference cleanup, broader independent/shared lifetimes and held-wait cycle behavior beyond atomic no-hold-and-wait admission. Do not equate generation-bound diagnostic requirement graphs with live managed references. |
| Runtime coverage | Windows/PowerShell; remaining Compose compatibility/shared Podman networks; Kubernetes Helm/full app definitions, broader probes, multi-replica diagnostics/forwards and explicit cluster lifecycle/image/secret operations. Unsupported effects remain refused. |
| HTTP/endpoints | Broader container/Compose/Kubernetes endpoint binding, broader credential schemes and retained-history lookup/pagination. No automatic port/DNS/credential injection is implied. |
| SQL | MySQL; Compose/Kubernetes/shared/external bindings; production driver/authentication/network validation. PGlite protocol fixtures are not production authentication or actual container networking proof. |
| Diagnostics/status | Broader telemetry transports/runtimes, full trace trees, backend/provider history and pagination, remaining lifecycle/status parity. |
| Crash recovery | Full creation/effect reconciliation without adoption; retained-tree intent gap above is separate from runtime quarantine. Acknowledging a cleanup blocker does not certify deletion or authorize effect replay. |
| Verification | Legacy full-suite baseline/TEST-005 remains unresolved. Investigate intermittent diagnostic-history polling, container cleanup observation and previously observed type-check stalls. Refresh CLI/quality/legacy gates at milestones. Live engine/cluster/production database checks require explicit authorization; do not run them implicitly. |
| TUI — deferred | After backend acceptance, adapt the existing TUI to supported native capabilities while preserving general UI and pi-durable sessions. No web UI expansion. |

## Next retained-tree implementation boundary

`drafts.ts` now commits assembly admission before invoking filesystem materialization. The intent uses existing bounded, revision-fenced cleanup-attempt history/acknowledgement with kind `assemble`. It records the exact request, draft revision/content/tree identities, prior retained name and deterministic exclusive temporary name. Completion retires the assembly marker in the transaction recording the result or beginning supersession deletion. Historical completed requests replay reports; pending or acknowledged attempts never replay effects under the original identity.

Disposable authenticated API scenarios kill the host after rename and before completion for both first creation and supersession. Reopen discloses a pending assembly intent; old and fresh requests are blocked, acknowledgement changes no files and does not permit the old request, explicit digest release removes only the orphan, and a distinct request can then succeed. Previous ownership is preserved. These fixtures inject the kill at the filesystem boundary, not a production failpoint.

Temporary-write interruption is now covered. Retained metadata exposes bounded observations for each assembly intent's temporary name: present with metadata fingerprint/count, absent, or unavailable. `POST /api/environments/drafts/tree/temporary-release` requires requestId, exact acknowledged assembly id/revision, current fingerprint and `remove: true`. It commits a separate deletion intent before dispatch, re-observes before deletion, and records a data-only completion receipt. Replacements/symlinks/stale fingerprints fail closed; completed replay never removes a later occupant. No unknown directory sweep, content import, ownership adoption or execution recovery occurs. Fingerprints detect ordinary metadata/identity changes, not arbitrary same-metadata rewrites or OS namespace races. A dedicated deletion-interruption scenario remains unproved.

Next recommended capability milestone: owned-container HTTP endpoint binding, retaining exact health/published-loopback-port and frozen-credential ownership fences. Crash/path race limitations remain tracked rather than described as complete reconciliation.

## Verification at this checkpoint

- Latest native full suite: **126 tests / 1705 assertions / 43 files**, passing. Prior checkpoint final repeat **123 tests / 1656 assertions**, passing. Initial refresh: **122 pass / 1 fail**, with the container missing/unhealthy-health scenario observing `unknown` instead of `absent` at cleanup. Focused rerun passed unchanged (12 assertions); full repeat passed unchanged. Cause remains unexplained, not fixed.
- Biome: **157 files**, zero diagnostics; whole native type-check and build pass. Compiled bundle `--help` passes.
- Legacy boundaries: **71 tests / 278 assertions**, passing; whole legacy type-check passes. This is not a full legacy-suite baseline.
- Desloppify: overall **20.7**, objective/verified **82.8**, strict **19.8**. Subjective dimensions remain unassessed. Exclusions remain only `node_modules`, `dist`, `.desloppify`; no score-driven helper tests or subjective assessments were added.
- No model calls, live providers, credentials, deployment, app restart, UI changes or generated legacy edits.

## Increment reporting contract

After every increment report: (1) commit and actual behavior changed, (2) checks and failures/limitations, (3) remaining major backend areas, and (4) the recommended next milestone. Keep closed fixture gaps distinct from unresolved live compatibility and restart/race guarantees.

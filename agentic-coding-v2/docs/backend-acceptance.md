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
| Durable tree effects — next safety milestone | Commit a creation/retention intent **before** filesystem materialization/move. Bind exact request, draft revision/content/tree identities and previous ownership. Interrupted intent must remain inspectable and block unsafe automatic retries/adoption; explicit recovery must retain evidence. Prove interruption through a public disposable-host boundary, including the first-tree and supersession cases. Existing post-assembly deletion markers do not close this window. |
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

Current `drafts.ts` invokes `assembleStagedTree` inside the preflight transaction, then records ownership or a supersession cleanup intent. `assembleStagedTree` creates a temporary directory and may rename it into `trees/<digest>` before the transaction commits. A host interruption can therefore leave a directory with no durable creation intent. Existing unowned-tree refusal and explicit digest release are useful fail-closed behavior, not full reconciliation.

Split intent admission, filesystem effects and completion into separately fenced phases. Persist authority before effects; do not infer it from a directory name or matching bytes. Preserve existing exact-request replay and cross-draft ownership fences. A restart must disclose interruption, not execute saved work. Determine bounded recovery semantics before implementing automatic cleanup, and do not sweep unknown `tree-*` directories or clear quarantine by appearance.

## Verification at this checkpoint

- Native full suite: final repeat **123 tests / 1656 assertions**, passing. Initial refresh: **122 pass / 1 fail**, with the container missing/unhealthy-health scenario observing `unknown` instead of `absent` at cleanup. Focused rerun passed unchanged (12 assertions); full repeat passed unchanged. Cause remains unexplained, not fixed.
- Biome: **154 files**, zero diagnostics; whole native type-check and build pass. Compiled bundle `--help` passes.
- Legacy boundaries: **71 tests / 278 assertions**, passing; whole legacy type-check passes. This is not a full legacy-suite baseline.
- Desloppify: overall **20.7**, objective/verified **82.9**, strict **19.9**. Subjective dimensions remain unassessed. Exclusions remain only `node_modules`, `dist`, `.desloppify`; no score-driven helper tests or subjective assessments were added.
- No model calls, live providers, credentials, deployment, app restart, UI changes or generated legacy edits.

## Increment reporting contract

After every increment report: (1) commit and actual behavior changed, (2) checks and failures/limitations, (3) remaining major backend areas, and (4) the recommended next milestone. Keep closed fixture gaps distinct from unresolved live compatibility and restart/race guarantees.

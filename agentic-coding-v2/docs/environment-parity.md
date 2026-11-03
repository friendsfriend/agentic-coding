# Environment parity ledger

Reference: the previous host's `docs/agent-environments.md`, `docs/environment-runtime-port.md`, `docs/devenv/cross-runtime-endpoints.md`, agent environment tools, action/default-target resolver, runtime owners and dependency leases. This is a capability ledger, not a claim that implementation or fixture success proves live-runtime parity.

The v2 implementation remains independent. No legacy runtime imports, storage adoption, production deployment, automatic host restart, container takeover, saved-PID cleanup, workflow graph or evidence subsystem is authorized by this work. Task ownership replaces workflow ownership. Profiles remain model selection, not permission.

| Capability | Acceptance / verification | Status |
| --- | --- | --- |
| App/library definitions and repository authorization | Strict schema; app/library distinction; no imported runtime state | Shell/Docker/Podman definitions implemented; remaining runtime schemas pending |
| Run/build/test selection | Profile/runtime filtering, declared defaults, Docker preference, ambiguous build/test refusal, explicit Kubernetes opt-in | Implemented for shell/Docker/Podman with conservative metadata eligibility; Kubernetes and active runtime discovery pending |
| Shell/system-shell programs | Exact approval, confined cwd, allowlisted env, exit codes, process-group cleanup | POSIX shell implemented |
| Windows/PowerShell execution | Explicit runner, argv, cancellation and ownership-equivalent cleanup | Pending |
| Docker/Podman containers | Structured status, health, ports, logs; lifecycle only with checked ownership | Implemented with explicit local Unix sockets; executable fixtures pass, live engine smoke unverified |
| Compose | Config-relative files, task checkout, static project/ports, ownership labels, no foreign resource mutation | Pending |
| Container image builds/tests | Dockerfile/context/args, actual exit results, no implicit publish | Implemented with conservative daemon-global image writer serialization (including cross-client/short-name aliases) and uncertain-writer quarantine; executable fixtures pass, live engine smoke unverified |
| Kubernetes apps | Explicit existing local cluster/context, Helm values/replicas, managed port forwards, guarded uninstall | Pending |
| Cluster operations | Explicit operator-approved create/delete/recreate/status/image/secret operations, never implicit in app start | Pending |
| App slots | Atomic multi-app grant; owner fences; queued wait, cancellation, no partial acquisition | Implemented; queue compatibility pending |
| Wait continuation/deadlock | Stable queue position across bounded waits, independent-app progress, repeated holder start, cycle refusal | Independent-app progress and atomic no-hold-and-wait admission implemented; bounded-wait continuation and repeated-holder receipts pending |
| Operator-held runs and force release | Authenticated developer actions; no automatic adoption of external runs; revoked waiters cannot restart | Pending |
| Idle lifecycle | Agent-only TTL; waiting/unknown/operator owners protected | Pending |
| Infrastructure | Docker/script/Kubernetes definitions, readiness and source-bounded redacted logs | Pending |
| Dependency leases | Shared/external/owned semantics, durable references, start once, stop only last owned reference, failure rollback | Pending |
| Endpoint export/binding | Host/Compose/Kubernetes address strategies; no cross-provider DNS; publish only after readiness | Pending |
| HTTP requests | Held-app authority, same-origin redirects, bounded redacted data, explicit write permission | Pending |
| SQL diagnostics | Held dependency authority, PostgreSQL/MySQL read-only transaction, statement timeout, source row bound, rollback | Pending |
| Application telemetry | Owned-run attribution, bounded OTLP traces/logs, filters/span trees, honest unavailable/evicted distinctions | Pending |
| Logs | App/infra/service filters, timestamp and literal substring, bounded tails at source, runtime framing | Shell/container bounded redacted capture and private machine observations implemented; infra/service/filter parity pending |
| Status/dashboard | Targets/default reasons, owners/queues, startup vs health vs exit, logs, authenticated cleanup | Shell/container status and default reasons implemented; operator controls and remaining runtimes pending |
| Definition discovery/authoring | Config layout, profiles and symlinks, example config, staged drafts, validation and revision/content-fenced promotion | Pending |
| Runtime failure/restart | No blind effect replay; unknown occupancy blocks grants; authenticated inspection release with audit receipt | Shell/container receipts quarantine unknown effects. No PID/ID/label adoption; changed ownership and daemon loss fixture-tested. Container abrupt-host crash integration pending |

## Verified checkpoint

Native task scenarios use disposable repositories/state, faux model responses, executable Docker/Podman substitutes and an isolated in-test Unix-socket engine. They exercise approval-before-effects, provider/profile defaults, foreign stop refusal, exact live creation IDs (including replacement with copied labels), unknown daemon occupancy, missing/unhealthy readiness, actual build/test exits, private stdout/stderr metadata, cancellation barriers and daemon-global image writer quarantine across client families, aliases and workspaces. The shell queue scenario also verifies that an unrelated app can pass a blocked conflicting batch without stealing its FIFO priority. Availability checks use only executable/socket filesystem metadata, never CLI invocation, daemon probes or secret resolution. Known-unavailable targets are excluded from implicit fallback; a broken declared default still fails rather than silently selecting another target. Native scenarios also verify newline-free raw shell readiness and that redacted log presentation cannot invent a marker. A SIGKILL/reopen container scenario verifies persisted diagnostic IDs (reset to unknown ownership/health), zero engine invocations during restart/cancellation, quarantined resources and authenticated revision-bound inspection release. Its orphaned log client is bounded to the disposable fixture engine.

An isolated authenticated browser smoke with fixture-only status/log data verified target eligibility/default text, health updates, retained log DOM nodes, unsent chat drafts/focus and no console errors. This was not a live-engine smoke. No live container engine, existing app, credential, cluster or host service was operated on.

## Completion rule

Do not label full parity achieved while a row is pending or verification is unavailable. CLI fixtures must exercise real native task/tool approval, executable argv, structured observations, ownership refusal and cleanup; they do not count as Docker/Podman/kind integration smoke. Disposable live-runtime smoke must use only newly created, uniquely labelled resources, be explicitly opted into, and report unavailable runtimes as unverified, never passed. Keep the small behavioral suite rather than adding per-helper tests to inflate coverage.

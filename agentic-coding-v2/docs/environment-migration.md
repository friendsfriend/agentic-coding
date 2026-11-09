# Native environment migration toward v1 parity

## Scope and acceptance

The developer requested full environment parity for the existing v1 configuration, not empty app entries or shell wrappers around `docker compose`. The inventory is the user's `CONFIG_DIR/migration-report.json`; it is machine-local data, not checked into this repository. The initial migration contains 25 applications, 9 libraries, and six enabled targets. Forty-one explicit source entries remain blocked, including a broken v1 Dockerfile symlink. Automatically discovered repository targets are additional scope, not included in that count.

Full parity requires preserving profiles/defaults, build inputs, dependencies and readiness, service-specific environments and credentials, network reachability, persistence and lifecycle, run/build/test results, diagnostics, and usable configuration migration. Every item must be backed by public-boundary evidence. Parsing a document alone is not functional parity. Actual existing apps, real providers/models, credentials, clusters and engine workloads are not acceptance fixtures and must not be started or restarted without separate authorization.

## Implementation sequence

1. **Service-level execution configuration (implemented).** Native Compose source accepts `x-secret-refs`, `shm_size`, `extra_hosts` and bounded exec-form health probes. All service references resolve before any engine effects, freeze for the run and stay scoped to the declaring service. Stack-wide longest-first redaction protects logs, including overlapping sibling secrets. Native container creation receives the approved shared-memory bytes and host mappings. Invalid references, literal/reference collisions, invalid hosts and oversized memory fail closed. No existing source is automatically rewritten.
2. **Persistent resources (not implemented).** Add native named-volume declarations with explicit lifetime/persistence and resource identity. Creation, attachment, detach, retention, name collision, interrupted create and cleanup failure must be receipt-fenced. Never adopt or remove v1/external volumes by name/labels, silently substitute temporary storage, or delete database data at task completion. Persistence needs durable identity/reopen behavior and a separate explicit data-transfer operation if existing v1 database contents are to be carried over.
3. **Restart lifecycle (not implemented).** Represent restart policies in approval and native observation. A restarting container is not an exited owner; cancellation still drains/stops only the original receipt-fenced generation. Handle exhaustion, host shutdown/reopen and uncertain mutations without phantom lease release. Do not simply pass `--restart always` while retaining the current one-creation/no-restart assumptions.
4. **Shared infrastructure and application prerequisites (not implemented).** Extend the repository-bound infrastructure model deliberately to support global services and the frontend/backend cross-repository dependency. Keep exact repository/owner authorization, atomic acquisition, collision detection, independent task workspaces, prerequisite readiness, reference-counted release and diagnostic leases. No attaching to a legacy network or an unrelated workflow's running app.
5. **Configuration-owned sources and build contexts (not implemented).** Capture immutable source bundles from config, bind all includes/templates/scripts to approval, and materialize safe task-local build inputs without requiring untracked files in each checkout. Preserve existing checkout changes. Implement credential-reference templates and safe build-secret transport without storing credential bytes in configuration, approval, transcript or image layers. Refuse missing inputs rather than guessing. Account for v1's broken Dockerfile symlink and repository-specific missing `.npmrc`/template inputs.
6. **Compose conversion and target discovery (not implemented).** Convert existing includes, short-form ports/commands/environment arrays, profiles and defaults into the native model; service names remain network aliases, not adoption authority. Support bounded, explicit environment interpolation by reference without evaluating shell source. Preserve daemon socket selection, endpoint/query declarations and telemetry encoding/attribution. Discover only supported repository build/test commands as inert candidates; never execute discovery automatically.
7. **Finish migration (not implemented).** Preview every source and diagnostic, apply only the exact validated bundle, preserve references instead of copying secrets, refuse overwrite/stale inputs, and allow idempotent retry/rollback. Update the machine-local inventory only after each target is actually supported. A full migration must report no unresolved target except a specific missing/invalid user input; empty app entries are not success.

## Implemented service schema

```yaml
services:
  web:
    image: example:local
    x-secret-refs:
      APPLICATION_PASSWORD: APPLICATION_PASSWORD_ENV
    shm_size: 512m
    extra_hosts:
      host.docker.internal: host-gateway
    healthcheck:
      test: [CMD, probe, --ready]
```

References resolve from `CONFIG_DIR/.env` or the launching process, just like target `secretRefs`. The extension is intentionally explicit: arbitrary `${...}` interpolation remains refused. Service references cannot be overridden by service literals or conflicting target mappings. Target-wide references retain their existing semantics; only service-specific references gain isolation. HTTP/query credential bindings remain target-level, not a new service diagnostic authentication API.

`shm_size` accepts integer bytes or integral b/k/m/g strings, at most 8 GiB. Container definitions expose `shmSize` in bytes and `extraHosts` as a hostname-to-IP/`host-gateway` map. Exec health probes are translated to `exec` with individually POSIX-quoted words, not concatenated shell source; argument substitution and metacharacters remain literal. Existing string and CMD-SHELL probes retain their explicit shell semantics. Disable-plus-health settings still fail closed.

## Evidence and limits

`test/compose-diagnostics.test.ts` exercises native public task tools against a disposable synthetic engine: exact approval snapshots contain reference names but no values, service-only `--env` bindings, shared-memory/host/probe argv, missing-later-service refusal before network creation, and cancellation after credential-file removal. Existing credential rotation, diagnostic ownership, network replacement and SQL lifecycle tests remain applicable. `test/compose-subset-fences.test.ts` exercises authenticated staging/check/candidate/materialization refusal for unsupported or malformed inputs. No renderer/helper/unit-parser tests are used as execution evidence.

This first implementation does **not** make the 41 blocked definitions runnable, migrate volumes/data, change the live user configuration, or establish real Docker/Podman/Windows parity. The remaining steps above are implementation work, not authorization already granted to execute those environments.
